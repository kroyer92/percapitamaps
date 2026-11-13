// Plans the weekly long-form video: picks the theme from how the Shorts did, picks 8 to 10 of its
// datasets, and writes every line from the data. No language model is involved, so no number can
// be made up: every value said or shown comes from the facts builder, like in the Shorts.
import { HIGH_END, type CatalogEntry } from '../data/catalog.js';
import { fetchSeries, type Series } from '../data/fetch.js';
import { countryName } from '../data/countries.js';
import { buildFacts, formatValue, MIN_ABOVE_FLOOR, type Facts, type RankRow } from '../facts.js';
import type { Beat } from '../validate.js';
import { THEMES, type Theme } from './themes.js';

export type Dataset = CatalogEntry & { source_url?: string };

export interface PlannedSegment {
  n: number;
  dataset_id: string;
  facts: Facts;
  ds: Dataset;
  beats: Beat[];
  extraIsos: string[]; // countries outside the top 10 that the voice names
}

export interface LongPlan {
  theme: Theme;
  segments: PlannedSegment[];
  intro: Beat[];
  outro: Beat[];
  skipped: string[]; // datasets left out, and why
}

export const MIN_MAPS = 8;
export const MAX_MAPS = 10;

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// What the voice says for a value: the shown value, plus the unit when the value has no $ or % of
// its own ("1.4" -> "1.4 cattle per person"). Parentheses in units ("index points (0 to 1)") are
// for the screen only.
export function spoken(r: Pick<RankRow, 'display'>, ds: Pick<Dataset, 'prefix' | 'suffix' | 'unit'>): string {
  if (ds.prefix || ds.suffix) return r.display;
  return `${r.display} ${ds.unit.replace(/\s*\(.*?\)/g, '')}`;
}

// "the United States", "the UAE": how a name reads inside a sentence.
const THE = /^(United |UAE$|Netherlands$|Philippines$|Bahamas$|Gambia$|Maldives$|Czech Republic$|Dominican Republic$|Central African Republic$|Solomon Islands$|Marshall Islands$|Comoros$|Seychelles$)/;
export const inSentence = (name: string) => (THE.test(name) ? `the ${name}` : name);

export function lower(title: string): string {
  // "GDP per person" keeps its capitals; "Average height of men" -> "average height of men".
  return /^[A-Z]{2}/.test(title) ? title : title.charAt(0).toLowerCase() + title.slice(1);
}

