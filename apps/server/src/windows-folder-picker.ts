import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function pickWindowsFolder(signal: AbortSignal): Promise<string | null> {
  const script = await readFile(new URL('./pick-folder.ps1', import.meta.url), 'utf8');
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  const { stdout } = await exec(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    // The process must be allowed to show the native dialog.
    { encoding: 'utf8', maxBuffer: 32_768, signal, timeout: 300_000 },
  );
  return stdout.replace(/\r?\n$/, '') || null;
}
