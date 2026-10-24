// WF1's work: trend signals -> angle ideas -> duplicate checks -> topics.
import crypto from 'node:crypto';
import { config, FORMAT_CODES, type Format } from './config.js';
import { one, q } from './db.js';
import { chatJson, embed, unloadModels } from './llm.js';
import * as P from './prompts.js';
import { enabledDatasets, type DatasetRow } from './datasets.js';

const UA = 'PerCapitaMapsStudio/1.0 (private tool)';
const SEEDS = [
  'which country has the most', 'countries ranked by', 'which country has the highest', 'richest countries',
  'countries with the most', 'world map of', 'most expensive country', 'which country eats the most',
  'which country works the most', 'tallest countries', 'happiest countries', 'countries by population',
  'which country drinks the most', 'smallest countries', 'countries with no', 'most visited countries',
  'which country uses the most', 'cheapest countries to live', 'countries with the best', 'safest countries',
];
const SENSITIVE = /(war|killed|death toll|massacre|shooting|terror|suicide|election|vote|abortion|religion|gaza|ukraine|israel|genocide|rape)/i;

interface Signal { source: string; text: string; score: number }

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function collectSignals(): Promise<Signal[]> {
  const signals: Signal[] = [];
  const y = new Date(Date.now() - 86_400_000);
  const ymd = `${y.getUTCFullYear()}/${String(y.getUTCMonth() + 1).padStart(2, '0')}/${String(y.getUTCDate()).padStart(2, '0')}`;
  await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${ymd}`)
    .then((j) => {
      for (const a of j.items?.[0]?.articles?.slice(0, 80) ?? []) {
        if (/^(Main_Page|Special:|Wikipedia:|Portal:|File:)/.test(a.article)) continue;
        signals.push({ source: 'wikipedia', text: a.article.replace(/_/g, ' '), score: a.views });
      }
    })
    .catch((e) => console.warn('[discover] wikipedia', e.message));
  // Reddit often refuses its JSON to server addresses (403); the RSS feed is tried next. Both
  // are optional: Wikipedia and YouTube autocomplete are enough on their own.
  for (const sub of ['MapPorn', 'dataisbeautiful']) {
    await getJson(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=15`)
      .then((j) => j.data?.children?.forEach((c: any) => signals.push({ source: `r/${sub}`, text: c.data.title, score: c.data.ups })))
      .catch(async () => {
        const res = await fetch(`https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=15`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(String(res.status));
        const titles = [...(await res.text()).matchAll(/<entry>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1]);
        titles.forEach((t, i) => signals.push({ source: `r/${sub}`, text: t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), score: 1000 - i * 50 }));
      })
      .catch((e) => console.warn(`[discover] reddit ${sub} skipped (${e.message}); other sources still used`));
  }
  for (const seed of SEEDS) {
    await getJson(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(seed)}`)
      .then((j) => (j[1] ?? []).slice(0, 5).forEach((s: string, i: number) => signals.push({ source: 'youtube_autocomplete', text: s, score: 1000 - i * 100 })))
      .catch(() => undefined);
  }
  // Keep the top 40, spread across sources.
  const bySource = new Map<string, Signal[]>();
  for (const s of signals) if (!SENSITIVE.test(s.text)) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
  const out: Signal[] = [];
  const lists = [...bySource.values()].map((l) => l.sort((a, b) => b.score - a.score));
  for (let i = 0; out.length < 40 && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && out.length < 40) out.push(l[i]);
  return out;
}

export interface Angle {
  dataset_id: string;
  question: string;
  expected_twist?: string;
  format: string;
  trend_link?: string | null;
  scores?: Record<string, number>;
}

export function angleHash(question: string): string {
  const norm = question.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 2).sort().join(' ');
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

export async function insertTopics(angles: Angle[], datasets: DatasetRow[], source: 'discover' | 'followup' | 'launch', basePriority = 0): Promise<{ inserted: number; skipped: string[] }> {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const skipped: string[] = [];
  let inserted = 0;
  for (const a of angles) {
    const ds = byId.get(a.dataset_id);
    if (!ds) { skipped.push(`${a.question}: unknown dataset ${a.dataset_id}`); continue; }
    if (!a.question || a.question.split(/\s+/).length > 14) { skipped.push(`${a.question}: question too long`); continue; }
    if (SENSITIVE.test(a.question)) { skipped.push(`${a.question}: sensitive`); continue; }
    const format = (FORMAT_CODES as readonly string[]).includes(a.format) ? (a.format as Format) : 'MAP_REVEAL';
    let vector: number[] | null = null;
    try {
      vector = await embed(a.question);
      const dup = await one<{ question: string; sim: number }>(
        `SELECT question, 1 - (embedding <=> $1::vector) AS sim FROM topics
         WHERE embedding IS NOT NULL AND created_at > now() - interval '365 days' AND status <> 'failed'
         ORDER BY embedding <=> $1::vector LIMIT 1`,
        [JSON.stringify(vector)],
      );
      if (dup && dup.sim >= 0.88) { skipped.push(`${a.question}: too close to "${dup.question}"`); continue; }
    } catch (e: any) {
      console.warn('[discover] embedding failed, relying on the hash check only:', e.message);
    }
    const s = a.scores ?? {};
    const priority = basePriority + (Number(s.curiosity) || 0) + (Number(s.shareability) || 0) + (Number(s.comment_bait) || 0) + (Number(s.evergreen) || 0) + (a.trend_link ? 3 : 0);
    const res = await q(
      `INSERT INTO topics (dataset_id, question, expected_twist, format, trend_link, scores, priority, angle_hash, embedding, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10) ON CONFLICT (dataset_id, angle_hash) DO NOTHING RETURNING id`,
      [a.dataset_id, a.question, a.expected_twist ?? null, format, a.trend_link ?? null, s, priority, angleHash(a.question), vector ? JSON.stringify(vector) : null, source],
    );
    if (res.length) inserted++; else skipped.push(`${a.question}: same angle already exists`);
  }
  return { inserted, skipped };
}

function datasetTable(rows: DatasetRow[]): string {
  return rows.map((d) => `${d.id} | ${d.spec.title} | ${d.spec.unit} | ${d.latest_year ?? '?'} | ${d.countries ?? '?'}`).join('\n');
}

async function recentTitles(): Promise<string> {
  const rows = await q<{ question: string }>(`SELECT question FROM topics WHERE created_at > now() - interval '365 days' ORDER BY created_at DESC LIMIT 120`);
  return rows.map((r) => `- ${r.question}`).join('\n') || '(none yet)';
}

export async function discover(): Promise<{ signals: number; inserted: number; skipped: string[] }> {
  const signals = await collectSignals();
  const datasets = (await enabledDatasets()).filter((d) => !d.last_used_at || Date.now() - +new Date(d.last_used_at) > 21 * 86_400_000);
  const res = await chatJson<{ angles: Angle[] }>({
    temperature: 0.7,
    system: P.ANGLE_SYSTEM,
    user: P.angleUser(signals.map((s) => `[${s.source}] ${s.text}`).join('\n') || '(no signals today)', datasetTable(datasets), await recentTitles()),
    numPredict: 3000,
  });
  const out = await insertTopics(res.angles ?? [], datasets, 'discover');
  await unloadModels();
  return { signals: signals.length, ...out };
}

// /followup: two related videos in the same format, from nearby datasets.
export async function followup(jobId: number): Promise<{ inserted: number; skipped: string[] }> {
  const job = await one<any>('SELECT j.*, t.dataset_id, t.question FROM jobs j JOIN topics t ON t.id = j.topic_id WHERE j.id = $1', [jobId]);
  if (!job) throw new Error(`No job #${jobId}`);
  const all = await enabledDatasets();
  const orig = all.find((d) => d.id === job.dataset_id);
  const fresh = (d: DatasetRow) => d.id !== job.dataset_id && (!d.last_used_at || Date.now() - +new Date(d.last_used_at) > 21 * 86_400_000);
  let pool = all.filter((d) => fresh(d) && orig?.spec.grp && d.spec.grp === orig.spec.grp);
  if (pool.length < 2) pool = [...pool, ...all.filter((d) => fresh(d) && d.spec.topic === orig?.spec.topic && !pool.includes(d))];
  const res = await chatJson<{ angles: Angle[] }>({
    temperature: 0.6,
    system: P.ANGLE_SYSTEM,
    user: P.angleUser(`A video did very well: "${job.question}" (format ${job.format}). Propose follow-ups in the same format (${job.format}) that a viewer of that video would want next.`, datasetTable(pool.slice(0, 25)), await recentTitles(), 2),
  });
  const angles = (res.angles ?? []).slice(0, 2).map((a) => ({ ...a, format: job.format }));
  const out = await insertTopics(angles, all, 'followup', 100);
  await unloadModels();
  return out;
}
