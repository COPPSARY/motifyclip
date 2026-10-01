import { GoogleGenAI } from '@google/genai';
import type { Analysis, EditPlan, MediaInfo } from './types.js';
import { editPlanSchema } from './types.js';

const editPlanJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    aspectRatio: {
      type: 'string',
      enum: ['9:16', '16:9', '1:1', 'original'],
      description: 'Final video aspect ratio. Follow the user request; otherwise preserve original.'
    },
    clips: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'integer', minimum: 0, description: 'Zero-based source video index.' },
          start: { type: 'number', minimum: 0, description: 'Start time within that source video, in seconds.' },
          end: { type: 'number', minimum: 0, description: 'Source-video end time in seconds.' },
          reason: { type: 'string', description: 'Concise editorial reason for selecting this clip.' },
          punch: { type: 'boolean', description: 'Optional subtle punch-in zoom for emphasis on a key insight.' }
        },
        required: ['source', 'start', 'end', 'reason']
      }
    },
    captions: { type: 'boolean', description: 'Whether to burn transcript captions into the output.' },
    crop: { type: 'string', enum: ['center', 'speaker', 'smart'], description: 'Framing style. Use "smart" or "speaker" for vertical videos to center the speaker.' },
    speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Global playback speed.' },
    textOverlays: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          start: { type: 'number', minimum: 0, description: 'Start in the final edited timeline, in seconds.' },
          end: { type: 'number', minimum: 0, description: 'End in the final edited timeline, in seconds.' },
          position: { type: 'string', enum: ['top', 'center', 'bottom'] },
          style: { type: 'string', enum: ['title', 'keyword', 'lowerThird'] },
          color: { type: 'string', enum: ['white', 'lime', 'pink', 'yellow'] }
        },
        required: ['text', 'start', 'end', 'position', 'style', 'color']
      }
    }
  },
  required: ['aspectRatio', 'clips', 'captions', 'crop', 'speed', 'textOverlays']
} as const;

type DirectorSource = { name: string; media: MediaInfo; analysis: Analysis };

