// Props for the weekly long-form video (16:9) and its thumbnail. No JSX: the worker imports it too.
import type { RankItem, TimedBeat } from './types';

// A beat of the long-form script. `seg` is the map it belongs to (0-based), or -1 for the intro
// and the outro. Visuals: intro, outro, title, map_fill, ladder, highlight:ISO, reveal_answer,
// threshold, fact:ISO (a country outside the top 10, outlined on the map with a card).
export interface LongBeat extends TimedBeat { seg: number }

export interface LongSegment {
  n: number; // 1-based, as said in the video
  title: string; // what is measured, e.g. "GDP per person, adjusted for prices"
  yearText: string;
  unit: string;
  map: Record<string, number>;
  top: RankItem[]; // ranks 1 to 10
  extra: RankItem[]; // other countries the voice names (an anchor, the bottom)
  threshold?: { value: number; label: string };
  sourceLine: string;
}

export interface LongformProps {
  durationInFrames: number;
  themeName: string; // "Money"
  count: number; // how many maps
  beats: LongBeat[];
  segments: LongSegment[];
  handle: string;
}

export interface ThumbProps {
  line1: string; // "10 MAPS"
  line2: string; // "OF MONEY"
  line3: string; // "WHO'S #1?"
  map: Record<string, number>;
  answerIso?: string;
}
