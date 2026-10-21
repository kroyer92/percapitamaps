// Verifies every catalog entry against the live source: the slug or indicator exists, enough
// countries have recent data, and the license isn't more restrictive than CC BY.
// Entries that fail are disabled (not deleted) and the reason is stored in check_error.
import { pool, q } from '../db.js';
import { fetchSeries, licenseVerdict } from '../data/fetch.js';
import { pickYear, MIN_POPULATION } from '../facts.js';
import type { CatalogEntry } from '../data/catalog.js';

export async function checkDatasets(only?: string[]): Promise<{ ok: number; failed: { id: string; error: string }[] }> {
  const rows = await q<{ id: string; spec: CatalogEntry }>(`SELECT id, spec FROM datasets ${only?.length ? 'WHERE id = ANY($1)' : ''} ORDER BY id`, only?.length ? [only] : []);
  const population = await fetchSeries({ kind: 'worldbank', indicator: 'SP.POP.TOTL' });
  const big = new Set<string>();
  for (const [iso, years] of population.values) if ((years.get(Math.max(...years.keys())) ?? 0) >= MIN_POPULATION) big.add(iso);

  let ok = 0;
  const failed: { id: string; error: string }[] = [];
  let i = 0;
  for (const row of rows) {
    i++;
    const ds = row.spec;
    try {
      const s = await fetchSeries(ds.ref);
      const lic = licenseVerdict(s.licenseFound);
      if (lic === 'bad') throw new Error(`license is ${s.licenseFound}`);
      const allowed = new Set([...s.values.keys()].filter((iso) => big.has(iso)));
      const { year, best } = pickYear(s.values, allowed, ds.minCountries ?? 100);
      if (!isFinite(year)) throw new Error(`only ${best} countries in the best year (needs ${ds.minCountries ?? 100})`);
      const countries = [...allowed].filter((iso) => s.values.get(iso)!.has(year)).length;
      await q(
        `UPDATE datasets SET enabled = true, resolved_ref = $2, source_url = $3, latest_year = $4, countries = $5, verified_at = now(), check_error = NULL WHERE id = $1`,
        [row.id, s.resolved, s.url, year, countries],
      );
      ok++;
      console.log(`${String(i).padStart(3)}/${rows.length} ✓ ${row.id.padEnd(30)} ${year} · ${countries} countries`);
    } catch (e: any) {
      const error = String(e.message ?? e).slice(0, 300);
      await q(`UPDATE datasets SET enabled = false, verified_at = now(), check_error = $2 WHERE id = $1`, [row.id, error]);
      failed.push({ id: row.id, error });
      console.log(`${String(i).padStart(3)}/${rows.length} ✗ ${row.id.padEnd(30)} ${error.slice(0, 120)}`);
    }
  }
  return { ok, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const r = await checkDatasets(only);
  console.log(`\n${r.ok} datasets ready, ${r.failed.length} disabled.`);
  await pool.end();
}
