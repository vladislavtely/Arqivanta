import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractSnapshot, MAX_ARCHIVE_BYTES } from './snapshot.ts';
import { GitHubImportError } from './errors.ts';

export { GitHubImportError } from './errors.ts';

export interface GitHubRepository {
  owner: string;
  repo: string;
  url: string;
}

const shaPattern = /^[a-f0-9]{40}$/u;
const requestTimeoutMs = 30_000;
const userAgent = 'Arqivanta/0.1';

export function parseGitHubUrl(input: string): GitHubRepository {
  const match =
    /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,104})\/?$/iu.exec(
      input.trim(),
    );
  if (match) {
    const owner = match[1]!.toLowerCase();
    const repo = match[2]!.toLowerCase().replace(/\.git$/u, '');
    if (
      repo.length >= 1 &&
      repo.length <= 100 &&
      repo !== '.' &&
      repo !== '..' &&
      !repo.endsWith('.git')
    ) {
      return { owner, repo, url: `https://github.com/${owner}/${repo}` };
    }
  }
  throw new GitHubImportError(
    'invalid-url',
    'Enter a public GitHub URL like https://github.com/owner/repository.',
  );
}

function operationSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function readGitHub(url: URL, limit: number, signal: AbortSignal): Promise<Buffer> {
  try {
    const response = await fetch(url, {
      redirect: 'error',
      headers: {
        accept:
          url.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/zip',
        'user-agent': userAgent,
      },
      signal,
    });

    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => {});
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')))
      ) {
        throw new GitHubImportError(
          'rate-limit',
          'GitHub’s public API rate limit was reached. Try again later.',
        );
      }
      if (response.status === 404 || response.status === 403) {
        throw new GitHubImportError(
          'not-found',
          'This public GitHub repository could not be found or accessed.',
        );
      }
      if (response.status === 409) {
        throw new GitHubImportError(
          'not-found',
          'This GitHub repository has no commits to import.',
        );
      }
      if (!response.ok || !response.body) {
        throw new GitHubImportError('unavailable', `GitHub returned HTTP ${response.status}.`);
      }
      throw new GitHubImportError('too-large', 'The GitHub download exceeds the size limit.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > limit) {
          throw new GitHubImportError('too-large', 'The GitHub download exceeds the size limit.');
        }
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof GitHubImportError) throw error;
    if (signal.aborted) {
      throw new GitHubImportError('canceled', 'The GitHub download timed out or was canceled.');
    }
    throw new GitHubImportError(
      'unavailable',
      'Could not reach GitHub. Check your connection and the repository URL.',
    );
  }
}

export async function resolveGitHubRevision(
  repository: GitHubRepository,
  signal?: AbortSignal,
): Promise<string> {
  const { owner, repo } = parseGitHubUrl(repository.url);
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`);
  const payload = await readGitHub(url, 2 * 1024 * 1024, operationSignal(signal));
  const githubError = new GitHubImportError(
    'unavailable',
    'GitHub did not return a valid commit SHA.',
  );
  try {
    const revisions = JSON.parse(payload.toString('utf8')) as { sha?: unknown }[] | null;
    const sha = revisions?.[0]?.sha;
    if (typeof sha === 'string' && shaPattern.test(sha)) return sha;
  } catch {
    throw githubError;
  }
  throw githubError;
}

export async function withGitHubSnapshot<T>(
  repository: GitHubRepository,
  sha: string,
  consume: (root: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { owner, repo } = parseGitHubUrl(repository.url);
  if (!shaPattern.test(sha)) {
    throw new GitHubImportError('invalid-url', 'A full GitHub commit SHA is required.');
  }

  const deadline = operationSignal(signal);
  const url = new URL(`https://codeload.github.com/${owner}/${repo}/zip/${sha}`);
  const archive = await readGitHub(url, MAX_ARCHIVE_BYTES, deadline);
  const root = await mkdtemp(path.join(tmpdir(), 'arqivanta-github-'));
  try {
    await extractSnapshot(archive, root, deadline);
    if (signal?.aborted) throw new GitHubImportError('canceled', 'The GitHub import was canceled.');
    return await consume(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 2 });
  }
}
