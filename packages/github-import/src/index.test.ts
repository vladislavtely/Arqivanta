import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGitHubUrl, resolveGitHubRevision, withGitHubSnapshot } from './index.ts';

const sha = '0123456789abcdef0123456789abcdef01234567';
const repository = parseGitHubUrl('https://github.com/example/demo');

function sampleZip(files: { name: string; contents: string; mode?: number }[]) {
  const local: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const contents = Buffer.from(file.contents);
    const checksum = crc32(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(contents.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, contents);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(contents.length, 20);
    entry.writeUInt32LE(contents.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    entries.push(entry, name);
    offset += header.length + name.length + contents.length;
  }
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

afterEach(() => vi.unstubAllGlobals());

describe('public GitHub import', () => {
  it('canonicalizes a GitHub clone URL', () => {
    expect(parseGitHubUrl(' https://github.com/Example/DEMO.git/ ')).toEqual(repository);
  });

  it.each([
    'https://github.com.example.com/example/demo',
    'https://github.com@unrelated.example/example/demo',
    'https://github.com/example/demo/archive/main',
    'https://github.com/example/%2e%2e',
    'http://github.com/example/demo',
  ])('rejects non-repository URLs (%s)', (url) => {
    expect(() => parseGitHubUrl(url)).toThrow('public GitHub URL');
  });

  it('fetches the default branch revision without redirects or credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([{ sha }]));
    vi.stubGlobal('fetch', fetch);
    await expect(resolveGitHubRevision(repository)).resolves.toBe(sha);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/example/demo/commits?per_page=1',
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
    expect(new Headers(fetch.mock.calls[0]![1].headers).has('authorization')).toBe(false);
  });

  it('reports rate limits instead of downloading an archive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
      ),
    );
    await expect(resolveGitHubRevision(repository)).rejects.toMatchObject({ code: 'rate-limit' });
  });

  it('unpacks only regular files from the pinned commit and removes the temporary snapshot', async () => {
    const archive = sampleZip([
      { name: 'repo/src/main.ts', contents: 'export const example = 1' },
      { name: 'repo/app-link', contents: 'src/main.ts', mode: 0o120777 },
    ]);
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(archive)));
    vi.stubGlobal('fetch', fetch);
    let snapshot = '';
    const imported = await withGitHubSnapshot(repository, sha, async (root) => {
      snapshot = root;
      await expect(stat(path.join(root, 'app-link'))).rejects.toMatchObject({ code: 'ENOENT' });
      return readFile(path.join(root, 'src', 'main.ts'), 'utf8');
    });
    expect(imported).toBe('export const example = 1');
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `https://codeload.github.com/example/demo/zip/${sha}`,
    );
    await expect(stat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects ambiguous paths before passing any files to analysis', async () => {
    const archive = sampleZip([
      { name: 'repo/src/Main.ts', contents: 'export const example = 1' },
      { name: 'repo/src/main.ts', contents: 'export const example = 2' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(archive))));
    const analyze = vi.fn();
    await expect(withGitHubSnapshot(repository, sha, analyze)).rejects.toMatchObject({
      code: 'invalid-archive',
    });
    expect(analyze).not.toHaveBeenCalled();
  });
});
