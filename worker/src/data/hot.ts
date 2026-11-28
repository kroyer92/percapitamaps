// The argue-about topic class (hot.ts, from 28 Nov 2026). Every other Short asks a question
// viewers already have a feeling about (their money, things they buy, their country against a
// rival) instead of a plain indicator ranking. These are the first ones, queued at start-up; the
// daily idea finder adds more from the weekly scan of winning map Shorts (scan.ts).
//
// Every number still comes from the World Bank or Our World in Data (facts.ts). The two datasets
// below each carry one outside number, written into the title like the GTA VI ones (data/pinned.ts),
// with its source in the description note.
import type { CatalogEntry } from './catalog.js';
import type { Format } from '../config.js';

const WB = 'World Bank WDI';
const WB_LIC = 'CC BY 4.0';

// iPhone 17: $799 US starting price (Apple, 9 Sep 2025, MacRumors price table).
const IPHONE_PRICE = 799;
// Cristiano Ronaldo: an estimated $300 million earned 1 May 2025 - 1 May 2026, before taxes and
// fees (Forbes, The World's Highest-Paid Athletes 2026, 22 May 2026).
const RONALDO_PAY = 300e6;

export const HOT_DATASETS: CatalogEntry[] = [
  {
    id: 'hot_iphone_days',
    title: 'Days of average income to buy an iPhone 17 at the US price of $799',
    unit: 'days of average income',
    topic: 'money',
    grp: 'price_in_days',
    ref: { kind: 'reciprocal', of: { kind: 'worldbank', indicator: 'NY.GNP.PCAP.CD' }, mult: IPHONE_PRICE * 365 },
    sourceName: WB,
    license: WB_LIC,
    decimals: 1,
    suffix: ' days',
    threshold: { value: 30, label: 'an iPhone costing a month of income or more' },
    pinned: true, // kept away from the plain idea finder; the hot finder may use it
    note: 'Income: GNI per person, Atlas method, in US dollars. Uses the US starting price of $799 (Apple, Sept 2025) for every country; stores charge different prices in some countries. iPhone is a trademark of Apple Inc. This channel is not affiliated with Apple.',
  },
  {
    id: 'hot_ronaldo_years',
    title: "Years of average income it takes to earn Cristiano Ronaldo's $300 million year",
    unit: 'years of average income',
    topic: 'money',
    grp: 'price_in_days',
    ref: { kind: 'reciprocal', of: { kind: 'worldbank', indicator: 'NY.GNP.PCAP.CD' }, mult: RONALDO_PAY },
    sourceName: WB,
    license: WB_LIC,
    decimals: 0,
    suffix: ' years',
    pinned: true,
    note: "Ronaldo's pay: an estimated $300 million from 1 May 2025 to 1 May 2026, before taxes and fees (Forbes, May 2026). Income: GNI per person, Atlas method, in US dollars. This channel is not affiliated with Cristiano Ronaldo or Forbes.",
  },
];

// A question shows in full as the hook's headline only at 9 words or fewer (content.ts).
export interface HotTopic { key: string; dataset: string; format: Format; question: string; twist: string }

// In the order they should go out (one every other video).
export const HOT_TOPICS: HotTopic[] = [
  { key: 'hot_richer_than_us', dataset: 'wb_gdp_pc_ppp', format: 'MAP_REVEAL', question: 'The only countries richer than America per person', twist: 'Only a handful of small countries beat the US on income per person, adjusted for prices; Americans rarely guess which.' },
  { key: 'hot_tourists_outnumber', dataset: 'wb_tourists_per_resident', format: 'MAP_REVEAL', question: 'Every country where tourists outnumber the locals', twist: 'Some countries get many times more tourists than they have residents, and the #1 is not France or Spain.' },
  { key: 'hot_iphone', dataset: 'hot_iphone_days', format: 'MAP_REVEAL', question: 'Where an iPhone costs the most days of work', twist: 'An iPhone is a few days of income in rich countries and over a year in others.' },
  { key: 'hot_pricier_than_us', dataset: 'wb_price_level', format: 'MAP_REVEAL', question: 'Where is life even pricier than in America?', twist: 'Americans think the US is the most expensive place; a group of countries charges more for the same things.' },
  { key: 'hot_cows', dataset: 'owid_cattle_pc', format: 'GUESS', question: 'Every country with more cows than people', twist: 'A few countries have more cattle than humans, and the #1 surprises almost everyone.' },
  { key: 'hot_ronaldo', dataset: 'hot_ronaldo_years', format: 'MAP_REVEAL', question: "How many years to earn Ronaldo's one year?", twist: "Ronaldo's one year of pay is decades of income in rich countries and thousands of years in others." },
  { key: 'hot_work_hours', dataset: 'owid_working_hours', format: 'MAP_REVEAL', question: 'Think Americans work too much? Look at these countries', twist: 'Americans work long hours for a rich country, but people in several countries work hundreds of hours more each year.' },
  { key: 'hot_ev', dataset: 'owid_ev_share', format: 'GUESS', question: 'Where almost every new car is now electric', twist: 'In one country nearly every new car sold is electric, while in the US it is still a small share.' },
];
