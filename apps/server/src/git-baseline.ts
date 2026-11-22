import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isGitSnapshotCandidate } from '@arqivanta/analyzer';

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const unsafe = /[<>:"\\|?*\p{Cc}]/u;
const device = /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ ]*(?:\.|$)/iu;
const maxBlobBytes = 384 * 1024;
const maxSourceBytes = 32 * 1024 * 1024;
const maxFiles = 10_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class GitBaselineError extends Error {}

async function locateGit(root: string) {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  const search = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  for (const directory of search?.split(delimiter) ?? []) {
    if (!isAbsolute(directory)) continue;
    const executable = await realpath(join(directory, name)).catch(() => undefined);
    if (!executable) continue;
    const fromRoot = relative(root, executable);
    if (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)) continue;
    if (
      await access(executable, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return executable;
  }
  throw new GitBaselineError('Install Git and add it to PATH to compare with HEAD.');
}

function gitReader(executable: string, root: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^git_/iu.test(key)),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? '/dev/null' : devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    LC_ALL: 'C',
  });
  return (args: string[], maxBuffer: number, input?: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        executable,
        ['--no-optional-locks', '--literal-pathspecs', '-C', root, ...args],
        { env, encoding: 'buffer', timeout: 12_000, maxBuffer, windowsHide: true },
        (error, stdout) => {
          if (error)
            reject(
              new GitBaselineError('Git could not read HEAD within the local snapshot limits.'),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
}

export async function readGitHead(root: string) {
  const read = gitReader(await locateGit(root), root);
  const output = await read(['rev-parse', '--verify', 'HEAD^{commit}'], 4096).catch(() => {
    throw new GitBaselineError('Choose a Git working folder with at least one commit.');
  });
  const commit = output.toString('ascii').trim();
  if (!sha.test(commit)) throw new GitBaselineError('Git did not return a valid HEAD commit.');
  const prefix = utf8
    .decode(await read(['rev-parse', '--show-prefix'], 8192))
    .replace(/\r?\n$/u, '');
  return {
    commit,
    async snapshot<T>(consume: (directory: string) => Promise<T>): Promise<T> {
      const listing = await read(
        ['ls-tree', '-r', '-z', '-l', '--full-tree', commit, ...(prefix ? ['--', prefix] : [])],
        16 * 1024 * 1024,
      );
      const files: { path: string; id: string; size: number }[] = [];
      const seenPaths = new Map<string, string>();
      let bytes = 0;
      for (const entry of utf8.decode(listing).split('\0')) {
        const parsed = /^100(?:644|755) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/u.exec(entry);
        if (!parsed) continue;
        const [, id, length, fullPath] = parsed;
        if (!sha.test(id!) || !fullPath!.startsWith(prefix)) continue;
        const path = fullPath!.slice(prefix.length);
        if (!isGitSnapshotCandidate(path)) continue;
        const segments = path.split('/');
        if (
          path.length > 4096 ||
          segments.length > 33 ||
          segments.some(
            (segment) =>
              !segment ||
              segment.length > 255 ||
              unsafe.test(segment) ||
              /[ .]$/u.test(segment) ||
              device.test(segment),
          )
        )
          throw new GitBaselineError(
            'HEAD contains a tracked path that cannot be materialized safely.',
          );
        let partial = '';
        for (const segment of segments) {
          partial = partial ? `${partial}/${segment}` : segment;
          const key = partial.normalize('NFC').toLowerCase();
          const existing = seenPaths.get(key);
          if (existing !== undefined && existing !== partial)
            throw new GitBaselineError('HEAD has conflicting path names.');
          seenPaths.set(key, partial);
        }
        const size = Number(length);
        if (size > maxBlobBytes)
          throw new GitBaselineError('A tracked source file in HEAD exceeds the per-file limit.');
        bytes += size;
        if (bytes > maxSourceBytes || files.length >= maxFiles)
          throw new GitBaselineError(
            'HEAD exceeds the analysis limits. Open a smaller project folder.',
          );
        files.push({ path, id: id!, size });
      }

      const base = await realpath(tmpdir());
      const directory = await mkdtemp(join(base, 'arqivanta-git-head-'));
      try {
        // Process fixed batches of immutable blob IDs. Raw reads bypass worktree filters.
        for (let start = 0; start < files.length; start += 512) {
          const batch = files.slice(start, start + 512);
          const limit = batch.reduce((total, file) => total + file.size + 128, 0);
          const contents = await read(
            ['cat-file', '--batch'],
            limit,
            `${batch.map(({ id }) => id).join('\n')}\n`,
          );
          let offset = 0;
          const writes = [];
          for (const { id, size, path } of batch) {
            const newline = contents.indexOf(10, offset);
            const end = newline + 1 + size;
            if (
              newline < 0 ||
              contents.toString('ascii', offset, newline) !== `${id} blob ${size}` ||
              contents[end] !== 10
            )
              throw new GitBaselineError('Git returned an incomplete source blob.');
            writes.push({
              path: join(directory, ...path.split('/')),
              contents: contents.subarray(newline + 1, end),
            });
            offset = end + 1;
          }
          for (let i = 0; i < writes.length; i += 16) {
            const results = await Promise.allSettled(
              writes.slice(i, i + 16).map(async ({ path, contents }) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, contents, { flag: 'wx' });
              }),
            );
            if (results.some(({ status }) => status === 'rejected'))
              throw new GitBaselineError('The temporary Git snapshot could not be written.');
          }
        }
        return await consume(directory);
      } finally {
        if (dirname(directory) === base && directory !== base)
          await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      }
    },
  };
}
