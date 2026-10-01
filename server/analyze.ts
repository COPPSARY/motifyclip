import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Analysis, MediaInfo } from './types.js';
import { binaries, runProcess } from './tools.js';

type ProbeOutput = {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    tags?: { rotate?: string; [key: string]: unknown };
    side_data_list?: Array<{ rotation?: number; [key: string]: unknown }>;
  }>;
  format?: { duration?: string };
};

function parseFrameRate(value = '0/1') {
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 30;
  return numerator / denominator;
}

export async function probeMedia(videoPath: string): Promise<MediaInfo> {
  const { stdout } = await runProcess(binaries.ffprobe, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    videoPath
  ]);
  const data = JSON.parse(stdout) as ProbeOutput;
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('The uploaded file does not contain a readable video stream.');

  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine the video duration.');

  const rotation = Math.abs(
    Number(video.tags?.rotate) ||
    Number(video.side_data_list?.find((entry) => typeof entry.rotation === 'number')?.rotation) ||
    0
  );
  let width = video.width;
  let height = video.height;
  if (rotation === 90 || rotation === 270) {
    [width, height] = [height, width];
  }

  return {
    duration,
    width,
    height,
    fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
    hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === 'audio'))
  };
}

async function extractSpeechAudio(videoPath: string, audioPath: string) {
  await runProcess(binaries.ffmpeg, [
    '-y', '-v', 'error', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', audioPath
  ]);
}

type KiriTranscription = {
  language?: string;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  words?: Array<{ start?: number; end?: number; word?: string; text?: string }>;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

function isRetryableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: string } | undefined;
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error instanceof TypeError
    || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(cause?.code || '');
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function segmentsFromWords(words: NonNullable<KiriTranscription['words']>) {
  const segments: Analysis['transcript'] = [];
  let group: typeof words = [];
  for (const word of words) {
    group.push(word);
    const content = word.word || word.text || '';
    if (/[.!?។៕]$/.test(content) || group.length >= 10) {
      const start = group[0]?.start;
      const end = group.at(-1)?.end;
      const text = group.map((item) => item.word || item.text || '').join(' ').trim();
      if (Number.isFinite(start) && Number.isFinite(end) && text) segments.push({ start: start!, end: end!, text });
      group = [];
    }
  }
  if (group.length) {
    const start = group[0]?.start;
    const end = group.at(-1)?.end;
    const text = group.map((item) => item.word || item.text || '').join(' ').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && text) segments.push({ start: start!, end: end!, text });
  }
  return segments;
}

async function transcribeWithKiri(audioPath: string): Promise<Pick<Analysis, 'transcript' | 'language'>> {
  const apiKey = process.env.KIRI_API_KEY;
  if (!apiKey) throw new Error('KIRI_API_KEY is not set. Add your Kiri API key to .env.');

  const audio = await readFile(audioPath);
  const baseUrl = (process.env.KIRI_API_BASE_URL || 'https://api.kiritts.com/v1').replace(/\/$/, '');
  const configuredAttempts = Number(process.env.KIRI_MAX_ATTEMPTS || 3);
  const maxAttempts = Number.isInteger(configuredAttempts) ? Math.min(5, Math.max(1, configuredAttempts)) : 3;
  const configuredTimeout = Number(process.env.KIRI_REQUEST_TIMEOUT_MS || 15 * 60 * 1000);
  const timeout = Number.isFinite(configuredTimeout) ? Math.max(10_000, configuredTimeout) : 15 * 60 * 1000;
  let response: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const body = new FormData();
    body.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'speech.mp3');
    body.append('model', process.env.KIRI_STT_MODEL || 'kiristt');
    body.append('response_format', 'verbose_json');
    body.append('timestamp_granularities', 'word,segment');

    try {
      response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(timeout)
      });
      if (response.ok) break;

      const detail = await response.text();
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Kiri transcription failed (${response.status}): ${detail.slice(0, 1000)}`);
      }
      console.warn(`Kiri transcription returned ${response.status}; retrying (${attempt}/${maxAttempts}).`);
    } catch (error) {
      if (!isRetryableNetworkError(error) || attempt === maxAttempts) {
        throw new Error(`Kiri transcription request failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${errorMessage(error)}`, {
          cause: error
        });
      }
      console.warn(`Kiri transcription connection failed; retrying (${attempt}/${maxAttempts}): ${errorMessage(error)}`);
    }

    await wait(Math.min(4_000, 750 * (2 ** (attempt - 1))));
  }

  if (!response?.ok) throw new Error('Kiri transcription failed without a response.');

  const result = await response.json() as KiriTranscription;
  const segmentTranscript = (result.segments || [])
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.text?.trim())
    .map((segment) => ({ start: segment.start!, end: segment.end!, text: segment.text!.trim() }));
  const wordTranscript = segmentsFromWords(result.words || []);
  return {
    // Word-derived phrases give the director and caption renderer useful timing
    // when providers return a few very long sentence-level segments.
    transcript: wordTranscript.length > segmentTranscript.length ? wordTranscript : segmentTranscript,
    language: result.language || null
  };
}

async function detectSilences(videoPath: string): Promise<Analysis['silences']> {
  try {
    const { stderr } = await runProcess(binaries.ffmpeg, [
      '-i', videoPath,
      '-af', 'silencedetect=noise=-30dB:d=0.35',
      '-f', 'null', '-'
    ]);
    const silences: NonNullable<Analysis['silences']> = [];
    const lines = stderr.split(/\r?\n/);
    let currentStart: number | null = null;
    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) {
        currentStart = Number(startMatch[1]);
      }
      const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const end = Number(endMatch[1]);
        const duration = Number(endMatch[2]);
        if (Number.isFinite(currentStart) && Number.isFinite(end) && duration >= 0.3) {
          silences.push({
            start: Math.round(currentStart * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
            duration: Math.round(duration * 1000) / 1000
          });
        }
        currentStart = null;
      }
    }
    return silences;
  } catch {
    return [];
  }
}

export async function analyzeVideo(videoPath: string, jobDirectory: string, hasAudio: boolean): Promise<Analysis> {
  const audioPath = path.join(jobDirectory, 'speech.mp3');
  const outputPath = path.join(jobDirectory, 'analysis.json');
  if (hasAudio) await extractSpeechAudio(videoPath, audioPath);

  const scriptPath = path.resolve('python', 'analyze.py');
  const sceneTask = runProcess(binaries.python, [scriptPath, '--video', videoPath, '--output', outputPath]);
  const silenceTask = hasAudio ? detectSilences(videoPath) : Promise.resolve([]);
  const transcriptionTask = hasAudio
    ? transcribeWithKiri(audioPath)
    : Promise.resolve({ transcript: [], language: null });
  const [, silences, transcription] = await Promise.all([sceneTask, silenceTask, transcriptionTask]);

  const sceneAnalysis = JSON.parse(await readFile(outputPath, 'utf8')) as Analysis;
  const analysis: Analysis = {
    scenes: sceneAnalysis.scenes,
    subjectCenter: sceneAnalysis.subjectCenter ?? 0.5,
    silences,
    ...transcription
  };
  await writeFile(outputPath, JSON.stringify(analysis, null, 2));
  await writeFile(path.join(jobDirectory, 'scenes.json'), JSON.stringify(analysis.scenes, null, 2));
  await writeFile(path.join(jobDirectory, 'transcript.json'), JSON.stringify(analysis.transcript, null, 2));
  return analysis;
}
