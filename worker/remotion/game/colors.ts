// Map colours for the game video. No JSX.
import { C } from '../theme';
import type { CountView } from '../game-types';

// A counted country before it lights up: darker than any blue on the scale.
export const DEEP = '#12334b';

// Six shades of blue by rank, as in the Shorts and the classic long-form. `order` is each
// country's place from lowest (0) to highest (1), for the fill-in sweep.
export function quantiles(map: Record<string, number>): { colors: Record<string, string>; order: Record<string, number> } {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  const colors: Record<string, string> = {};
  const order: Record<string, number> = {};
  entries.forEach(([iso], i) => {
    colors[iso] = C.blues[Math.min(C.blues.length - 1, Math.floor((i / entries.length) * C.blues.length))];
    order[iso] = i / entries.length;
  });
  return { colors, order };
}

// One fixed scale for every year of a count, so the map itself changes as the years run. The
// countries on the counted side of the line are amber; the others are blue by where their value
// sits among all the uncounted values of all the years (brighter = more).
export function countScale(count: CountView): { counted: (v: number) => boolean; shade: (v: number) => string } {
  const counted = (v: number) => (count.dir === 'above' ? v > count.limit : v < count.limit);
  const rest = count.maps.flatMap((m) => Object.values(m)).filter((v) => !counted(v)).sort((a, b) => a - b);
  const cuts = [1, 2, 3, 4, 5].map((k) => rest[Math.min(rest.length - 1, Math.floor((k / 6) * rest.length))] ?? Infinity);
  return { counted, shade: (v) => C.blues[cuts.filter((c) => v >= c).length] };
}

// The counted countries of one year in the order they light up: the furthest from the line first.
export function waveOrder(map: Record<string, number>, count: CountView): string[] {
  const { counted } = countScale(count);
  return Object.entries(map).filter(([, v]) => counted(v)).sort((a, b) => (count.dir === 'under' ? a[1] - b[1] : b[1] - a[1])).map(([iso]) => iso);
}
