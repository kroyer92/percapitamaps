// Chooses the next video's format: FORMATS weights, a Thompson-sampling bandit once there is
// enough data, and the rule that no format runs three times in a row.
import { config, type Format } from './config.js';
import { q } from './db.js';
import type { Dataset } from './datasets.js';

function betaSample(a: number, b: number): number {
  // Beta(a, b) from two gamma draws (Marsaglia–Tsang), fine for small integer-ish a, b.
  const gamma = (k: number): number => {
    if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do {
        const u1 = Math.random(), u2 = Math.random();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const x = gamma(a);
  return x / (x + gamma(b));
}

export async function recentFormats(n = 2): Promise<string[]> {
  const rows = await q<{ format: string }>(
    `SELECT format FROM jobs WHERE status NOT IN ('rejected','render_failed','needs_human','dead_letter','producing')
     ORDER BY created_at DESC LIMIT $1`, [n]);
  return rows.map((r) => r.format);
}

export async function blockedFormat(): Promise<string | undefined> {
  const last = await recentFormats(2);
  return last.length === 2 && last[0] === last[1] ? last[0] : undefined;
}

// Wins = videos in the top 20% of 72-hour views; everything else measured is a loss.
async function banditScores(): Promise<Map<string, { wins: number; losses: number }> | undefined> {
  const rows = await q<{ format: string; views: number }>(
    `SELECT j.format, m.views FROM metrics m JOIN jobs j ON j.id = m.job_id WHERE m.win = '72h' AND m.views IS NOT NULL`);
  if (rows.length < 10) return undefined;
  const sorted = rows.map((r) => r.views).sort((a, b) => a - b);
  const cut = sorted[Math.floor(sorted.length * 0.8)];
  const out = new Map<string, { wins: number; losses: number }>();
  for (const r of rows) {
    const s = out.get(r.format) ?? { wins: 0, losses: 0 };
    if (r.views >= cut) s.wins++; else s.losses++;
    out.set(r.format, s);
  }
  return out;
}

export async function pickFormat(): Promise<Format> {
  const blocked = await blockedFormat();
  const pool = config.formats.filter((f) => f !== blocked);
  const candidates = pool.length ? pool : config.formats;
  const scores = await banditScores();
  if (!scores) return candidates[Math.floor(Math.random() * candidates.length)];
  const weight = new Map<string, number>();
  for (const f of candidates) weight.set(f, (weight.get(f) ?? 0) + 1);
  let best: Format = candidates[0];
  let bestScore = -1;
  for (const [f, w] of weight) {
    const s = scores.get(f) ?? { wins: 0, losses: 0 };
    const sample = betaSample(1 + s.wins, 1 + s.losses) * w;
    if (sample > bestScore) { bestScore = sample; best = f as Format; }
  }
  return best;
}

// Some formats need particular data: SCALE needs totals that can be split, THEN_NOW history.
export function fitFormat(format: Format, ds: Dataset): Format {
  if (format === 'SCALE' && !ds.additive) return 'MAP_REVEAL';
  return format;
}
