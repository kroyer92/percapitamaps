// When the video recipe changed. Each video is read against the version it was made with (its
// job's created_at), so old videos still count, but a channel-wide call about what to change only
// uses videos made since the last change to their format: an old video can't judge a new recipe.
// Add a line here whenever a merged and deployed change alters how videos look or sound.
import type { Format } from './config.js';

export interface Change { at: string; label: string; formats: (Format | 'NATION')[] | 'all' }

export const CHANGES: Change[] = [
  { at: '2026-10-26T09:00:00Z', label: 'Build 1 visuals (map motion, captions, sound effects)', formats: 'all' },
  { at: '2026-10-28T15:30:00Z', label: 'Countdown and Guess upgrade', formats: ['COUNTDOWN', 'GUESS'] },
  { at: '2026-10-29T09:49:00Z', label: 'Map Reveal guess beat cut, #1 kept out of titles', formats: 'all' },
  { at: '2026-10-30T12:09:00Z', label: 'Map Reveal opening test (rank strip vs classic)', formats: ['MAP_REVEAL'] },
  { at: '2026-11-06T12:00:00Z', label: 'Per Capita Nation daily census (first version)', formats: ['NATION'] },
];

const applies = (c: Change, format: string) => c.formats === 'all' || (c.formats as string[]).includes(format);

// The last change before this video was made: the version it was made with.
export function versionOf(format: string, madeAt: Date | string): Change | null {
  const t = +new Date(madeAt);
  return [...CHANGES].reverse().find((c) => applies(c, format) && +new Date(c.at) <= t) ?? null;
}

// The newest change to this format: videos made after it show the current recipe.
export function currentVersion(format: string): Change | null {
  return [...CHANGES].reverse().find((c) => applies(c, format)) ?? null;
}

export const isCurrent = (format: string, madeAt: Date | string) => versionOf(format, madeAt) === currentVersion(format);

export const versionName = (c: Change | null) => (c ? `${c.label} (${c.at.slice(0, 10)})` : 'before 26 Oct');
