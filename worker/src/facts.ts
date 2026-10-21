// Deterministic facts builder. Every number a video may say or show is computed here,
// formatted once, and handed to the language model as the only numbers it may use.
import type { CatalogEntry } from './data/catalog.js';
import { fetchSeries, type Series } from './data/fetch.js';
import { ANCHORS, countryName } from './data/countries.js';
import type { Format } from './config.js';

export const MIN_POPULATION = Number(process.env.MIN_POPULATION ?? 300_000);

export interface RankRow { rank: number; iso3: string; name: string; value: number; display: string }

export interface Facts {
  dataset_id: string;
  title: string;
  unit: string;
  year: number;
  countries_count: number;
  source_line: string;
  source_url: string;
  license: string;
  ranking: RankRow[];
  world_median: string;
  top_vs_median?: string;
  top_vs_usa?: string;
  anchors: Record<string, { name: string; rank: string; of: string; value: string }>;
  threshold?: { label: string; count: string; countries: string[] };
  series?: {
    years: number[];
    countries: { iso3: string; name: string; values: (number | null)[] }[];
    start_year: number;
    start_top3: string[];
    latest_top3: string[];
    start_median: string;
  };
  scale?: { groups: { name: string; iso3?: string; people: number }[]; world_total: string; per: string };
  guess?: { options: { letter: string; iso3: string; name: string }[]; answer: string };
  map: Record<string, number>;
  decimals: number;
}

export function formatValue(v: number, ds: Pick<CatalogEntry, 'decimals' | 'prefix' | 'suffix'>): string {
  const abs = Math.abs(v);
  const pre = ds.prefix ?? '';
  const suf = ds.suffix ?? '';
  let body: string;
  if (abs >= 1e12) body = `${trim(v / 1e12, 1)} trillion`;
  else if (abs >= 1e9) body = `${trim(v / 1e9, abs >= 1e11 ? 0 : 1)} billion`;
  else if (abs >= 1e6) body = `${trim(v / 1e6, abs >= 1e8 ? 0 : 1)} million`;
  else body = v.toLocaleString('en-US', { minimumFractionDigits: ds.decimals ?? 0, maximumFractionDigits: ds.decimals ?? 0 });
  return `${pre}${body}${suf}`;
}

