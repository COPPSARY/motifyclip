import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EditPlan, MediaInfo, TranscriptSegment } from './types.js';
import { binaries, runProcess } from './tools.js';

type CaptionEntry = { start: number; end: number; text: string };
type RenderSource = {
  path: string;
  media: MediaInfo;
  transcript: TranscriptSegment[];
  subjectCenter?: number;
};

function even(value: number) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function targetSize(aspectRatio: EditPlan['aspectRatio'], media: MediaInfo): [number, number] {
  if (aspectRatio === '9:16') return [720, 1280];
  if (aspectRatio === '16:9') return [1280, 720];
  if (aspectRatio === '1:1') return [1080, 1080];
  return [even(media.width), even(media.height)];
}

function formatSrtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function buildCaptionEntries(
  transcripts: TranscriptSegment[][],
  plan: EditPlan
): CaptionEntry[] {
  const entries: CaptionEntry[] = [];
  let outputCursor = 0;

  for (const clip of plan.clips) {
    const transcript = transcripts[clip.source] || [];
    for (const segment of transcript) {
      const overlapStart = Math.max(segment.start, clip.start);
      const overlapEnd = Math.min(segment.end, clip.end);
      if (overlapEnd - overlapStart < 0.05 || !segment.text.trim()) continue;
      entries.push({
        start: outputCursor + (overlapStart - clip.start) / plan.speed,
        end: outputCursor + (overlapEnd - clip.start) / plan.speed,
        text: segment.text.trim().replace(/[<>]/g, '')
      });
    }
    outputCursor += (clip.end - clip.start) / plan.speed;
  }
  return entries;
}

function splitCaptionEntries(entries: CaptionEntry[]) {
  return entries.flatMap((entry) => {
    const khmer = /[\u1780-\u17ff]/.test(entry.text);
    const tokens = khmer
      ? [...new Intl.Segmenter('km', { granularity: 'word' }).segment(entry.text)]
        .map((part) => part.segment)
        .filter((part) => part.trim())
      : entry.text.split(/\s+/).filter(Boolean);
    const duration = entry.end - entry.start;
    if (tokens.length <= 5 || duration < 1.2) return [entry];

    const maxChunks = Math.max(1, Math.floor(duration / 0.55));
    const wordsPerChunk = Math.max(3, Math.ceil(tokens.length / maxChunks));
    const chunks: string[] = [];
    for (let index = 0; index < tokens.length; index += wordsPerChunk) {
      chunks.push(tokens.slice(index, index + wordsPerChunk).join(khmer ? '' : ' '));
    }
    const cueDuration = duration / chunks.length;
    return chunks.map((text, index) => ({
      start: entry.start + index * cueDuration,
      end: entry.start + (index + 1) * cueDuration,
      text
    }));
  });
}

function makeSrt(entries: CaptionEntry[]) {
  return entries.map((entry, index) => [
    index + 1,
    `${formatSrtTime(entry.start)} --> ${formatSrtTime(entry.end)}`,
    entry.text,
    ''
  ].join('\n')).join('\n');
}

