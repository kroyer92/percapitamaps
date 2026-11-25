// Pinned Shorts: one-off topics tied to a news moment that go to the front of the queue. They are
// made as soon as the worker starts (pinned.ts), their previews come to Telegram as usual, and once
// approved each one takes the next free publishing time, ahead of everything already scheduled.
//
// Their datasets live here, not in CATALOG, so the daily idea finder, follow-ups and the weekly
// long-form never pick them up. Every number still comes from the World Bank (facts.ts); the one
// outside number of each topic is written into the dataset's title, so the script may say it.
import type { CatalogEntry } from './catalog.js';
import type { Format } from '../config.js';

const WB = 'World Bank WDI';
const WB_LIC = 'CC BY 4.0';

// GTA VI (25 Nov 2026). Launched 19 Nov 2026; Rockstar Games reported $3.79 billion in first-day
// sales; the standard edition is $79.99 in the US. Name only, as a plain fact: no footage, logos or
// game art, and the description says the channel has nothing to do with Rockstar.
const GTA_NOTE = 'Grand Theft Auto VI is a trademark of Take-Two Interactive. This channel is not affiliated with or endorsed by Rockstar Games or Take-Two.';
const GTA_DAY_ONE = 3.79e9;
const GTA_PRICE = 79.99;

export const PINNED_DATASETS: CatalogEntry[] = [
  {
    id: 'gta6_day_one_vs_gdp',
    title: "GTA 6's $3.79 billion first day, as a share of each country's yearly economy",
    unit: "percent of the country's yearly GDP",
    topic: 'money',
    grp: 'gta6',
    // first-day sales ÷ GDP × 100: over 100% means the game took in more on day one than the
    // whole country's economy produces in a year.
    ref: { kind: 'reciprocal', of: { kind: 'worldbank', indicator: 'NY.GDP.MKTP.CD' }, mult: GTA_DAY_ONE * 100 },
    sourceName: WB, // the sales figure is in the title and its source in the description note
    license: WB_LIC,
    decimals: 1,
    suffix: '%',
    threshold: { value: 100, label: "a yearly economy smaller than GTA 6's first day" },
    pinned: true,
    note: `First-day sales: $3.79 billion, as reported by Rockstar Games (Nov 2026). Economy: GDP in current US dollars. ${GTA_NOTE}`,
  },
  {
    id: 'gta6_days_of_income',
    title: 'Days of average income to buy GTA 6 at the US price of $79.99',
    unit: 'days of average income',
    topic: 'money',
    grp: 'gta6',
    // $79.99 ÷ (income per person ÷ 365). The US price everywhere: stores price it differently
    // by country, which the title and unit say.
    ref: { kind: 'reciprocal', of: { kind: 'worldbank', indicator: 'NY.GNP.PCAP.CD' }, mult: GTA_PRICE * 365 },
    sourceName: WB,
    license: WB_LIC,
    decimals: 1,
    suffix: ' days',
    pinned: true,
    note: `Income: GNI per person, Atlas method, in US dollars. Uses the US price of $79.99 for every country; the game costs a different amount in some stores. ${GTA_NOTE}`,
  },
];

export interface PinnedTopic { key: string; dataset: string; format: Format; question: string; twist: string }

// In the order they should go out.
export const PINNED_TOPICS: PinnedTopic[] = [
  {
    key: 'gta6_day_one',
    dataset: 'gta6_day_one_vs_gdp',
    format: 'MAP_REVEAL',
    question: "Which economy does GTA 6's first day dwarf the most?",
    twist: 'GTA 6 sold $3.79 billion on its first day: more than the whole yearly economy of a handful of real countries.',
  },
  {
    key: 'gta6_days_income',
    dataset: 'gta6_days_of_income',
    format: 'COUNTDOWN',
    question: 'Where does GTA 6 cost the most days of income?',
    twist: 'At the US price of $79.99, GTA 6 costs a few hours of income in rich countries and months in others.',
  },
];
