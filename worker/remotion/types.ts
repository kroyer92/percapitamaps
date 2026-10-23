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
  sourceLine: string;
  handle: string;
}