function resolveFontFile(text: string) {
  const windowsFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const khmer = /[\u1780-\u17ff]/.test(text);
  const candidates = (khmer ? [
    process.env.MOTIFY_KHMER_FONT_FILE,
    process.platform === 'win32' ? path.join(windowsFonts, 'KhmerUIb.ttf') : undefined,
    process.platform === 'win32' ? path.join(windowsFonts, 'KhmerOSbattambang.ttf') : undefined,
    process.platform === 'win32' ? path.join(windowsFonts, 'KhmerOS.ttf') : undefined,
    '/usr/share/fonts/truetype/noto/NotoSansKhmer-Bold.ttf'
  ] : [
    process.env.MOTIFY_FONT_FILE,
    process.platform === 'win32' ? path.join(windowsFonts, 'arialbd.ttf') : undefined,
    process.platform === 'win32' ? path.join(windowsFonts, 'segoeuib.ttf') : undefined,
    process.platform === 'win32' ? path.join(windowsFonts, 'arial.ttf') : undefined,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'
  ]).filter((candidate): candidate is string => Boolean(candidate));
  const font = candidates.find((candidate) => existsSync(candidate));
  if (!font) throw new Error(`No usable ${khmer ? 'Khmer ' : ''}caption font was found. Configure a .ttf or .otf font in .env.`);
  return font.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

function wrapCaption(text: string, maxCharacters: number) {
  const khmer = /[\u1780-\u17ff]/.test(text);
  if (khmer) {
    const segmenter = new Intl.Segmenter('km', { granularity: 'word' });
    const words = [...segmenter.segment(text)].map((s) => s.segment);
    const lines: string[] = [];
    let currentLine = '';
    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
      } else if (currentLine.length + word.length <= maxCharacters) {
        currentLine += word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.join('\n');
  }

  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > maxCharacters) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  return lines.join('\n');
}

function clipVideoFilter(
  targetWidth: number,
  targetHeight: number,
  sourceMedia: MediaInfo,
  subjectCenter: number | undefined,
  speed: number,
  punch: boolean | undefined,
  sourceDuration: number
) {
  const sourceAspect = sourceMedia.width / sourceMedia.height;
  const targetAspect = targetWidth / targetHeight;
  const filters: string[] = [
    `trim=duration=${sourceDuration.toFixed(3)}`,
    `setpts=(PTS-STARTPTS)/${speed}`
  ];

  if (Math.abs(sourceAspect - targetAspect) > 0.02) {
    if (targetAspect < sourceAspect) {
      // Cropping landscape to vertical 9:16
      const cropW = even(Math.round(sourceMedia.height * targetAspect));
      const centerFactor = subjectCenter ?? 0.5;
      const idealX = centerFactor * sourceMedia.width;
      const cropX = even(Math.max(0, Math.min(sourceMedia.width - cropW, Math.round(idealX - cropW / 2))));
      filters.push(`crop=${cropW}:${sourceMedia.height}:${cropX}:0`);
      filters.push(`scale=${targetWidth}:${targetHeight}`);
    } else {
      // Cropping vertical to landscape
      const cropH = even(Math.round(sourceMedia.width / targetAspect));
      const cropY = even(Math.max(0, Math.min(sourceMedia.height - cropH, Math.round((sourceMedia.height - cropH) / 2))));
      filters.push(`crop=${sourceMedia.width}:${cropH}:0:${cropY}`);
      filters.push(`scale=${targetWidth}:${targetHeight}`);
    }
  } else {
    filters.push(`scale=${targetWidth}:${targetHeight}`);
  }

  if (punch) {
    const punchScale = 1.08;
    filters.push(
      `scale=${even(targetWidth * punchScale)}:${even(targetHeight * punchScale)}`,
      `crop=${targetWidth}:${targetHeight}`
    );
  }

  filters.push('fps=30', 'format=yuv420p');
  return filters.join(',');
}

async function renderClip(
  sourcePath: string,
  destination: string,
  start: number,
  end: number,
  speed: number,
  size: [number, number],
  media: MediaInfo,
  subjectCenter: number | undefined,
  punch: boolean | undefined,
  hasAudio: boolean,
  cwd: string
) {
  const sourceDuration = end - start;
  const args = ['-y', '-v', 'error', '-ss', start.toFixed(3), '-i', sourcePath];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  args.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', clipVideoFilter(size[0], size[1], media, subjectCenter, speed, punch, sourceDuration),
    '-af', hasAudio
      ? `atrim=duration=${sourceDuration.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed},aresample=48000`
      : `atrim=duration=${(sourceDuration / speed).toFixed(3)},aresample=48000`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    destination
  );
  await runProcess(binaries.ffmpeg, args, { cwd });
}

function overlayY(position: 'top' | 'center' | 'bottom') {
  if (position === 'top') return 'h*0.18';
  if (position === 'center') return 'h*0.54';
  return 'h*0.78';
}

