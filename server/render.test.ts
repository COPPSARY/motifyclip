import { describe, expect, it } from 'vitest';
import { buildCaptionEntries } from './render.js';
import type { EditPlan } from './types.js';

const plan: EditPlan = {
  aspectRatio: '9:16',
  clips: [
    { source: 0, start: 10, end: 15, reason: 'Hook' },
    { source: 1, start: 30, end: 34, reason: 'Payoff' }
  ],
  captions: true,
  crop: 'center',
  speed: 2,
  textOverlays: []
};

describe('buildCaptionEntries', () => {
  it('rebases source transcript timestamps into reordered, sped-up output time', () => {
    const captions = buildCaptionEntries([[
      { start: 9, end: 12, text: 'First thought' },
      { start: 20, end: 22, text: 'Removed' }
    ], [
      { start: 31, end: 33, text: 'Second thought' }
    ]], plan);

    expect(captions).toEqual([
      { start: 0, end: 1, text: 'First thought' },
      { start: 3, end: 4, text: 'Second thought' }
    ]);
  });
});
