// `docker compose run --rm migrate`: creates the tables, loads the dataset catalog, and
// checks every dataset against its live source. Safe to run again after updates.
import { applySchema, pool, q } from '../db.js';
import { CATALOG } from '../data/catalog.js';
import { PINNED_DATASETS } from '../data/pinned.js';
import { upsertDataset } from '../datasets.js';
import { checkDatasets } from './check-datasets.js';

await applySchema();
console.log('Tables ready.');

for (const ds of [...CATALOG, ...PINNED_DATASETS]) await upsertDataset(ds);
// Entries removed from the catalog are disabled, never deleted (old videos refer to them).
await q(`UPDATE datasets SET enabled = false, check_error = 'removed from catalog' WHERE NOT (id = ANY($1))`, [[...CATALOG, ...PINNED_DATASETS].map((d) => d.id)]);
console.log(`Catalog loaded: ${CATALOG.length} datasets.`);

if (!process.argv.includes('--skip-check')) {
  console.log('Checking each one against its live source (takes a few minutes)…\n');
  const r = await checkDatasets();
  console.log(`\n${r.ok} datasets ready, ${r.failed.length} disabled (their reasons are in the datasets.check_error column).`);
}
await pool.end();
