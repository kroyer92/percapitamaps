// The Map Reveal opening test (from 2 Nov 2026). The classic opening shows the question over the
// whole coloured map. The rank strip opening starts on one famous country the viewer knows, zoomed
// in, with its rank ("America? Only 6th richest."); its badge then flies into a strip of slots #1
// to #5 at the top, where #1 stays a "?" until the reveal. Every other Map Reveal gets the rank
// strip (produce.ts), so both openings meet the same mix of topics; "stayed" at 72 h decides.
import { FAMOUS, type Facts, type RankRow } from './facts.js';
import { countryName } from './data/countries.js';
import type { Slot } from './plan.js';
import type { Opening } from '../remotion/types.js';

export type { Opening };

// How the voice says a famous country at the start of a sentence.
const SPOKEN: Record<string, string> = { USA: 'America', GBR: 'The UK' };
export const spokenName = (iso3: string) => SPOKEN[iso3] ?? countryName(iso3);

export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// The country the video opens on: the most famous one ranked 2nd to 15th. Never the #1, which is
// the payoff. None (a ranking without famous countries near the top) means the classic opening.
export function anchorFor(f: Facts): RankRow | undefined {
  const byIso = new Map(f.ranking.map((r) => [r.iso3, r]));
  return FAMOUS.map((iso) => byIso.get(iso)).find((r): r is RankRow => !!r && r.rank >= 2 && r.rank <= 15);
}

export function openingFor(f: Facts): Opening | undefined {
  const a = anchorFor(f);
  return a ? { kind: 'rank_strip', iso: a.iso3, rank: a.rank } : undefined;
}

const SMALL = new Set(['for', 'the', 'and', 'per', 'most', 'when', 'comes', 'with', 'which', 'country', 'countries', 'where', 'who', 'what', 'has', 'have', 'does']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !SMALL.has(w));

// The opening line. The model may add a few words for what is ranked ("richest", "for working
// hours"), so the rank means something to someone who only listens. At least one of them has to
// come from the question (or be a superlative like "richest"); anything else falls back to the
// plain line, which the badge's label explains on screen.
export function anchorHookSlot(o: Opening, question: string, f: Facts): Slot {
  const head = `${spokenName(o.iso)}? Only ${ordinal(o.rank)}`;
  const topic = new Set(words(`${question} ${f.title} ${f.unit}`).map((w) => w.slice(0, 4)));
  return {
    role: 'hook',
    brief: `The opening line, at most 6 words. Start with exactly "${head}", then add up to 3 words for what the question ranks, so the viewer knows what that place is for. Take those words from the question: "${question}". Name no other country and no other number.`,
    country: spokenName(o.iso),
    numbers: [String(o.rank)],
    fallback: `${head}.`,
    visual: 'map_fill',
    on_screen: `${head}.`,
    maxWords: 7,
    check: (line) => {
      const t = line.trim().replace(/\s+/g, ' ');
      if (!t.toLowerCase().startsWith(head.toLowerCase()) || /^[\p{L}\p{N}]/u.test(t.slice(head.length))) return `does not start with "${head}"`;
      const own = words(t.slice(head.length));
      if (own.length && !own.some((w) => topic.has(w.slice(0, 4)) || /est$/.test(w))) return 'words after the rank are not from the question';
      return undefined;
    },
  };
}
