// `docker compose run --rm migrate`: creates the tables, loads the dataset catalog, and
// checks every dataset against its live source. Safe to run again after updates.
import { applySchema, pool, q } from '../db.js';
import { CATALOG } from '../data/catalog.js';
import { checkDatasets } from './check-datasets.js';

await applySchema();
console.log('Tables ready.');

for (const ds of CATALOG) {
  await q(
    `INSERT INTO datasets (id, title, unit, topic, grp, spec, license, decimals, additive, threshold, min_countries)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, unit = EXCLUDED.unit, topic = EXCLUDED.topic, grp = EXCLUDED.grp,
       spec = EXCLUDED.spec, license = EXCLUDED.license, decimals = EXCLUDED.decimals, additive = EXCLUDED.additive,
       threshold = EXCLUDED.threshold, min_countries = EXCLUDED.min_countries,
       resolved_ref = CASE WHEN datasets.spec = EXCLUDED.spec THEN datasets.resolved_ref END`,
    [ds.id, ds.title, ds.unit, ds.topic, ds.grp ?? null, ds, ds.license, ds.decimals ?? 0, !!ds.additive, ds.threshold ?? null, ds.minCountries ?? 100],
  );
}
// Entries removed from the catalog are disabled, never deleted (old videos refer to them).
await q(`UPDATE datasets SET enabled = false, check_error = 'removed from catalog' WHERE NOT (id = ANY($1))`, [CATALOG.map((d) => d.id)]);
console.log(`Catalog loaded: ${CATALOG.length} datasets.`);

if (!process.argv.includes('--skip-check')) {
  console.log('Checking each one against its live source (takes a few minutes)…\n');
  const r = await checkDatasets();
  console.log(`\n${r.ok} datasets ready, ${r.failed.length} disabled (their reasons are in the datasets.check_error column).`);
}
await pool.end();
