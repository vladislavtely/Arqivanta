import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { comparePaths, isJavaScriptOrTypeScript, isPythonSource } from '@arqivanta/shared';
import type { Diagnostic, SourceFile } from '@arqivanta/shared';
import ignore, { type Ignore } from 'ignore';

const fileLimit = 10_000;
const entryLimit = 100_000;
const depthLimit = 32;
const fileBytesLimit = 384 * 1024;
const totalBytesLimit = 32 * 1024 * 1024;
const ignoreBytesLimit = 64 * 1024;
const diagnosticLimit = 200;
const readBatchSize = 12;

const skippedDirectories = new Set([
  '.agents',
  '.aws',
  '.azure',
  '.cache',
  '.codex',
  '.git',
  '.gnupg',
  '.hg',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.output',
  '.private',
  '.pytest_cache',
  '.ruff_cache',
  '.secrets',
  '.ssh',
  '.svn',
  '.turbo',
  '.venv',
  '__pycache__',
  '__pypackages__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'site-packages',
  'venv',
]);
const secretName =
  /^(?:\.env(?:[._-]|$)|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|\.htpasswd$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|(?:credentials?|secrets?|service[-_]?account|application_default_credentials)(?:[.\-_]|$))|\.(?:pem|key|p12|pfx|jks|keystore)$|^\.DS_Store$/i;
const configName = /^(?:(?:(?:tsconfig|jsconfig)(?:\.[\w.-]+)?|package)\.json|pyproject\.toml)$/i;
const metadataName =
  /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY|AGENTS)(?:\.(?:md|txt))?$/i;

export function isGitSnapshotCandidate(relative: string) {
  const segments = relative.split('/');
  const name = segments.pop() ?? '';
  return (
    !secretName.test(name) &&
    segments.every(
      (part) => !skippedDirectories.has(part.toLowerCase()) && !secretName.test(part),
    ) &&
    (name === '.gitignore' ||
      isJavaScriptOrTypeScript(name) ||
      isPythonSource(name) ||
      configName.test(name) ||
      metadataName.test(name))
  );
}

type RuleSet = { directory: string; rules: Ignore };
type Candidate = { absolute: string; relative: string };
const utf8 = new TextDecoder('utf-8', { fatal: true });

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function matchesPath(root: string, absolute: string) {
  const canonical = await realpath(absolute);
  return isInside(root, canonical) && path.relative(absolute, canonical) === '';
}

async function readBounded(root: string, absolute: string, limit: number) {
  const before = await lstat(absolute);
  if (!before.isFile() || before.nlink !== 1 || !(await matchesPath(root, absolute))) return;
  if (before.size > limit) return { kind: 'tooLarge' } as const;

  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      !(await matchesPath(root, absolute))
    )
      return;
    if (current.size > limit) return { kind: 'tooLarge' } as const;

    const buffer = Buffer.allocUnsafe(Math.min(limit + 1, current.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > limit) return { kind: 'tooLarge' } as const;
    if (bytes > current.size) return;

    const content = buffer.subarray(0, bytes);
    if (content.includes(0)) return;
    try {
      return {
        kind: 'text',
        source: utf8.decode(content),
        bytes,
      } as const;
    } catch {
      return;
    }
  } finally {
    await handle.close();
  }
}

