import { spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

function findWingetFfmpegBinary(filename: 'ffmpeg.exe' | 'ffprobe.exe') {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return undefined;
  const packageRoot = path.join(
    process.env.LOCALAPPDATA,
    'Microsoft',
    'WinGet',
    'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe'
  );
  try {
    for (const directory of readdirSync(packageRoot).filter((name) => name.startsWith('ffmpeg-')).reverse()) {
      const candidate = path.join(packageRoot, directory, 'bin', filename);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Fall back to PATH below when Winget is unavailable or unreadable.
  }
  return undefined;
}

function resolveFfmpegBinary(
  configured: string | undefined,
  filename: 'ffmpeg.exe' | 'ffprobe.exe',
  command: 'ffmpeg' | 'ffprobe'
) {
  const isBareCommand = !configured
    || configured.toLowerCase() === command
    || configured.toLowerCase() === filename;
  if (!isBareCommand) return configured;
  return findWingetFfmpegBinary(filename) || configured || command;
}

export const binaries = {
  ffmpeg: resolveFfmpegBinary(process.env.FFMPEG_BIN, 'ffmpeg.exe', 'ffmpeg'),
  ffprobe: resolveFfmpegBinary(process.env.FFPROBE_BIN, 'ffprobe.exe', 'ffprobe'),
  python: process.env.PYTHON_BIN || 'python'
};

export async function runProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const maxLogLength = 2_000_000;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-maxLogLength);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-maxLogLength);
    });
    child.on('error', (error) => {
      const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `\nCould not find ${command}. Check the README setup steps or configure its *_BIN environment variable.`
        : '';
      reject(new Error(`${error.message}${hint}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}.\n${stderr.slice(-5000)}`));
    });
  });
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(process.cwd(), '<project>').slice(0, 4000);
}