function trim(v: number, d: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

function ratioText(a: number, b: number): string | undefined {
  if (!(b > 0) || !(a > 0)) return undefined;
  const r = a / b;
  if (r < 1.15) return undefined;
  return `${r >= 10 ? Math.round(r) : r.toFixed(1).replace(/\.0$/, '')} times`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function pickYear(values: Series['values'], allowed: Set<string>, minCountries: number): { year: number; best: number } {
  const coverage = new Map<number, number>();
  const thisYear = new Date().getUTCFullYear();
  for (const [iso, years] of values) {
    if (!allowed.has(iso)) continue;
    for (const y of years.keys()) if (y <= thisYear) coverage.set(y, (coverage.get(y) ?? 0) + 1);
  }
  const best = Math.max(0, ...coverage.values());
  if (best < minCountries) return { year: NaN, best };
  // The latest year that covers at least 85% of the best-covered year's countries.
  const floor = Math.ceil(best * 0.85);
  const years = [...coverage.entries()].filter(([, n]) => n >= floor).map(([y]) => y);
  return { year: years.length ? Math.max(...years) : NaN, best };
}

// Countries famous enough to be the "obvious guess" in a GUESS video.
const FAMOUS = ['USA', 'CHN', 'JPN', 'DEU', 'RUS', 'GBR', 'FRA', 'IND', 'BRA', 'CAN', 'AUS', 'ITA', 'MEX', 'KOR', 'SAU', 'NOR', 'CHE', 'ESP', 'NZL', 'ARG'];

export interface BuildInput {
  ds: CatalogEntry & { source_url?: string };
  series: Series;
  population: Series;
  format: Format;
}

export function buildFacts({ ds, series, population, format }: BuildInput): Facts {
  // Latest population per country, used to drop micro-territories from rankings.
  const pop = new Map<string, number>();
  for (const [iso, years] of population.values) {
    const latest = Math.max(...years.keys());
    pop.set(iso, years.get(latest)!);
  }
  const big = new Set([...pop.entries()].filter(([, p]) => p >= MIN_POPULATION).map(([iso]) => iso));
  const allowed = new Set([...series.values.keys()].filter((iso) => big.has(iso)));

  const { year } = pickYear(series.values, allowed, ds.minCountries ?? 100);
  if (!isFinite(year)) throw new Error(`No usable year for ${ds.id}`);

  const rows = [...allowed]
    .map((iso) => ({ iso, v: series.values.get(iso)!.get(year) }))
    .filter((r): r is { iso: string; v: number } => r.v !== undefined && isFinite(r.v))
    .sort((a, b) => b.v - a.v);
  const ranking: RankRow[] = rows.map((r, i) => ({
    rank: i + 1,
    iso3: r.iso,
    name: countryName(r.iso, series.names.get(r.iso)),
    value: r.v,
    display: formatValue(r.v, ds),
  }));
  const n = ranking.length;
  const med = median(ranking.map((r) => r.value));
  const usa = ranking.find((r) => r.iso3 === 'USA');

  const anchors: Facts['anchors'] = {};
  for (const iso of ANCHORS) {
    const r = ranking.find((x) => x.iso3 === iso);
    if (r) anchors[iso] = { name: r.name, rank: String(r.rank), of: String(n), value: r.display };
  }

  const facts: Facts = {
    dataset_id: ds.id,
    title: ds.title,
    unit: ds.unit,
    year,
    countries_count: n,
    source_line: `Data: ${ds.sourceName}, ${year}, ${ds.license}`,
    source_url: ds.source_url ?? series.url,
    license: ds.license,
    ranking,
    world_median: formatValue(med, ds),
    top_vs_median: ranking[0] ? ratioText(ranking[0].value, med) : undefined,
    top_vs_usa: ranking[0] && usa && ranking[0].iso3 !== 'USA' ? ratioText(ranking[0].value, usa.value) : undefined,
    anchors,
    map: Object.fromEntries(ranking.map((r) => [r.iso3, r.value])),
    decimals: ds.decimals ?? 0,
  };

  if (ds.threshold) {
    const above = ranking.filter((r) => r.value > ds.threshold!.value);
    facts.threshold = { label: ds.threshold.label, count: String(above.length), countries: above.map((r) => r.name) };
  }

  if (format === 'THEN_NOW') facts.series = buildSeries(series, allowed, year, ds);
  if (format === 'SCALE') facts.scale = buildScale(ranking, ds);
  if (format === 'GUESS') facts.guess = buildGuess(ranking);
  return facts;
}

function buildSeries(series: Series, allowed: Set<string>, latest: number, ds: CatalogEntry): Facts['series'] {
  // Start at the earliest year where at least 60% of today's countries have data.
  const latestCount = [...allowed].filter((iso) => series.values.get(iso)?.has(latest)).length;
  const counts = new Map<number, number>();
  for (const iso of allowed) for (const y of series.values.get(iso)?.keys() ?? []) counts.set(y, (counts.get(y) ?? 0) + 1);
  const candidates = [...counts.entries()].filter(([y, c]) => c >= latestCount * 0.6 && y <= latest - 15).map(([y]) => y);
  const start = candidates.length ? Math.min(...candidates) : Math.min(...counts.keys());
  const years: number[] = [];
  const step = latest - start > 120 ? 5 : 1;
  for (let y = start; y <= latest; y += step) years.push(y);
  if (years[years.length - 1] !== latest) years.push(latest);

  const valueAt = (iso: string, y: number): number | null => {
    const m = series.values.get(iso);
    if (!m) return null;
    if (m.has(y)) return m.get(y)!;
    // Linear interpolation between the nearest known years.
    let lo: number | undefined, hi: number | undefined;
    for (const k of m.keys()) {
      if (k < y && (lo === undefined || k > lo)) lo = k;
      if (k > y && (hi === undefined || k < hi)) hi = k;
    }
    if (lo === undefined || hi === undefined) return null;
    const t = (y - lo) / (hi - lo);
    return m.get(lo)! + t * (m.get(hi)! - m.get(lo)!);
  };

  const inRace = new Set<string>();
  for (const y of years) {
    [...allowed]
      .map((iso) => ({ iso, v: valueAt(iso, y) }))
      .filter((r): r is { iso: string; v: number } => r.v !== null)
      .sort((a, b) => b.v - a.v)
      .slice(0, 8)
      .forEach((r) => inRace.add(r.iso));
  }
  const top3At = (y: number) =>
    [...allowed]
      .map((iso) => ({ iso, v: series.values.get(iso)?.get(y) }))
      .filter((r): r is { iso: string; v: number } => r.v !== undefined)
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map((r) => `${countryName(r.iso, series.names.get(r.iso))}: ${formatValue(r.v, ds)}`);
  const startVals = [...allowed].map((iso) => series.values.get(iso)?.get(start)).filter((v): v is number => v !== undefined);

  return {
    years,
    countries: [...inRace].map((iso) => ({
      iso3: iso,
      name: countryName(iso, series.names.get(iso)),
      values: years.map((y) => valueAt(iso, y)),
    })),
    start_year: start,
    start_top3: top3At(start),
    latest_top3: top3At(latest),
    start_median: startVals.length ? formatValue(median(startVals), ds) : 'n/a',
  };
}

function buildScale(ranking: RankRow[], ds: CatalogEntry): Facts['scale'] {
  const total = ranking.reduce((s, r) => s + Math.max(0, r.value), 0);
  const top = ranking.slice(0, 5);
  const shares = top.map((r) => (r.value / total) * 100);
  const restShare = 100 - shares.reduce((a, b) => a + b, 0);
  // Largest-remainder rounding so the groups add up to exactly 100.
  const all = [...shares, restShare];
  const floors = all.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = all.map((s, i) => ({ i, r: s - Math.floor(s) })).sort((a, b) => b.r - a.r);
  for (const o of order) { if (left <= 0) break; floors[o.i]++; left--; }
  const groups = top.map((r, i) => ({ name: r.name, iso3: r.iso3, people: floors[i] })).filter((g) => g.people > 0);
  groups.push({ name: 'Rest of the world', iso3: undefined as any, people: floors[floors.length - 1] });
  return { groups, world_total: formatValue(total, { ...ds, decimals: 0 }), per: `of every 100 ${ds.id === 'wb_population' || ds.id === 'owid_population_long' ? 'people' : 'units'}` };
}

function buildGuess(ranking: RankRow[]): Facts['guess'] {
  const answer = ranking[0];
  const decoys = FAMOUS.filter((iso) => iso !== answer.iso3)
    .map((iso) => ranking.find((r) => r.iso3 === iso))
    .filter((r): r is RankRow => !!r)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 2);
  while (decoys.length < 2) {
    const next = ranking.find((r) => r.iso3 !== answer.iso3 && !decoys.includes(r));
    if (!next) break;
    decoys.push(next);
  }
  // Put the answer in a position that depends on the data, not always the same letter.
  const slot = answer.value.toString().length % 3;
  const opts = [...decoys];
  opts.splice(slot, 0, answer);
  const letters = ['A', 'B', 'C'];
  return {
    options: opts.map((r, i) => ({ letter: letters[i], iso3: r.iso3, name: r.name })),
    answer: letters[opts.indexOf(answer)],
  };
}

// The compact view the language model sees: strings only, no raw arrays.
export function factsForLlm(f: Facts, format: Format): Record<string, unknown> {
  const out: Record<string, unknown> = {
    measure: f.title,
    unit: f.unit,
    year: String(f.year),
    countries_ranked: String(f.countries_count),
    top10: f.ranking.slice(0, 10).map((r) => ({ rank: String(r.rank), country: r.name, value: r.display })),
    bottom5: f.ranking.slice(-5).map((r) => ({ rank: String(r.rank), country: r.name, value: r.display })),
    world_median: f.world_median,
    anchors: Object.values(f.anchors).map((a) => ({ country: a.name, rank: a.rank, of: a.of, value: a.value })),
  };
  if (f.top_vs_median) out.number_1_vs_median = f.top_vs_median;
  if (f.top_vs_usa) out.number_1_vs_united_states = f.top_vs_usa;
  if (f.threshold) out.threshold = { label: f.threshold.label, how_many_countries: f.threshold.count, countries: f.threshold.countries.slice(0, 15) };
  if (format === 'THEN_NOW' && f.series) {
    out.then_vs_now = {
      start_year: String(f.series.start_year),
      start_top3: f.series.start_top3,
      start_median: f.series.start_median,
      latest_top3: f.series.latest_top3,
    };
  }
  if (format === 'SCALE' && f.scale) {
    out.if_the_world_were_100 = { groups: f.scale.groups.map((g) => ({ group: g.name, out_of_100: String(g.people) })), world_total: f.scale.world_total };
  }
  if (format === 'GUESS' && f.guess) {
    out.guess = { options: f.guess.options.map((o) => `${o.letter}: ${o.name}`), answer: f.guess.answer };
  }
  out.source_line = f.source_line;
  return out;
}

export async function loadFacts(ds: CatalogEntry & { source_url?: string }, format: Format, ref = ds.ref): Promise<Facts> {
  const [series, population] = await Promise.all([
    fetchSeries(ref),
    fetchSeries({ kind: 'worldbank', indicator: 'SP.POP.TOTL' }),
  ]);
  return buildFacts({ ds, series, population, format });
}