function isIgnored(ruleSets: RuleSet[], relative: string, directory: boolean) {
  let ignored = false;
  for (const { directory: parent, rules } of ruleSets) {
    const local = parent ? relative.slice(parent.length + 1) : relative;
    const result = rules.test(directory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function isMissing(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function discoverRepository(
  selectedRoot: string,
  checkDeadline: () => void,
  report: (diagnostic: Diagnostic) => void,
) {
  if (!path.isAbsolute(selectedRoot)) throw new Error('Select an absolute repository folder.');
  const selected = await lstat(selectedRoot);
  if (!selected.isDirectory() || selected.isSymbolicLink())
    throw new Error('Select a regular repository folder.');
  const root = await realpath(selectedRoot);
  const files: SourceFile[] = [];
  let entries = 0;
  let bytes = 0;
  let diagnostics = 0;
  let limitReached = false;

  function warn(message: string, filePath?: string) {
    if (diagnostics < diagnosticLimit) report({ severity: 'warning', message, path: filePath });
    if (diagnostics === diagnosticLimit)
      report({ severity: 'warning', message: 'Additional discovery warnings were omitted.' });
    diagnostics++;
  }

  async function readBatch(pending: Candidate[]) {
    if (!pending.length) return;
    const limit = Math.min(fileBytesLimit, totalBytesLimit - bytes);
    const reads = await Promise.allSettled(
      pending.map(({ absolute }) => readBounded(root, absolute, limit)),
    );

    // Apply limits and report diagnostics in path order, regardless of completion order.
    for (const [index, { relative }] of pending.entries()) {
      checkDeadline();
      if (files.length >= fileLimit || bytes >= totalBytesLimit) {
        warn(
          'Repository source limit reached. Results cover the portion scanned before the limit.',
        );
        limitReached = true;
        break;
      }
      const read = reads[index];
      if (read.status === 'rejected') {
        warn('File could not be read.', relative);
        continue;
      }
      const contents = read.value;
      if (!contents) {
        warn('A non-regular, changed, or non-UTF-8 file was skipped.', relative);
        continue;
      }
      if (contents.kind === 'tooLarge' || contents.bytes > totalBytesLimit - bytes) {
        warn('File exceeds the remaining per-file or repository source limit.', relative);
        continue;
      }
      files.push({ path: relative, source: contents.source, bytes: contents.bytes });
      bytes += contents.bytes;
    }
    pending.length = 0;
  }

  async function visit(
    directory: string,
    relativeDirectory: string,
    parentRules: RuleSet[],
    depth: number,
  ) {
    checkDeadline();
    try {
      if (!(await matchesPath(root, directory))) return;
    } catch (error) {
      if (depth === 0) throw error;
      warn('Directory could not be accessed.', relativeDirectory);
      return;
    }

    let ruleSets = parentRules;
    try {
      const contents = await readBounded(
        root,
        path.join(directory, '.gitignore'),
        ignoreBytesLimit,
      );
      if (contents?.kind === 'text') {
        ruleSets = [
          ...parentRules,
          { directory: relativeDirectory, rules: ignore().add(contents.source) },
        ];
      } else {
        warn(
          'An unreadable or oversized .gitignore caused this directory to be skipped.',
          relativeDirectory || undefined,
        );
        return;
      }
    } catch (error) {
      if (!isMissing(error)) {
        warn(
          'An unreadable .gitignore caused this directory to be skipped.',
          relativeDirectory || undefined,
        );
        return;
      }
    }

    const children: { name: string; directory: boolean }[] = [];
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        checkDeadline();
        if (!entry.isDirectory() && !entry.isFile()) {
          if (++entries >= entryLimit) break;
          continue;
        }
        if (++entries >= entryLimit) break;
        children.push({ name: entry.name, directory: entry.isDirectory() });
      }
    } catch (error) {
      checkDeadline();
      if (depth === 0) throw error;
      warn('Directory could not be listed.', relativeDirectory);
      return;
    }
    if (entries >= entryLimit) {
      warn('Directory entry limit reached. Results cover the portion scanned before the limit.');
      limitReached = true;
      return;
    }

    const pending: Candidate[] = [];
    children.sort((a, b) => comparePaths(a.name, b.name));
    for (const child of children) {
      checkDeadline();
      if (limitReached) return;
      const { name } = child;
      if (name.includes('\\') || name.includes(':') || secretName.test(name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(directory, name);

      if (child.directory) {
        if (skippedDirectories.has(name.toLowerCase()) || isIgnored(ruleSets, relative, true))
          continue;
        await readBatch(pending);
        if (limitReached) return;
        if (depth >= depthLimit) {
          warn('Directory nesting limit reached.', relative);
          continue;
        }
        await visit(absolute, relative, ruleSets, depth + 1);
        continue;
      }
      if (
        !isJavaScriptOrTypeScript(name) &&
        !isPythonSource(name) &&
        !configName.test(name) &&
        !metadataName.test(name)
      )
        continue;
      if (isIgnored(ruleSets, relative, false)) continue;
      pending.push({ absolute, relative });
      if (pending.length === readBatchSize) await readBatch(pending);
    }
    await readBatch(pending);
  }

  const rootRules: RuleSet[] = [];
  try {
    const gitDirectory = path.join(root, '.git');
    if ((await lstat(gitDirectory)).isDirectory()) {
      const excludes = await readBounded(
        root,
        path.join(gitDirectory, 'info', 'exclude'),
        ignoreBytesLimit,
      );
      if (excludes?.kind === 'text') {
        rootRules.push({ directory: '', rules: ignore().add(excludes.source) });
      } else {
        warn('An unreadable or oversized Git exclude file caused this repository to be skipped.');
        return files;
      }
    }
  } catch (error) {
    if (!isMissing(error)) {
      warn('An unreadable Git exclude file caused this repository to be skipped.');
      return files;
    }
  }
  await visit(root, '', rootRules, 0);
  return files.sort((a, b) => comparePaths(a.path, b.path));
}
