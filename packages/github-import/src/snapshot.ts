import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { GitHubImportError } from './errors.ts';

export const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_PATH_LENGTH = 240;
const MAX_PATH_DEPTH = 40;
const windowsDevice = /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ ]*(?:\.|$)/iu;
const unsafeNames = /[<>:"\\|?*\p{Cc}]/u;

function openArchive(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) reject(error);
        else resolve(zip);
      },
    );
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function invalidPath(): GitHubImportError {
  return new GitHubImportError(
    'invalid-archive',
    'The GitHub archive contains an unsafe or conflicting file path.',
  );
}

export async function extractSnapshot(
  buffer: Buffer,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const zip = await openArchive(buffer);
    if (zip.entryCount > MAX_ENTRIES) {
      throw new GitHubImportError('too-large', 'The GitHub archive contains too many files.');
    }
    let expandedBytes = 0;
    let archiveRoot: string | undefined;
    const paths = new Map<string, { name: string; directory: boolean }>();

    for (let count = 0; count < zip.entryCount; count += 1) {
      signal.throwIfAborted();
      // Keep the ZIP error listener attached until this in-memory read completes.
      const pendingEntry = once(zip, 'entry');
      zip.readEntry();
      const [entry] = (await pendingEntry) as [Entry];
      signal.throwIfAborted();
      const directories = entry.fileName.endsWith('/');
      const segments = entry.fileName.replace(/\/$/u, '').split('/');
      const prefix = segments.shift();

      if (!prefix || (archiveRoot !== undefined && prefix !== archiveRoot)) throw invalidPath();
      archiveRoot ??= prefix;
      if (segments.length === 0 && directories) continue;
      if (
        segments.length === 0 ||
        segments.some(
          (name) =>
            !name || unsafeNames.test(name) || windowsDevice.test(name) || /[ .]$/u.test(name),
        )
      ) {
        throw invalidPath();
      }
      if (segments.some((name) => name.toLowerCase() === '.git')) continue;
      const name = segments.join('/');
      if (name.length > MAX_PATH_LENGTH || segments.length > MAX_PATH_DEPTH) {
        throw new GitHubImportError(
          'too-large',
          'A file path in the GitHub archive exceeds the import limit.',
        );
      }

      // ZIP entries can encode symlinks and other UNIX special files.
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (directories || (type !== 0 && type !== 0o100000)) continue;

      expandedBytes += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_FILE_BYTES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new GitHubImportError(
          'too-large',
          'The unpacked GitHub archive exceeds the size limit.',
        );
      }

      let entryPath = '';
      for (let index = 0; index < segments.length; index += 1) {
        const directory = index < segments.length - 1;
        entryPath = index === 0 ? segments[index]! : `${entryPath}/${segments[index]}`;
        const key = entryPath.normalize('NFC').toLowerCase();
        const previous = paths.get(key);
        if (previous && (!directory || !previous.directory || previous.name !== entryPath)) {
          throw invalidPath();
        }
        if (!previous) paths.set(key, { name: entryPath, directory });
      }

      if (paths.size > MAX_ENTRIES) {
        throw new GitHubImportError('too-large', 'The GitHub archive contains too many paths.');
      }

      const target = path.join(root, ...segments);
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(await openEntry(zip, entry), createWriteStream(target, { flags: 'wx' }), {
        signal,
      });
    }
  } catch (error) {
    if (error instanceof GitHubImportError) throw error;
    if (signal.aborted) {
      throw new GitHubImportError(
        'canceled',
        'GitHub archive extraction timed out or was canceled.',
      );
    }
    throw new GitHubImportError(
      'invalid-archive',
      'The GitHub archive could not be safely unpacked.',
    );
  }
}
