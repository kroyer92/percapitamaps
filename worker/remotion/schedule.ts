// Timing helpers shared by the video (Remotion) and the sound effects (worker), so a row
// appears on screen exactly when its tick plays. No JSX here: the worker imports it too.
import type { ShortProps } from './types';

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

// Frame where the voice first says this country's name (first two words of it), or -1.
function spokenAt(p: ShortProps, name: string, before: number): number {
  const want = tokens(name).filter((t) => t !== 'the').slice(0, 2);
  if (!want.length) return -1;
  const words = p.beats.flatMap((b) => b.words.flatMap((w) => tokens(w.text).map((t) => ({ t, start: w.start }))));
  for (let i = 0; i + want.length <= words.length; i++) {
    if (words[i].start >= before) break;
    if (want.every((t, j) => words[i + j].t === t)) return words[i].start;
  }
  return -1;
}

// Ranks 10 to 1 appear as the voice names them; #1 lands on the reveal beat.
// A rank that is never named falls back to even spacing.
export function countdownSchedule(p: ShortProps): number[] {
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'))?.start ?? Math.round(p.durationInFrames * 0.7);
  const first = p.beats[1]?.start ?? 30;
  const n = Math.min(10, p.ranking.length);
  const byRank = [...p.ranking.slice(0, n)].sort((a, b) => b.rank - a.rank); // #n ... #1
  const times: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const even = Math.round(first + ((reveal - 15 - first) * i) / Math.max(1, n - 2));
    const said = spokenAt(p, byRank[i].name, reveal);
    times.push(said >= 0 ? said : even);
  }
  times.push(reveal);
  return times; // times[0] reveals #10 (or #n), last reveals #1
}

// The pause's countdown: when each number appears (3, 2, 1), counted back from the reveal.
export function guessPauseTicks(p: ShortProps, fps = 30): number[] {
  const pause = p.beats.find((b) => b.visual.startsWith('pause'));
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'))?.start;
  if (!pause || reveal === undefined) return [];
  return [3, 2, 1].map((k) => reveal - k * fps).filter((t) => t >= pause.start);
}

// The rank strip opening (Map Reveal test): slots for #1 to #5 across the top, plus the opening
// country's own slot when it ranks lower. They pop in from the right as the hook ends, #1 last, a
// tick each; a slot fills when the voice gets to its country, and #1 at the reveal.
export interface StripSlot { rank: number; pop: number; fill: number }
export function stripSlots(p: ShortProps): StripSlot[] {
  const o = p.opening;
  if (!o) return [];
  const hookEnd = p.beats[1]?.start ?? 60;
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'))?.start ?? p.durationInFrames;
  const ranks = [1, 2, 3, 4, 5, ...(o.rank > 5 ? [o.rank] : [])];
  return ranks.map((rank, i) => {
    const iso = p.ranking.find((r) => r.rank === rank)?.iso3;
    const named = p.beats.find((b) => iso && b.visual === `highlight:${iso}`)?.start ?? reveal;
    return { rank, pop: hookEnd - 6 + (ranks.length - 1 - i) * 3, fill: rank === o.rank ? hookEnd + 6 : Math.min(named, reveal) };
  });
}
