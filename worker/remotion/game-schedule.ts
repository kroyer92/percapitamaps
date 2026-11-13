// Timings shared by the game video (Remotion) and its sound effects (worker), so a card appears
// exactly when its tick plays. No JSX here: the worker imports it too.
import type { GameRound, OwnChip } from './game-types';

// The viewer's own countries in the order their chips appear, each with the frame it pops: the
// first one the voice names, then the others by rank, then the second one named.
export function ownChips(r: Pick<GameRound, 'own' | 'ownNamed' | 'cue' | 'start'>): { chip: OwnChip; at: number }[] {
  const first = r.own.find((c) => c.iso3 === r.ownNamed[0]);
  const last = r.ownNamed[1] ? r.own.find((c) => c.iso3 === r.ownNamed[1]) : undefined;
  const order = [...(first ? [first] : []), ...r.own.filter((c) => c !== first && c !== last), ...(last ? [last] : [])];
  const a = r.cue['own.0'] ?? r.cue.own ?? r.start;
  const b = last ? r.cue['own.1'] : undefined;
  return order.map((chip, i) => ({
    chip,
    at: chip === first ? a : chip === last && b !== undefined ? b : Math.max(a + 2, Math.min(a + 4 + i * 6, (b ?? Infinity) - 2)),
  }));
}

// The frames the years of a then-and-now round step on: [first year, ..., today]. The first year
// shows from the round's start; the last step lands on the answer.
export function lapseSteps(r: Pick<GameRound, 'count' | 'cue'>): number[] {
  const years = r.count?.years.length ?? 0;
  return Array.from({ length: years }, (_, k) => (k === 0 ? -Infinity : r.cue[`lapse.${k}`] ?? r.cue.reveal ?? Infinity));
}

// How many frames a count runs up over (the amber wave across the map and the number beside it).
export const COUNT_UP = 30;
