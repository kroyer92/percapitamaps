// The real-world numbers behind Per Capita Nation: GDP per person, life expectancy and population
// of every country and territory in the World Bank's data. Each figure is from one year for every
// country (the latest year at least 150 of them have), so the ranks compare like with like.
import countries from 'i18n-iso-countries';
import { fetchSeries, type Series } from '../data/fetch.js';
import { CATALOG } from '../data/catalog.js';
import { countryName, iso3ToIso2, ISO3 } from '../data/countries.js';

export type Metric = 'gdp' | 'le';
export interface CountryRow { iso3: string; iso2: string; name: string; gdp?: number; le?: number; pop?: number }
export interface CountryTable { rows: CountryRow[]; byIso: Map<string, CountryRow>; years: { gdp: number; le: number; pop: number }; loadedAt: number }

export const METRIC = {
  gdp: { dataset: 'wb_gdp_pc_usd', label: 'income per person', title: 'GDP per person', unit: 'US dollars per person', prefix: '$', suffix: '', decimals: 0, url: 'https://data.worldbank.org/indicator/NY.GDP.PCAP.CD' },
  le: { dataset: 'wb_life_expectancy', label: 'life expectancy', title: 'Life expectancy at birth', unit: 'years', prefix: '', suffix: ' years', decimals: 1, url: 'https://data.worldbank.org/indicator/SP.DYN.LE00.IN' },
} as const;
export const WB_LICENSE = 'CC BY 4.0';

const MIN_COUNTRIES = 150;
const KEEP_MS = 12 * 3600_000;

// The latest year with enough countries, and each country's value in that year.
function oneYear(s: Series): { year: number; values: Map<string, number> } {
  const perYear = new Map<number, number>();
  for (const years of s.values.values()) for (const y of years.keys()) perYear.set(y, (perYear.get(y) ?? 0) + 1);
  const year = [...perYear.entries()].filter(([, n]) => n >= MIN_COUNTRIES).map(([y]) => y).sort((a, b) => b - a)[0]
    ?? Math.max(...perYear.keys());
  const values = new Map<string, number>();
  for (const [iso, years] of s.values) { const v = years.get(year); if (v !== undefined && isFinite(v)) values.set(iso, v); }
  return { year, values };
}

const ref = (id: string) => CATALOG.find((d) => d.id === id)!.ref;

// Every ISO country, also those without World Bank figures: a viewer can live anywhere.
export function buildTable(gdp: Series, le: Series, pop: Series): CountryTable {
  const g = oneYear(gdp), l = oneYear(le), p = oneYear(pop);
  const rows: CountryRow[] = [];
  for (const iso3 of ISO3) {
    const iso2 = iso3ToIso2(iso3);
    if (!iso2 || iso3 === 'ATA') continue;
    rows.push({ iso3, iso2, name: countryName(iso3, gdp.names.get(iso3) ?? countries.getName(iso3, 'en')), gdp: g.values.get(iso3), le: l.values.get(iso3), pop: p.values.get(iso3) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, byIso: new Map(rows.map((r) => [r.iso3, r])), years: { gdp: g.year, le: l.year, pop: p.year }, loadedAt: Date.now() };
}

let table: CountryTable | undefined;
let loading: Promise<CountryTable> | undefined;

// Refreshed twice a day (fetch.ts caches the downloads for a day too). When the World Bank can't be
// reached, the last table stays in use.
export async function countryTable(): Promise<CountryTable> {
  if (table && Date.now() - table.loadedAt < KEEP_MS) return table;
  loading ??= (async () => {
    try {
      const [gdp, le, pop] = await Promise.all([fetchSeries(ref(METRIC.gdp.dataset)), fetchSeries(ref(METRIC.le.dataset)), fetchSeries(ref('wb_population'))]);
      table = buildTable(gdp, le, pop);
      return table;
    } catch (e) {
      if (table) return table;
      throw e;
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

export function metricValue(r: CountryRow | undefined, m: Metric): number | undefined {
  return m === 'gdp' ? r?.gdp : r?.le;
}

export function fmtMetric(v: number, m: Metric): string {
  const d = METRIC[m];
  return `${d.prefix}${v.toLocaleString('en-US', { minimumFractionDigits: d.decimals, maximumFractionDigits: d.decimals })}${d.suffix}`;
}
