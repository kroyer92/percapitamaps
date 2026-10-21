import pg from 'pg';
import { config } from './config.js';

// Return BIGINT and NUMERIC as JS numbers; ids and scores stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ ...config.pg, max: 5 });

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(text, params);
  return rows[0];
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await one<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row?.value;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// Creates or updates the tables. Idempotent; runs on every worker start and in migrate.
export async function applySchema(): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const sql = await fs.readFile(path.resolve(process.env.SQL_DIR ?? '../sql', 'schema.sql'), 'utf8');
  await q(sql);
}
