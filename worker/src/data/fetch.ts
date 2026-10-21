import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SourceRef } from './catalog.js';
import { ISO3 } from './countries.js';

export interface Series {
  values: Map<string, Map<number, number>>; // iso3 -> year -> value
  names: Map<string, string>;
  url: string;
  citation?: string;
  licenseFound?: string;
  resolved: SourceRef;
}

const CACHE_HOURS = 24;
const UA = 'PerCapitaMapsStudio/1.0 (private tool; data for one YouTube channel)';

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  const dir = path.join(config.modelsDir, 'cache');
  const file = path.join(dir, key.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < CACHE_HOURS * 3600_000) return await fs.readFile(file, 'utf8');
  } catch { /* not cached */ }
  const body = await fetcher();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, body);
  return body;
}

async function get(url: string, timeoutMs = 60_000): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) throw Object.assign(new Error(`404 Not Found: ${url}`), { notFound: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e: any) {
      if (e?.notFound) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const LICENSE_OK = /(CC[ -]?BY(?![ -]?(NC|ND|SA))|CC0|public domain)/i;
const LICENSE_BAD = /(CC[ -]?BY[ -]?(NC|ND|SA)|non-?commercial|all rights reserved)/i;

export function licenseVerdict(text: string | undefined): 'ok' | 'bad' | 'unknown' {
  if (!text) return 'unknown';
  if (LICENSE_BAD.test(text)) return 'bad';
  if (LICENSE_OK.test(text)) return 'ok';
  return 'unknown';
}

async function fetchOwid(slug: string, column?: string): Promise<Series> {
  const base = `https://ourworldindata.org/grapher/${slug}`;
  const qs = '?v=1&csvType=full&useColumnShortNames=true';
  const csv = await cached(`owid_${slug}.csv`, () => get(base + '.csv' + qs));
  const metaText = await cached(`owid_${slug}.meta.json`, () => get(base + '.metadata.json' + qs)).catch(() => '');
  const rows = parseCsv(csv);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const iEntity = header.indexOf('entity');
  const iCode = header.indexOf('code');
  const iYear = header.indexOf('year');
  if (iCode < 0 || iYear < 0) throw new Error(`OWID ${slug}: no code/year columns (maybe not a country chart)`);
  // Pick the requested column, or the first column that is mostly numeric.
  let iVal = column ? header.indexOf(column.toLowerCase()) : -1;
  if (iVal < 0) {
    for (let c = 0; c < header.length; c++) {
      if ([iEntity, iCode, iYear].includes(c)) continue;
      const sample = rows.slice(1, 200).map((r) => r[c]).filter((v) => v !== '' && v !== undefined);
      if (sample.length && sample.filter((v) => !isNaN(Number(v))).length / sample.length > 0.9) { iVal = c; break; }
    }
  }
  if (iVal < 0) throw new Error(`OWID ${slug}: no numeric column`);
  const values = new Map<string, Map<number, number>>();
  const names = new Map<string, string>();
  for (const r of rows.slice(1)) {
    const code = r[iCode];
    if (!ISO3.has(code)) continue;
    const v = Number(r[iVal]);
    const y = Number(r[iYear]);
    if (r[iVal] === '' || !isFinite(v) || !isFinite(y)) continue;
    if (!values.has(code)) values.set(code, new Map());
    values.get(code)!.set(y, v);
    names.set(code, r[iEntity]);
  }
  let citation: string | undefined;
  let licenseFound: string | undefined;
  if (metaText) {
    try {
      const meta = JSON.parse(metaText);
      const col = meta.columns?.[header[iVal]] ?? Object.values(meta.columns ?? {})[0];
      citation = col?.citationShort ?? meta.chart?.citation;
      const lic = JSON.stringify(meta).match(/"licen[cs]e[^"]*"\s*:\s*("[^"]*"|\{[^}]*\})/i);
      licenseFound = lic?.[1];
    } catch { /* metadata is optional */ }
  }
  return { values, names, url: base, citation, licenseFound, resolved: { kind: 'owid', slugs: [slug], column: header[iVal] } };
}

async function fetchWorldBank(indicator: string): Promise<Series> {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=1960:2030`;
  const text = await cached(`wb_${indicator}.json`, () => get(url));
  const json = JSON.parse(text);
  if (!Array.isArray(json) || !Array.isArray(json[1])) {
    throw Object.assign(new Error(`World Bank ${indicator}: ${JSON.stringify(json).slice(0, 200)}`), { notFound: true });
  }
  const values = new Map<string, Map<number, number>>();
  const names = new Map<string, string>();
  for (const r of json[1]) {
    const code = r.countryiso3code;
    if (!ISO3.has(code) || r.value === null || r.value === undefined) continue;
    const y = Number(r.date);
    if (!values.has(code)) values.set(code, new Map());
    values.get(code)!.set(y, Number(r.value));
    names.set(code, r.country?.value ?? code);
  }
  let licenseFound: string | undefined;
  try {
    const metaText = await cached(`wb_${indicator}.meta.json`, () =>
      get(`https://api.worldbank.org/v2/sources/2/series/${indicator}/metadata?format=json`));
    const m = metaText.match(/"id"\s*:\s*"License_Type"\s*,\s*"value"\s*:\s*"([^"]*)"/);
    licenseFound = m?.[1];
  } catch { /* metadata is optional */ }
  return {
    values, names,
    url: `https://data.worldbank.org/indicator/${indicator}`,
    licenseFound,
    resolved: { kind: 'worldbank', indicator },
  };
}

function combine(a: Series, b: Series, op: (x: number, y: number) => number | null): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const [iso, years] of a.values) {
    const other = b.values.get(iso);
    if (!other) continue;
    for (const [y, x] of years) {
      const yv = other.get(y);
      if (yv === undefined) continue;
      const v = op(x, yv);
      if (v === null || !isFinite(v)) continue;
      if (!out.has(iso)) out.set(iso, new Map());
      out.get(iso)!.set(y, v);
    }
  }
  return out;
}

export async function fetchSeries(ref: SourceRef): Promise<Series> {
  switch (ref.kind) {
    case 'worldbank':
      return fetchWorldBank(ref.indicator);
    case 'owid': {
      const errors: string[] = [];
      for (const slug of ref.slugs) {
        try {
          return await fetchOwid(slug, ref.column);
        } catch (e: any) {
          errors.push(`${slug}: ${e.message}`);
        }
      }
      throw new Error(errors.join(' | '));
    }
    case 'ratio': {
      const [num, den] = await Promise.all([fetchSeries(ref.num), fetchSeries(ref.den)]);
      const mult = ref.mult ?? 1;
      return {
        values: combine(num, den, (x, y) => (y > 0 ? (x / y) * mult : null)),
        names: num.names.size ? num.names : den.names,
        url: num.url,
        citation: num.citation,
        licenseFound: num.licenseFound,
        resolved: { kind: 'ratio', num: num.resolved, den: den.resolved, mult: ref.mult },
      };
    }
    case 'reciprocal':
    case 'scale': {
      const s = await fetchSeries(ref.of);
      const values = new Map<string, Map<number, number>>();
      for (const [iso, years] of s.values) {
        const m = new Map<number, number>();
        for (const [y, v] of years) {
          const out = ref.kind === 'reciprocal' ? (v > 0 ? ref.mult / v : NaN) : v * ref.mult;
          if (isFinite(out)) m.set(y, out);
        }
        values.set(iso, m);
      }
      return { ...s, values, resolved: { ...ref, of: s.resolved } };
    }
  }
}
