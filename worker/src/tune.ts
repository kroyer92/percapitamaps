// Weekly auto-tuning: shifts which hook type (HOOK_TEST) and length band (LENGTH_TEST) the next
// videos use toward the ones that earn more engaged views. Each weight moves at most 20 points a
// week and never drops under 10%, so every option keeps getting tested. Formats are already tuned
// by the bandit in formats.ts. /tune in Telegram shows, resets or switches this off.
import { config } from './config.js';
import { q, getSetting, setSetting } from './db.js';
import { quantile } from './scorecard.js';

export type Dim = 'hook' | 'length';
type Weights = Record<string, number>;
export interface Tune { enabled: boolean; weights: Partial<Record<Dim, Weights>>; updated_at?: string }

const MAX_STEP = 0.2;
const FLOOR = 0.1;
const MIN_VIDEOS = 3;
const LABEL: Record<Dim, string> = { hook: 'Hook type', length: 'Length' };

const raw = (dim: Dim) => (dim === 'hook' ? config.hookTest : config.lengthTest);

// Starting weights: an option listed twice in .env counts double, as it does in the round-robin.
function initial(dim: Dim): Weights {
  const list = raw(dim);
  const w: Weights = {};
  for (const v of list) w[v] = (w[v] ?? 0) + 1 / list.length;
  return w;
}

export async function getTune(): Promise<Tune> {
  return (await getSetting<Tune>('tune')) ?? { enabled: true, weights: {} };
}

// The current weights, limited to the options still listed in .env.
function current(dim: Dim, t: Tune): Weights {
  const base = initial(dim);
  const saved = t.weights[dim];
  if (!saved) return base;
  const w: Weights = {};
  for (const v of Object.keys(base)) w[v] = saved[v] ?? FLOOR;
  return normalise(w);
}

function normalise(w: Weights): Weights {
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / sum]));
}

// Move each weight at most MAX_STEP toward its target, keep the floor, sum to 1.
export function step(cur: Weights, target: Weights): Weights {
  const keys = Object.keys(cur);
  const floor = Math.min(FLOOR, 1 / keys.length);
  let w = Object.fromEntries(keys.map((k) => {
    const d = Math.max(-MAX_STEP, Math.min(MAX_STEP, (target[k] ?? cur[k]) - cur[k]));
    return [k, Math.max(floor, cur[k] + d)];
  }));
  w = normalise(w);
  return w;
}

// Which option the next video uses: the .env round-robin until tuning has data, then a weighted draw.
export async function pickVariant(dim: Dim, n: number): Promise<string | null> {
  const list = raw(dim);
  if (!list.length) return null;
  const t = await getTune();
  if (!t.enabled || !t.weights[dim]) return list[n % list.length];
  const w = current(dim, t);
  let r = Math.random();
  for (const [k, v] of Object.entries(w)) {
    r -= v;
    if (r <= 0) return k;
  }
  return Object.keys(w)[0];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// Runs with the Sunday report. Returns report lines describing what changed.
export async function autoTune(): Promise<string[]> {
  const t = await getTune();
  if (!t.enabled) return ['Auto-tuning is off. Send /tune on to restart it.'];
  const rows = await q<{ hook_type: string | null; length_band: string | null; engaged: number | null }>(
    `SELECT DISTINCT ON (j.id) j.hook_type, j.length_band, COALESCE(m.engaged_views, m.views) AS engaged
     FROM jobs j JOIN metrics m ON m.job_id = j.id
     WHERE j.published_at > now() - interval '28 days' AND m.win IN ('72h','7d')
     ORDER BY j.id, CASE m.win WHEN '7d' THEN 1 ELSE 2 END`);
  const all = rows.map((r) => r.engaged).filter((x): x is number => x !== null);
  const med = quantile(all, 0.5);
  const lines: string[] = [];
  for (const dim of ['hook', 'length'] as Dim[]) {
    const cur = current(dim, t);
    const options = Object.keys(cur);
    if (options.length < 2 || !med) continue;
    const key = dim === 'hook' ? 'hook_type' : 'length_band';
    const scores: Record<string, { rel: number; n: number }> = {};
    for (const o of options) {
      const vals = rows.filter((r) => r[key] === o && r.engaged !== null).map((r) => r.engaged! / med);
      if (vals.length >= MIN_VIDEOS) scores[o] = { rel: quantile(vals, 0.5), n: vals.length };
    }
    const measured = Object.keys(scores);
    if (measured.length < 2) {
      lines.push(`${LABEL[dim]}: not enough data yet (${MIN_VIDEOS}+ measured videos per option needed).`);
      continue;
    }
    // Measured options share their current weight in proportion to how they perform.
    const mass = measured.reduce((a, o) => a + cur[o], 0);
    const total = measured.reduce((a, o) => a + Math.max(0.05, scores[o].rel), 0);
    const target: Weights = { ...cur };
    for (const o of measured) target[o] = (mass * Math.max(0.05, scores[o].rel)) / total;
    const next = step(cur, target);
    t.weights[dim] = next;
    const moved = options.filter((o) => Math.abs(next[o] - cur[o]) >= 0.01);
    lines.push(`${LABEL[dim]}: ${moved.length
      ? moved.map((o) => `${o} ${pct(cur[o])}→${pct(next[o])}${scores[o] ? ` (${scores[o].rel.toFixed(1)}× median, ${scores[o].n} videos)` : ''}`).join(', ')
      : 'no change'}`);
  }
  t.updated_at = new Date().toISOString();
  await setSetting('tune', t);
  return lines;
}

export async function tuneStatus(): Promise<string> {
  const t = await getTune();
  const show = (dim: Dim) => {
    const w = current(dim, t);
    const keys = Object.keys(w);
    if (keys.length < 2) return `${LABEL[dim]}: only one option in .env (${keys[0] ?? 'none'}), nothing to tune.`;
    return `${LABEL[dim]}: ${keys.map((k) => `${k} ${pct(w[k])}`).join(', ')}${t.weights[dim] ? '' : ' (even, no data yet)'}`;
  };
  return [
    `<b>Auto-tuning ${t.enabled ? 'on' : 'off'}</b>${t.updated_at ? ` · last change ${t.updated_at.slice(0, 10)}` : ''}`,
    show('hook'), show('length'),
    'Formats are tuned by the format bandit once 10 videos have 72h numbers.',
    '<code>/tune off</code> go back to the plain .env rotation · <code>/tune on</code> · <code>/tune reset</code> even weights',
  ].join('\n');
}

export async function setTune(cmd: string): Promise<string> {
  const t = await getTune();
  if (cmd === 'off') t.enabled = false;
  else if (cmd === 'on') t.enabled = true;
  else if (cmd === 'reset') t.weights = {};
  else return tuneStatus();
  await setSetting('tune', t);
  return tuneStatus();
}