function requestedDuration(prompt: string) {
  const match = prompt.match(/\b(\d+(?:\.\d+)?)\s*(?:-|\s)?(?:seconds?|secs?|s)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 3 && value <= 3600 ? value : null;
}

function normalizePlan(plan: EditPlan, sources: DirectorSource[], userPrompt: string, targetAspectRatio?: string): EditPlan {
  if (targetAspectRatio && ['9:16', '16:9', '1:1', 'original'].includes(targetAspectRatio)) {
    plan.aspectRatio = targetAspectRatio as EditPlan['aspectRatio'];
  }
  let clips = plan.clips
    .filter((clip) => clip.source < sources.length)
    .map((clip) => {
      const duration = sources[clip.source].media.duration;
      return {
        ...clip,
        start: Math.max(0, Math.min(duration, clip.start)),
        end: Math.max(0, Math.min(duration, clip.end))
      };
    })
    .filter((clip) => clip.end - clip.start >= 0.15);

  if (!clips.length) throw new Error('Gemini returned an edit plan without any usable clips.');
  const targetDuration = requestedDuration(userPrompt);
  const fullDuration = clips.reduce((total, clip) => total + (clip.end - clip.start) / plan.speed, 0);
  if (targetDuration && fullDuration > targetDuration * 1.12 && clips.length > 1) {
    let cumulative = 0;
    const candidates = clips.map((clip, index) => {
      cumulative += (clip.end - clip.start) / plan.speed;
      return { count: index + 1, duration: cumulative };
    }).filter((candidate) => candidate.duration >= targetDuration * 0.65);
    const closest = candidates.sort((a, b) =>
      Math.abs(a.duration - targetDuration) - Math.abs(b.duration - targetDuration)
    )[0];
    if (closest) clips = clips.slice(0, closest.count);
  }
  const outputDuration = clips.reduce((total, clip) => total + (clip.end - clip.start) / plan.speed, 0);
  const textOverlays = plan.textOverlays.flatMap((overlay) => {
    const start = Math.max(0, Math.min(outputDuration, overlay.start));
    const requestedDuration = Math.max(0.35, overlay.end - overlay.start);
    const maxDuration = overlay.style === 'title' ? 3.5 : overlay.style === 'keyword' ? 1.8 : 3.0;
    const end = Math.min(outputDuration, start + Math.min(requestedDuration, maxDuration));
    if (end - start < 0.3 || !overlay.text.trim()) return [];
    return [{ ...overlay, text: overlay.text.trim().slice(0, 80), start, end }];
  });
  return { ...plan, clips, textOverlays };
}

export async function createEditPlan(
  userPrompt: string,
  sources: DirectorSource[],
  targetAspectRatio?: '9:16' | '16:9' | '1:1' | 'original'
): Promise<EditPlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and add a Gemini API key.');

  const client = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const input = `You are the editor/director for a practical automated video editor.

Decide what the finished edit should be. Do not explain how to run FFmpeg and do not manipulate media. Return only the requested structured edit plan.

Editorial rules:
- Obey the user's intent, requested platform, tone, pacing, and approximate duration.
- MANDATORY ASPECT RATIO: ${targetAspectRatio ? `The user has explicitly selected "${targetAspectRatio}". You MUST set aspectRatio to "${targetAspectRatio}".` : 'Follow the user request; otherwise preserve original.'}
- MULTIPLE SOURCES SEQUENCING: When multiple source clips are provided (Source 0, Source 1, ...), combine them SEQUENTIALLY into ONE cohesive finished video. Select the strongest moments from Source 0, transition to Source 1, then Source 2. Combine them into a unified story arc.
- Prioritize complete thoughts, strong hooks, useful information, and coherent storytelling.
- ELIMINATE DEAD AIR, FILLERS, AND AWKWARD MOMENTS: Look at the silence/pause intervals and transcript carefully. When speakers hesitate, repeat filler sounds ('um', 'uh', 'អឺម'), take pauses (>0.4s), or pause while thinking/rubbing their face, CUT THEM OUT! Jump-cut directly from the end of one clean phrase to the start of the next strong statement.
- Avoid cutting speakers mid-word. Transcript timing is important.
- CROP & FRAMING: Always specify "smart" or "speaker" for crop on vertical 9:16 edits so the speaker is centered in frame.
- PUNCH ZOOM: Use "punch: true" on key punchlines or when transitioning between jump cuts to give professional dynamic emphasis without jitter.
- Every clip must identify its source with a zero-based source index.
- Never use timestamps outside that source's duration.
- Match overlay language to the spoken transcript (e.g. Khmer if speech is Khmer) unless the user explicitly requests another language.
- Overlay copy must be punchy and short: usually 1-4 words. Never write a long headline that will not fit a phone screen.
- A "title" overlay creates an elegant upper-third banner hook (1-5 words). Keep it to 2-3.5 seconds at the video opening. NEVER use full-screen blackouts.
- A "keyword" overlay creates a quick accent word (0.5 to 1.5 seconds) placed in safe zones.
- Do not invent spoken content or request unsupported effects.
- Text overlay times refer to the FINAL edited timeline, not source time.
- Supported operations: cuts, joins, smart speaker crop, aspect ratio, burned captions, punch zoom, simple text overlays, audio normalization, and global speed.

USER DIRECTION:
${userPrompt}

SOURCES (each item has its own local timeline):
${JSON.stringify(sources.map((source, index) => ({
    source: index,
    name: source.name,
    media: source.media,
    scenes: source.analysis.scenes,
    silences: source.analysis.silences,
    subjectCenter: source.analysis.subjectCenter,
    transcript: source.analysis.transcript
  })), null, 2)}`;

  let interaction;
  try {
    interaction = await client.interactions.create({
      model,
      input,
      store: false,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: editPlanJsonSchema
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Gemini edit planning failed: ${detail}`, { cause: error });
  }

  const outputText = interaction.output_text;
  if (!outputText) throw new Error('Gemini returned an empty edit plan.');
  const parsed = editPlanSchema.parse(JSON.parse(outputText));
  return normalizePlan(parsed, sources, userPrompt, targetAspectRatio);
}
