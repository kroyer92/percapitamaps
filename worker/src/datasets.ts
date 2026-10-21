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

export async function enabledDatasets(): Promise<DatasetRow[]> {
  return q<DatasetRow>('SELECT * FROM datasets WHERE enabled ORDER BY id');
}
