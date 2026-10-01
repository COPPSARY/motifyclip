import { z } from 'zod';

export const editPlanSchema = z.object({
  aspectRatio: z.enum(['9:16', '16:9', '1:1', 'original']),
  clips: z.array(z.object({
    source: z.number().int().nonnegative(),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    reason: z.string().min(1).max(240),
    punch: z.boolean().optional()
  })).min(1).max(100),
  captions: z.boolean(),
  crop: z.enum(['center', 'speaker', 'smart']),
  speed: z.number().finite().min(0.5).max(2),
  textOverlays: z.array(z.object({
    text: z.string().min(1).max(160),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    position: z.enum(['top', 'center', 'bottom']),
    style: z.enum(['title', 'keyword', 'lowerThird']),
    color: z.enum(['white', 'lime', 'pink', 'yellow'])
  })).max(20)
}).strict();

export type EditPlan = z.infer<typeof editPlanSchema>;

export type Scene = { index: number; start: number; end: number };
export type Silence = { start: number; end: number; duration: number };
export type TranscriptSegment = { start: number; end: number; text: string };

export type Analysis = {
  scenes: Scene[];
  transcript: TranscriptSegment[];
  language: string | null;
  subjectCenter?: number;
  silences?: Silence[];
};

export type MediaInfo = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
};

export type JobStatus = 'queued' | 'analyzing' | 'directing' | 'rendering' | 'complete' | 'failed';

export type Job = {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  sourcePaths: string[];
  editedPath?: string;
  sourceNames: string[];
  prompt: string;
  aspectRatio?: '9:16' | '16:9' | '1:1' | 'original';
  plan?: EditPlan;
  error?: string;
};