export function namesList(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function ratio(a: number, b: number): string | undefined {
  if (!(a > 0) || !(b > 0)) return undefined;
  const r = a / b;
  if (r < 3) return undefined; // "1.6 times as much" life expectancy reads oddly
  return `${r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1).replace(/\.0$/, '')} times`;
}

// A dataset can carry a long-form segment when its #1 is clear and means "the most of" something.
export function unusable(ds: Dataset, facts: Facts): string | undefined {
  if (HIGH_END[ds.id]) return 'its #1 is the "bad" end, which a list of #1s would misread';
  if (ds.lowerIsNews) return 'its story is the bottom of the ranking';
  if (facts.ranking.length < 30) return `only ${facts.ranking.length} countries have data`;
  const tied = facts.ranking.filter((r) => r.display === facts.ranking[0].display).length;
  if (tied >= 2) return `the top ${tied} are tied at ${facts.ranking[0].display}`;
  if (facts.bottom_tie && facts.bottom_tie.above < MIN_ABOVE_FLOOR) return `only ${facts.bottom_tie.above} countries are above ${facts.bottom_tie.display}`;
  return undefined;
}

// Facts for one dataset, plus who led ten years before the latest year, among the same countries.
// The series comes along too: the game's then-and-now rounds read earlier years from it.
export async function segmentFacts(ds: Dataset): Promise<{ facts: Facts; series: Series; earlier?: { year: number; leader: string; leaderIso: string; display: string } }> {
  const [series, population] = await Promise.all([fetchSeries(ds.ref), fetchSeries({ kind: 'worldbank', indicator: 'SP.POP.TOTL' })]);
  const facts = buildFacts({ ds, series, population, format: 'MAP_REVEAL' });
  const year = facts.year - 10;
  const then = Object.keys(facts.map)
    .map((iso) => ({ iso, v: series.values.get(iso)?.get(year) }))
    .filter((r): r is { iso: string; v: number } => r.v !== undefined && isFinite(r.v))
    .sort((a, b) => b.v - a.v);
  // Only when nearly the same countries had data then; otherwise "the leader" would mean little.
  if (then.length < facts.countries_count * 0.85 || !then.length || then[0].v === then[1]?.v) return { facts, series };
  const top = then[0];
  return { facts, series, earlier: { year, leader: countryName(top.iso, series.names.get(top.iso)), leaderIso: top.iso, display: formatValue(top.v, ds) } };
}

// The lines of one map. Variants rotate with the map's number, so ten maps don't all sound alike.
export function segmentBeats(n: number, total: number, ds: Dataset, facts: Facts, earlier?: { year: number; leader: string; leaderIso: string; display: string }): { beats: Beat[]; extraIsos: string[] } {
  const v = (alts: string[]) => alts[n % alts.length];
  const r = facts.ranking;
  const top = r.slice(0, 10);
  const first = top[0];
  const what = lower(facts.title);
  const beats: Beat[] = [];
  const extraIsos: string[] = [];
  const last = n === total;

  beats.push({
    vo: last ? `And the last map, map ${n}: ${what}.` : v([`Map ${n}: ${what}.`, `On to map ${n}: ${what}.`, `Map ${n} is ${what}.`]),
    on_screen: facts.title, visual: 'title',
  });
  const tie = facts.bottom_tie;
  beats.push(tie?.median_at_floor ? {
    // Most countries share the lowest value, so "half are below 0%" would say nothing.
    vo: tie.none
      ? v([`Brighter blue means more. Only ${tie.above} of ${tie.of} countries have any at all.`, `Here is the whole world. Just ${tie.above} of ${tie.of} countries have any.`])
      : v([`Brighter blue means more. Only ${tie.above} of ${tie.of} countries are above ${tie.display}.`]),
    on_screen: tie.none ? `Only ${tie.above} of ${tie.of} countries have any` : `Only ${tie.above} of ${tie.of} above ${tie.display}`, visual: 'map_fill',
  } : {
    vo: v([
      `Brighter blue means more. Half of all ${facts.countries_count} countries are below ${facts.world_median}.`,
      `The brighter the blue, the higher the number. The middle country sits at ${facts.world_median}.`,
      `Here is the whole world, ${facts.countries_count} countries. Half of them are below ${facts.world_median}.`,
    ]),
    on_screen: `Half of all countries: below ${facts.world_median}`, visual: 'map_fill',
  });
  const tenToSix = top.slice(5, 10).reverse().map((x) => inSentence(x.name));
  if (tenToSix.length === 5) {
    beats.push({ vo: v([`Places ten to six: ${namesList(tenToSix)}.`, `From tenth to sixth: ${namesList(tenToSix)}.`]), on_screen: '', visual: 'ladder' });
  }
  for (const x of top.slice(1, 5).reverse()) {
    beats.push({
      vo: v([`${cap(ORD[x.rank])}: ${inSentence(x.name)}, at ${spoken(x, ds)}.`, `Number ${x.rank} is ${inSentence(x.name)}, with ${spoken(x, ds)}.`, `In ${ORD[x.rank]} place, ${inSentence(x.name)}: ${spoken(x, ds)}.`]),
      on_screen: `#${x.rank} ${x.name}`, visual: `highlight:${x.iso3}`,
    });
  }
  const times = ratio(first.value, Number(facts.ranking[Math.floor(r.length / 2)]?.value));
  beats.push({
    vo: `${v(['And number one', 'And at the top', 'And the number one spot'])}: ${inSentence(first.name)}, at ${spoken(first, ds)}.${times ? ` That's ${times} the middle country.` : ''}`,
    on_screen: `#1 ${first.name}`, visual: 'reveal_answer',
  });

  // Extra facts: what the Short didn't have room for.
  if (facts.threshold && Number(facts.threshold.count) > 0 && Number(facts.threshold.count) < r.length) {
    const c = Number(facts.threshold.count);
    beats.push({
      vo: c === 1 ? `Only one country has ${facts.threshold.label}: ${inSentence(first.name)}.` : `${cap(c <= 10 ? NUM_WORD[c] : String(c))} countries have ${facts.threshold.label}.`,
      on_screen: `${c} ${c === 1 ? 'country has' : 'countries have'} ${facts.threshold.label}`, visual: 'threshold',
    });
  }
  // A country inside the shared lowest value has no real rank ("number 87" of 100 countries at 0%).
  const inTie = (iso: string) => !!tie && r.find((x) => x.iso3 === iso)?.display === tie.display;
  const anchorIso = ['USA', 'GBR', 'DEU', 'IND'].find((iso) => facts.anchors[iso] && !top.some((t) => t.iso3 === iso) && !inTie(iso));
  if (anchorIso) {
    const a = facts.anchors[anchorIso];
    const row = r.find((x) => x.iso3 === anchorIso)!;
    beats.push({
      vo: v([`${cap(inSentence(a.name))}? Number ${a.rank} of ${a.of}, at ${spoken(row, ds)}.`, `And ${inSentence(a.name)}? It's ${ordinal(Number(a.rank))} out of ${a.of}, with ${spoken(row, ds)}.`]),
      on_screen: `${a.name}: #${a.rank} of ${a.of}`, visual: `fact:${anchorIso}`,
    });
    extraIsos.push(anchorIso);
  }
  // The two biggest countries by population, where viewers often come from.
  const giants = ['CHN', 'IND'].filter((iso) => iso !== anchorIso && !top.some((t) => t.iso3 === iso) && !inTie(iso)).map((iso) => r.find((x) => x.iso3 === iso)).filter((x): x is RankRow => !!x);
  if (giants.length === 2) {
    beats.push({
      vo: `The two biggest countries? ${giants[0].name} is ${ordinal(giants[0].rank)}, at ${spoken(giants[0], ds)}, and ${giants[1].name} is ${ordinal(giants[1].rank)}, at ${spoken(giants[1], ds)}.`,
      on_screen: `${giants[0].name} #${giants[0].rank} · ${giants[1].name} #${giants[1].rank}`, visual: `fact:${giants[0].iso3}`,
    });
    extraIsos.push(giants[0].iso3);
  }
  if (earlier) {
    const same = earlier.leaderIso === first.iso3;
    beats.push({
      vo: same
        ? `Ten years earlier, in ${earlier.year}, ${inSentence(first.name)} was already on top.`
        : `Ten years earlier, in ${earlier.year}, the top spot belonged to ${inSentence(earlier.leader)}, at ${spoken({ display: earlier.display }, ds)}.`,
      // "then": the card shows the earlier value itself, never today's.
      on_screen: same ? `${earlier.year}: #1 ${first.name} too` : `${earlier.year}: #1 ${earlier.leader}, ${earlier.display}`, visual: `then:${same ? first.iso3 : earlier.leaderIso}`,
    });
  }
  const bottom = r[r.length - 1];
  const gap = ratio(first.value, bottom.value);
  if (tie) {
    // Several countries share the lowest value: none of them is "last", so count them instead.
    beats.push({
      vo: tie.none
        ? v([`At the other end, ${tie.count} countries have none at all.`, `And ${tie.count} countries have none at all.`])
        : `At the other end, ${tie.count} countries are tied at ${spoken({ display: tie.display }, ds)}.`,
      on_screen: tie.none ? `${tie.count} countries: none at all` : `${tie.count} countries tied at ${tie.display}`, visual: 'map_fill',
    });
  } else if (bottom && bottom.iso3 !== first.iso3) {
    beats.push({
      vo: `${v(['At the other end', 'At the very bottom', 'And last'])}: ${inSentence(bottom.name)}, at ${spoken(bottom, ds)}.${gap ? ` Number one has ${gap} as much.` : ''}`,
      on_screen: `Last: ${bottom.name}`, visual: `fact:${bottom.iso3}`,
    });
    extraIsos.push(bottom.iso3);
  }
  return { beats, extraIsos: [...new Set(extraIsos)] };
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "third", or "number 46": the voice reads "46th" less reliably than "number 46".
function ordinal(k: number): string {
  return k <= 10 ? ORD[k] : `number ${k}`;
}

function sourceNames(segs: PlannedSegment[]): string {
  const names = [...new Set(segs.flatMap((s) => s.ds.sourceName.split('/').map((x) => x.trim().replace(/ WDI$/, ''))))];
  return namesList(names.slice(0, 3));
}

// Ranks the themes: the ones whose datasets earned the Shorts the most views first, with themes used
// in the last few long-form videos moved to the back (still there, so a fallback always exists).
// Without view data it goes down the list in order.
export function rankThemes(viewsByDataset: Map<string, number>, recentThemes: string[]): Theme[] {
  const score = (t: Theme) => t.datasets.reduce((s, id) => s + (viewsByDataset.get(id) ?? 0), 0);
  const ranked = [...THEMES].sort((a, b) => score(b) - score(a) || THEMES.indexOf(a) - THEMES.indexOf(b));
  return [...ranked.filter((t) => !recentThemes.includes(t.key)), ...ranked.filter((t) => recentThemes.includes(t.key))];
}

export function chooseTheme(viewsByDataset: Map<string, number>, recentThemes: string[]): Theme {
  return rankThemes(viewsByDataset, recentThemes)[0];
}

// Thrown when a theme has too few maps with good data; the caller can try the next theme.
export class TooFewMapsError extends Error {}

// Order: datasets whose Short did best first (the first map holds the most viewers), then the
// theme's own order. At most two maps per group, so ten maps are not ten kinds of GDP.
export function orderDatasets(theme: Theme, viewsByDataset: Map<string, number>): string[] {
  return theme.datasets
    .map((id, i) => ({ id, i, views: viewsByDataset.get(id) ?? -1 }))
    .sort((a, b) => b.views - a.views || a.i - b.i)
    .map((x) => x.id);
}

export interface PickedMap { ds: Dataset; facts: Facts; series: Series; earlier?: Awaited<ReturnType<typeof segmentFacts>>['earlier'] }

// Loads the theme's datasets in order and keeps the first `want` that can carry a map. Shared by
// the classic long-form and the game (game.ts).
export async function pickMaps(opts: {
  theme: Theme;
  viewsByDataset: Map<string, number>;
  lookup: (id: string) => Promise<Dataset | undefined>; // undefined = disabled or unknown
  want: number;
  min: number;
  onStep?: (s: string) => void;
  skip?: (p: PickedMap) => string | undefined; // a style's own reason to leave a map out (game.ts)
}): Promise<{ picked: PickedMap[]; skipped: string[] }> {
  const picked: PickedMap[] = [];
  const skipped: string[] = [];
  const groups = new Map<string, number>();
  for (const id of orderDatasets(opts.theme, opts.viewsByDataset)) {
    if (picked.length >= opts.want) break;
    const ds = await opts.lookup(id);
    if (!ds) { skipped.push(`${id}: disabled or not in the catalog`); continue; }
    const g = ds.grp ?? ds.id;
    if ((groups.get(g) ?? 0) >= 2) { skipped.push(`${id}: two maps from "${g}" already`); continue; }
    opts.onStep?.(`Loading ${ds.title}`);
    try {
      const { facts, series, earlier } = await segmentFacts(ds);
      const why = unusable(ds, facts) ?? opts.skip?.({ ds, facts, series, earlier });
      if (why) { skipped.push(`${id}: ${why}`); continue; }
      picked.push({ ds, facts, series, earlier });
      groups.set(g, (groups.get(g) ?? 0) + 1);
    } catch (e: any) {
      skipped.push(`${id}: ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  if (picked.length < opts.min) throw new TooFewMapsError(`Only ${picked.length} usable maps for "${opts.theme.name}" (need ${opts.min}). ${skipped.join('; ')}`);
  return { picked, skipped };
}

export async function planLongform(opts: {
  theme: Theme;
  viewsByDataset: Map<string, number>;
  lookup: (id: string) => Promise<Dataset | undefined>; // undefined = disabled or unknown
  maps?: number;
  onStep?: (s: string) => void;
}): Promise<LongPlan> {
  const want = Math.max(MIN_MAPS, Math.min(MAX_MAPS, opts.maps ?? MAX_MAPS));
  const { picked, skipped } = await pickMaps({ ...opts, want, min: MIN_MAPS });

  const total = picked.length;
  const segments: PlannedSegment[] = picked.map((p, i) => {
    const { beats, extraIsos } = segmentBeats(i + 1, total, p.ds, p.facts, p.earlier);
    return { n: i + 1, dataset_id: p.ds.id, facts: p.facts, ds: p.ds, beats, extraIsos };
  });
  const totalWord = total <= 10 ? NUM_WORD[total] : String(total);
  const intro: Beat[] = [
    { vo: opts.theme.intro.replace(/^Ten maps/, `${cap(totalWord)} maps`), on_screen: `${total} maps of ${opts.theme.name.toLowerCase()}`, visual: 'intro' },
    { vo: `Every number is real, from ${sourceNames(segments)}. Let's start.`, on_screen: 'Open data · sources in the description', visual: 'intro' },
  ];
  const outro: Beat[] = [
    { vo: `That's all ${totalWord} maps. Here is every number one again.`, on_screen: 'Every #1', visual: 'outro' },
    { vo: `Which one surprised you most? Tell me in the comments.`, on_screen: opts.theme.question.replace(/\b10\b/, String(total)), visual: 'outro' },
  ];
  return { theme: opts.theme, segments, intro, outro, skipped };
}