export async function renderEdit(
  sources: RenderSource[],
  jobDirectory: string,
  plan: EditPlan,
  onProgress: (progress: number, message: string) => void
) {
  const firstSource = sources[plan.clips[0].source];
  if (!firstSource) throw new Error('The edit plan references a missing source video.');
  const size = targetSize(plan.aspectRatio, firstSource.media);
  const clipNames: string[] = [];

  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index];
    const source = sources[clip.source];
    if (!source) throw new Error(`Edit clip ${index + 1} references missing source ${clip.source}.`);
    const name = `clip-${String(index).padStart(3, '0')}.mp4`;
    clipNames.push(name);
    onProgress(68 + Math.round((index / plan.clips.length) * 20), `Rendering clip ${index + 1} of ${plan.clips.length}`);
    await renderClip(
      source.path,
      path.join(jobDirectory, name),
      clip.start,
      clip.end,
      plan.speed,
      size,
      source.media,
      source.subjectCenter,
      clip.punch,
      source.media.hasAudio,
      jobDirectory
    );
  }

  const concatList = clipNames.map((name) => `file '${name}'`).join('\n');
  await writeFile(path.join(jobDirectory, 'concat.txt'), concatList, 'utf8');
  const joinedPath = path.join(jobDirectory, 'joined.mp4');
  await runProcess(binaries.ffmpeg, [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
    '-c', 'copy', '-movflags', '+faststart', joinedPath
  ], { cwd: jobDirectory });

  const filters: string[] = [];
  const totalDuration = Math.max(0.1, plan.clips.reduce((sum, c) => sum + (c.end - c.start) / plan.speed, 0));

  // Dynamic social media progress retention bar at the bottom
  filters.push(
    'drawbox=x=0:y=ih-8:w=iw:h=8:color=black@0.40:t=fill',
    `drawbox=x=0:y=ih-8:w=iw*t/${totalDuration.toFixed(3)}:h=8:color=0xDFFF00@0.95:t=fill:enable='between(t,0,${totalDuration.toFixed(3)})'`
  );

  const transcripts = sources.map((source) => source.transcript);
  if (plan.captions && transcripts.some((transcript) => transcript.length)) {
    const captions = splitCaptionEntries(buildCaptionEntries(transcripts, plan));
    if (captions.length) {
      await writeFile(path.join(jobDirectory, 'captions.srt'), makeSrt(captions), 'utf8');
      const fontSize = Math.max(32, Math.round(size[0] / 17.5));
      for (let index = 0; index < captions.length; index += 1) {
        const caption = captions[index];
        const fontFile = resolveFontFile(caption.text);
        const filename = `caption-${String(index).padStart(3, '0')}.txt`;
        const filePath = path.join(jobDirectory, filename).replaceAll('\\', '/').replaceAll(':', '\\:');
        await writeFile(
          path.join(jobDirectory, filename),
          wrapCaption(caption.text, size[0] <= 720 ? (/\p{Script=Khmer}/u.test(caption.text) ? 22 : 24) : 34),
          'utf8'
        );
        filters.push([
          `drawtext=fontfile='${fontFile}'`,
          `textfile='${filePath}'`,
          'expansion=none',
          'fontcolor=white',
          `fontsize=${fontSize}`,
          'line_spacing=5',
          'text_align=center',
          'x=(w-text_w)/2',
          'y=h*0.65',
          'borderw=4',
          'bordercolor=black@0.95',
          'shadowx=2',
          'shadowy=3',
          'shadowcolor=black@0.65',
          'fix_bounds=1',
          `enable='between(t,${caption.start.toFixed(3)},${caption.end.toFixed(3)})'`
        ].join(':'));
      }
    }
  }

  for (let index = 0; index < plan.textOverlays.length; index += 1) {
    const overlay = plan.textOverlays[index];
    const fontFile = resolveFontFile(overlay.text);
    const filename = `overlay-${String(index).padStart(3, '0')}.txt`;
    const filePath = path.join(jobDirectory, filename).replaceAll('\\', '/').replaceAll(':', '\\:');
    const overlayText = overlay.text.replace(/[\r\n]+/g, ' ');
    const overlayMaxCharacters = overlay.style === 'title' ? 24 : overlay.style === 'keyword' ? 18 : 28;
    await writeFile(path.join(jobDirectory, filename), wrapCaption(overlayText, overlayMaxCharacters), 'utf8');
    const color = { white: 'white', lime: '0xDFFF00', pink: '0xFF2F92', yellow: '0xFFD51F' }[overlay.color];

    if (overlay.style === 'title') {
      // Elegant top header banner card in upper safe zone (y=4% instead of 8% to clear speaker head)
      const bannerH = Math.round(size[1] * 0.056);
      const bannerW = Math.round(size[0] * 0.82);
      const bannerY = Math.round(size[1] * 0.04);
      filters.push(
        `drawbox=x=(iw-${bannerW})/2:y=${bannerY}:w=${bannerW}:h=${bannerH}:color=black@0.85:t=fill:enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`,
        `drawbox=x=(iw-${bannerW})/2:y=${bannerY}:w=${bannerW}:h=${bannerH}:color=${color}@0.90:t=2:enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`
      );
      filters.push([
        `drawtext=fontfile='${fontFile}'`,
        `textfile='${filePath}'`,
        'expansion=none',
        `fontcolor=${color}`,
        `fontsize=${Math.max(26, Math.round(size[0] / 19))}`,
        'text_align=center',
        'x=(w-text_w)/2',
        `y=${bannerY}+(${bannerH}-text_h)/2`,
        'borderw=2',
        'bordercolor=black@0.9',
        `enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`
      ].join(':'));
    } else if (overlay.style === 'keyword') {
      // Supporting graphic callout card sized dynamically to text, placed safely
      const yCenter = overlay.position === 'top' ? size[1] * 0.12 : overlay.position === 'bottom' ? size[1] * 0.78 : size[1] * 0.52;
      const textLen = overlayText.length;
      const cardW = Math.round(Math.min(size[0] * 0.76, Math.max(size[0] * 0.36, textLen * (size[0] / 19))));
      const cardH = Math.round(size[1] * 0.052);
      const cardY = Math.round(yCenter - cardH / 2);
      filters.push(
        `drawbox=x=(iw-${cardW})/2:y=${cardY}:w=${cardW}:h=${cardH}:color=0x181C22@0.92:t=fill:enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`,
        `drawbox=x=(iw-${cardW})/2:y=${cardY}:w=${cardW}:h=${cardH}:color=${color}@0.90:t=2:enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`
      );
      filters.push([
        `drawtext=fontfile='${fontFile}'`,
        `textfile='${filePath}'`,
        'expansion=none',
        `fontcolor=${color}`,
        `fontsize=${Math.max(26, Math.round(size[0] / 18))}`,
        'text_align=center',
        'x=(w-text_w)/2',
        `y=${cardY}+(${cardH}-text_h)/2`,
        'borderw=2',
        'bordercolor=black@0.9',
        `enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`
      ].join(':'));
    } else {
      // lowerThird
      const y = overlayY(overlay.position);
      filters.push([
        `drawtext=fontfile='${fontFile}'`,
        `textfile='${filePath}'`,
        'expansion=none',
        `fontcolor=${color}`,
        `fontsize=${Math.max(24, Math.round(size[0] / 20))}`,
        'text_align=center',
        'x=(w-text_w)/2',
        `y=${y}`,
        'box=1',
        'boxcolor=black@0.75',
        'boxborderw=12',
        `enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'`
      ].join(':'));
    }
  }

  const outputPath = path.join(jobDirectory, 'edited.mp4');
  onProgress(92, 'Finalizing audio and video rendering');
  await runProcess(binaries.ffmpeg, [
    '-y', '-v', 'error', '-i', joinedPath,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath
  ], { cwd: jobDirectory });

  return outputPath;
}
