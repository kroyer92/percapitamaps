// A small made-up census so the Remotion studio can show the Nation composition.
import type { NationProps } from './types';

const beat = (start: number, end: number, visual: string, vo: string) => ({
  start, voStart: start, end, vo, on_screen: '', visual,
  words: vo.split(' ').map((text, i, all) => ({ text, start: start + Math.round(((end - start) * i) / all.length), end: start + Math.round(((end - start) * (i + 1)) / all.length) })),
});

export const nationSample: NationProps = {
  durationInFrames: 300,
  beats: [
    beat(0, 90, 'nation:hook', 'Day 2. This country has 12 citizens.'),
    beat(90, 180, 'nation:new', '5 new citizens moved in since yesterday. Welcome!'),
    beat(180, 300, 'nation:cta', 'Get your free passport with the link in our profile, and vote on our flag.'),
  ],
  census: {
    day: 2, at: '2026-11-17T19:00:00Z', n: 12, newSince: 5,
    newest: [{ no: 12, name: 'Anna', iso3: 'DNK' }, { no: 11, name: 'Raj', iso3: 'IND' }, { no: 10, name: 'Sam', iso3: 'USA' }],
    homelands: 3, top: [{ iso3: 'USA', name: 'United States', count: 6 }, { iso3: 'IND', name: 'India', count: 4 }, { iso3: 'DNK', name: 'Denmark', count: 2 }],
    citizens: { USA: 6, IND: 4, DNK: 2 }, metric: 'le', year: 2023, avg: 76.5, display: '76.5 years', covered: 12, rank: 100, of: 200,
    ladder: [], target: null, passed: null,
    vote: { day: 2, topic: 'our flag', question: 'What colours should our flag be?', options: ['Navy and amber', 'Red and white'] },
    result: null, state: {},
  },
  iso2: { USA: 'US', IND: 'IN', DNK: 'DK' },
  shape: null,
  flag: null,
  stamp: '17 Nov 19:00 UTC',
  metricLabel: 'life expectancy',
  handle: '@PerCapitaMaps',
};
