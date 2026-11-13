// Props for the game-style weekly long-form video (16:9). No JSX: the worker imports it too.
// The video is a cold open (teasers), then rounds where the viewer guesses before a timer runs
// out, then a last reveal and the score. Every frame number is absolute (from the video's start).
import type { CaptionWord, RankItem } from './types';

// pick: which country is #1 (three options). then_now: how many countries are over or under a
// round number today, after seeing how many were long ago. how_many: how many are above a round
// number today. higher_lower: is one famous country higher or lower than another.
export type RoundKind = 'pick' | 'then_now' | 'how_many' | 'higher_lower';

export interface GameCaption { id: string; vo: string; start: number; end: number; words: CaptionWord[] }
export interface GameOption { letter: string; label: string; iso3?: string; iso2?: string }
// One of the viewer's own countries (data/countries.ts ANCHORS): a big value and a small line under it.
export interface OwnChip { iso3: string; iso2?: string; name: string; main: string; sub: string }
// A bar in the "how far ahead is #1" panel. share: its length as a part of the #1's (0 to 1).
export interface GameBar { label: string; iso2?: string; display: string; share: number; note?: string; amber?: boolean }

// Countries over or under a round number, for one year (how_many) or several (then_now).
export interface CountView {
  dir: 'above' | 'under';
  limit: number;
  verb: 'are' | 'have'; // "74 countries are under 50 years", "9 countries have more cattle than people"
  phrase: string; // as said: "under 50 years", "above $20,000", "more cattle than people"
  short: string; // as shown: "under 50 years", "above $20,000", "with more cattle than people"
  years: number[]; // oldest first; the last one is today's
  maps: Record<string, number>[]; // one per year, the same countries in each
  counts: number[];
  of: number; // how many countries are counted
}

// Which panel is on the right from which frame (the last one whose `from` has passed).
export interface Phase { key: 'ask' | 'ladder' | 'own' | 'compare' | 'extremes'; from: number }

export interface GameRound {
  n: number; // 1-based, as said in the video
  kind: RoundKind;
  tag: string; // "PICK THE #1"
  title: string;
  yearText: string;
  unit: string; // the map's key: "dollars per person"
  valueUnit: string; // after a shown value: "per person" ($137,782), "of seats" (61%), "cattle per person" (2.80)
  sourceLine: string;
  countries: number;
  question: string; // on the right panel
  options: GameOption[];
  answer: number; // index into options
  pointText: [string, string]; // two lines beside the "+1": "point if you said", "Luxembourg"
  map: Record<string, number>; // today's values
  top: RankItem[]; // ranks 1 to 5
  own: OwnChip[];
  ownTitle: string;
  ownNamed: string[]; // the own countries the voice names, in order (cue own.0, own.1)
  bars?: GameBar[]; // pick: #1 against the middle country and the lowest
  lowIso?: string; // pick: the lowest country, when the voice names it
  count?: CountView; // then_now, how_many
  extremes?: { high: RankItem; low?: RankItem }; // then_now: today's highest and lowest
  duel?: { ref: RankItem; target: RankItem; higher: boolean }; // higher_lower
  start: number;
  end: number;
  phases: Phase[];
  // Named frames: every spoken line by its id (ask, opts, then, reveal, point, ladder, own, compare,
  // extremes), plus timer, lapse (then_now) and the words inside lines (opt.0, ladder.2, own.0 ...).
  cue: Record<string, number>;
}

// One card of the cold open. `round` is the round whose map is behind it (0-based).
export interface Teaser {
  kind: 'rank' | 'gap' | 'count' | 'promise' | 'rules' | 'intro';
  headline: [string, string, string]; // before, the amber part, after
  round?: number;
  rank?: { iso3: string; row: RankItem; top: number; panelTitle: string };
  gap?: { high: string; low: string; badge: string; panelTitle: string };
  count?: { year: number; n: number; phrase: string; panelTitle: string };
  promise?: { cards: number; lines: [string, string] };
  rules?: { big: string; small: string }[];
  start: number;
  cue: Record<string, number>; // line: its voice starts. hit: its main number or word. cards, rule.0..2
}

// A country in the top ten on the most maps: the last reveal.
export interface Champion { iso3: string; iso2?: string; name: string; maps: { title: string; rank: number }[] }

export interface GameProps {
  durationInFrames: number;
  handle: string;
  themeName: string;
  timer: number; // frames the guess timer runs
  lines: GameCaption[];
  teasers: Teaser[];
  rounds: GameRound[];
  ending: {
    start: number;
    cue: Record<string, number>; // final, final.cards, final.hit, reveal, champ.0.., score, score.ask
    champions: Champion[]; // empty: the video ends on the score alone
    times: number; // how many maps each champion is top ten on
  };
}
