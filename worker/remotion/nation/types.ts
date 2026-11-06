// Props of the Per Capita Nation episode (worker/src/nation). Kept apart from the worker's types so
// the video bundle never pulls in server code; the census the worker passes has the same shape.
import type { TimedBeat } from '../types';

export interface NationRow { iso3: string; name: string; value: number; display: string; rank: number; us?: boolean }

export interface NationCensus {
  day: number;
  at: string;
  n: number;
  newSince: number;
  newest: { no: number; name: string; iso3: string }[];
  homelands: number;
  top: { iso3: string; name: string; count: number }[];
  citizens: Record<string, number>;
  metric: 'gdp' | 'le';
  year: number;
  avg: number | null;
  display: string | null;
  covered: number;
  rank: number | null;
  of: number;
  ladder: NationRow[];
  target: { iso3: string; name: string; pop: number; year: number } | null;
  passed: { iso3: string; name: string; pop: number } | null;
  vote: { key: string; topic: string; question: string; options: string[]; open: boolean; from: number; votes: number; min: number } | null;
  result: { key: string; answer: string; line: string; votes: number; total: number } | null;
  state: Record<string, string>;
}

export interface NationShape { w: number; h: number; paths: string[]; rings: [number, number, number][] }

export interface NationProps {
  durationInFrames: number;
  beats: TimedBeat[];
  census: NationCensus;
  iso2: Record<string, string>; // every country the episode shows
  shape: NationShape | null; // the target country's outline
  flag: [string, string] | null; // the flag colours the viewers voted for, if any
  stamp: string; // "16 Nov 19:00 UTC"
  metricLabel: string; // "income per person"
  handle: string;
}
