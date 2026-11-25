import { one, q } from './db.js';
import type { CatalogEntry, SourceRef } from './data/catalog.js';

export interface DatasetRow {
  id: string;
  spec: CatalogEntry;
  resolved_ref: SourceRef | null;
  source_url: string | null;
  enabled: boolean;
  latest_year: number | null;
  countries: number | null;
  last_used_at: Date | null;
}

export type Dataset = CatalogEntry & { source_url?: string };

export function toDataset(row: DatasetRow): Dataset {
  return { ...row.spec, ref: row.resolved_ref ?? row.spec.ref, source_url: row.source_url ?? undefined };
}

export async function getDataset(id: string): Promise<Dataset> {
  const row = await one<DatasetRow>('SELECT * FROM datasets WHERE id = $1', [id]);
  if (!row) throw new Error(`Unknown dataset ${id}`);
  return toDataset(row);
}

// The datasets the idea finder and follow-ups may use. A pinned topic's dataset (data/pinned.ts) is
// made for that one video, so it is left out.
export async function enabledDatasets(): Promise<DatasetRow[]> {
  return q<DatasetRow>(`SELECT * FROM datasets WHERE enabled AND COALESCE((spec->>'pinned')::boolean, false) = false ORDER BY id`);
}

// Writes a catalog entry into the datasets table (migrate, and pinned topics at start-up). A changed
// spec forgets the resolved source, so the next check looks it up again.
export async function upsertDataset(ds: CatalogEntry): Promise<void> {
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
