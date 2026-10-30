export type Format = 'MAP_REVEAL' | 'COUNTDOWN' | 'THEN_NOW' | 'SCALE' | 'GUESS';

export interface CaptionWord { text: string; start: number; end: number } // frames
export interface TimedBeat {
  start: number; // frame where the beat's visual starts
  voStart: number; // frame where its voiceover starts
  end: number;
  vo: string;
  on_screen: string;
  visual: string;
  words: CaptionWord[];
}

export interface RankItem { rank: number; iso3: string; iso2?: string; name: string; value: number; display: string }

// The Map Reveal opening test (from 2 Nov 2026). A rank strip video opens on one famous country,
// zoomed in, with its rank ("America? Only 6th richest."); its badge then flies into a strip of
// slots #1 to #5 at the top, where #1 stays a "?" until the reveal. Without it: the classic opening.
export interface Opening { kind: 'rank_strip'; iso: string; rank: number }

export interface ShortProps {
  format: Format;
  durationInFrames: number;
  kicker: string; // e.g. "SHEEP PER PERSON · 2023"
  beats: TimedBeat[];
  ranking: RankItem[]; // top of the ranking (up to 15) plus anchors
  map: Record<string, number>;
  highlightIso?: string; // the twist country
  threshold?: { value: number; label: string };
  unit?: string; // e.g. "cattle per person", shown on the map key
  series?: { years: number[]; countries: { iso3: string; iso2?: string; name: string; values: (number | null)[] }[]; decimals: number; prefix: string; suffix: string };
  scale?: { groups: { name: string; iso2?: string; people: number }[]; per: string };
  guess?: { options: { letter: string; iso3: string; iso2?: string; name: string; display: string }[]; answer: string };
  opening?: Opening & { label: string }; // label: what is ranked, under the country's rank
  sourceLine: string;
  handle: string;
}
