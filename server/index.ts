import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { fileURLToPath } from 'node:url';
import { analyzeVideo, probeMedia } from './analyze.js';
import { createEditPlan } from './gemini.js';
import { renderEdit } from './render.js';
import type { Job } from './types.js';
import { friendlyError } from './tools.js';

// Prefer IPv4 on Windows networks where unreachable IPv6 routes can make
// Node's external API requests fail with AggregateError/ETIMEDOUT.
setDefaultResultOrder('ipv4first');

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.join(rootDirectory, 'data');
const uploadDirectory = path.join(dataDirectory, 'uploads');
const jobsDirectory = path.join(dataDirectory, 'jobs');
await Promise.all([
  mkdir(uploadDirectory, { recursive: true }),
  mkdir(jobsDirectory, { recursive: true })
]);

const app = express();
const jobs = new Map<string, Job>();
const allowedExtensions = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const upload = multer({
  dest: uploadDirectory,
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 12 }
});

app.disable('x-powered-by');
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

function publicJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    originalUrl: `/api/edits/${job.id}/media/original/0`,
    originalUrls: job.sourcePaths.map((_, index) => `/api/edits/${job.id}/media/original/${index}`),
    editedUrl: job.editedPath ? `/api/edits/${job.id}/media/edited` : undefined,
    downloadUrl: job.editedPath ? `/api/edits/${job.id}/download` : undefined,
    aspectRatio: job.aspectRatio,
    plan: job.plan,
    error: job.error
  };
}

function updateJob(job: Job, status: Job['status'], progress: number, message: string) {
  job.status = status;
  job.progress = progress;
  job.message = message;
}

async function processJob(job: Job) {
  const jobDirectory = path.dirname(job.sourcePaths[0]);
  try {
    const sources = [];
    for (let index = 0; index < job.sourcePaths.length; index += 1) {
      const progress = 8 + Math.round((index / job.sourcePaths.length) * 36);
      updateJob(job, 'analyzing', progress, `Analyzing source ${index + 1} of ${job.sourcePaths.length}`);
      const media = await probeMedia(job.sourcePaths[index]);
      const analysisDirectory = path.join(jobDirectory, `analysis-${String(index).padStart(3, '0')}`);
      await mkdir(analysisDirectory, { recursive: true });
      const analysis = await analyzeVideo(job.sourcePaths[index], analysisDirectory, media.hasAudio);
      sources.push({ path: job.sourcePaths[index], name: job.sourceNames[index], media, analysis });
    }
    await writeFile(path.join(jobDirectory, 'sources.json'), JSON.stringify(
      sources.map(({ name, media, analysis }) => ({ name, media, analysis })), null, 2
    ));

    updateJob(job, 'directing', 48, 'Gemini is shaping the story');
    job.plan = await createEditPlan(job.prompt, sources, job.aspectRatio);
    await writeFile(path.join(jobDirectory, 'edit-plan.json'), JSON.stringify(job.plan, null, 2));

    updateJob(job, 'rendering', 65, 'Preparing the FFmpeg edit');
    job.editedPath = await renderEdit(
      sources.map((source) => ({
        path: source.path,
        media: source.media,
        transcript: source.analysis.transcript,
        subjectCenter: source.analysis.subjectCenter
      })),
      jobDirectory,
      job.plan,
      (progress, message) => updateJob(job, 'rendering', progress, message)
    );
    updateJob(job, 'complete', 100, 'Your first cut is ready');
  } catch (error) {
    job.error = friendlyError(error);
    updateJob(job, 'failed', job.progress, 'The edit could not be completed');
    console.error(`[job ${job.id}]`, error);
  }
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite' });
});

app.post('/api/edits', upload.array('videos', 12), async (request, response) => {
  const uploaded = (request.files || []) as Express.Multer.File[];
  const prompt = typeof request.body.prompt === 'string' ? request.body.prompt.trim() : '';
  const validAspectRatios = new Set(['9:16', '16:9', '1:1', 'original']);
  const rawAspectRatio = typeof request.body.aspectRatio === 'string' ? request.body.aspectRatio.trim() : '';
  const aspectRatio = (validAspectRatios.has(rawAspectRatio) ? rawAspectRatio : '9:16') as '9:16' | '16:9' | '1:1' | 'original';

  if (!uploaded.length) return response.status(400).json({ error: 'At least one video file is required.' });

  const invalid = uploaded.find((file) => {
    const extension = path.extname(file.originalname).toLowerCase();
    return !allowedExtensions.has(extension) && !file.mimetype.startsWith('video/');
  });
  if (invalid) {
    await Promise.all(uploaded.map((file) => rm(file.path, { force: true })));
    return response.status(415).json({ error: 'Use an MP4, MOV, WebM, MKV, M4V, or AVI video.' });
  }
  if (!prompt || prompt.length > 2000) {
    await Promise.all(uploaded.map((file) => rm(file.path, { force: true })));
    return response.status(400).json({ error: 'Describe the edit in 1 to 2000 characters.' });
  }

  const id = randomUUID();
  const jobDirectory = path.join(jobsDirectory, id);
  await mkdir(jobDirectory, { recursive: true });
  const sourcePaths: string[] = [];
  for (let index = 0; index < uploaded.length; index += 1) {
    const extension = path.extname(uploaded[index].originalname).toLowerCase() || '.mp4';
    const sourcePath = path.join(jobDirectory, `source-${String(index).padStart(3, '0')}${extension}`);
    await rename(uploaded[index].path, sourcePath);
    sourcePaths.push(sourcePath);
  }

  const job: Job = {
    id,
    status: 'queued',
    progress: 2,
    message: 'Upload complete',
    sourcePaths,
    sourceNames: uploaded.map((file) => file.originalname),
    prompt,
    aspectRatio
  };
  jobs.set(id, job);
  response.status(202).json(publicJob(job));
  setImmediate(() => void processJob(job));
});

app.get('/api/edits/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'Edit not found. Jobs reset when the server restarts.' });
  response.json(publicJob(job));
});

app.get('/api/edits/:id/media/original/:index', (request, response) => {
  const job = jobs.get(request.params.id);
  const index = Number(request.params.index);
  if (!job || !Number.isInteger(index) || !job.sourcePaths[index]) {
    return response.status(404).json({ error: 'Source video not found.' });
  }
  response.sendFile(job.sourcePaths[index]);
});

app.get('/api/edits/:id/media/:kind', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'Edit not found.' });
  const mediaPath = request.params.kind === 'original' ? job.sourcePaths[0] : job.editedPath;
  if (!mediaPath) return response.status(404).json({ error: 'That video is not ready.' });
  response.sendFile(mediaPath);
});

app.get('/api/edits/:id/download', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job?.editedPath) return response.status(404).json({ error: 'The edited video is not ready.' });
  response.download(job.editedPath, `motify-${path.parse(job.sourceNames[0]).name}-edited.mp4`);
});

const webDirectory = path.join(rootDirectory, 'dist-web');
app.use(express.static(webDirectory));
app.get('/{*path}', (_request, response) => response.sendFile(path.join(webDirectory, 'index.html')));

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return response.status(413).json({ error: 'Video is larger than the 4 GB prototype limit.' });
  }
  console.error(error);
  response.status(500).json({ error: friendlyError(error) });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`Motify Clip API listening at http://127.0.0.1:${port}`);
});
