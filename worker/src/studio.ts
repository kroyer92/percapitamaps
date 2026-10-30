// The studio page: an office where you watch the pipeline work. Served at /studio/ by this
// worker and published at STUDIO_DOMAIN by Caddy behind a password (README, "Studio page").
// Read-only: it never changes a job. One Postgres read every 30 s at most, plus a live stream of
// what each agent is doing (activity.ts), so it costs almost nothing next to a render.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, FORMAT_NAMES, type Format } from './config.js';
import { getSetting, one, q } from './db.js';
import { queue } from './lib/queue.js';
import { upcomingSlots } from './lib/time.js';
import { getTune } from './tune.js';
import * as office from './activity.js';
import { openingTest, type ChannelStats } from './analytics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageDir = path.resolve(here, '../studio');
const fontDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@fontsource/inter/package.json')), 'files');

// YouTube Partner Program, ad revenue tier (verified Oct 2026). New channels need double the
// views or hours from 1 Feb 2027; channels already in the programme keep their place.
const YPP = {
  now: { subs: 1000, shorts: 10_000_000, hours: 4000 },
  from: { date: '2027-02-01', subs: 1000, shorts: 20_000_000, hours: 8000 },
};

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Days until a rolling 90-day total reaches target if every new day brings `pace` views and the
// oldest day drops out of the window. Undefined when it never gets there within two years.
export function daysToRolling(daily: number[], pace: number, target: number): number | undefined {
  const window = [...daily.slice(-90)];
  while (window.length < 90) window.unshift(0);
  let total = window.reduce((a, b) => a + b, 0);
  if (total >= target) return 0;
  for (let t = 1; t <= 730; t++) {
    total += pace - window.shift()!;
    window.push(pace);
    if (total >= target) return t;
  }
  return undefined;
}

function subsPace(history: ChannelStats['history']): number | undefined {
  if (history.length < 2) return undefined;
  const last = history[history.length - 1];
  const cutoff = +new Date(last.d) - 14 * DAY;
  const first = history.find((h) => +new Date(h.d) >= cutoff) ?? history[0];
  const days = (+new Date(last.d) - +new Date(first.d)) / DAY;
  return days >= 3 ? (last.subs - first.subs) / days : undefined;
}

type Rule = { subs: number; shorts: number; hours: number };

function eta(ch: { subs: number | null; daily: number[]; history: ChannelStats['history'] }, rule: Rule) {
  const pace = ch.daily.length >= 14 ? ch.daily.slice(-14).reduce((a, b) => a + b, 0) / 14 : undefined;
  const sp = subsPace(ch.history);
  if (pace === undefined || sp === undefined || ch.subs === null) return { days: undefined, ready: false, pace, subsPace: sp };
  const dViews = daysToRolling(ch.daily, pace, rule.shorts);
  const dSubs = ch.subs >= rule.subs ? 0 : sp > 0 ? Math.ceil((rule.subs - ch.subs) / sp) : undefined;
  const days = dViews === undefined || dSubs === undefined ? undefined : Math.max(dViews, dSubs);
  return { days: days !== undefined && days <= 730 ? days : undefined, ready: true, pace, subsPace: sp };
}

async function ypp() {
  const ch = await getSetting<ChannelStats>('channel');
  let source: 'youtube' | 'tracked' = 'youtube';
  let subs = ch?.subs ?? null;
  let shorts = ch?.shorts_views_90d ?? null;
  const hours = ch?.longform_hours_365d ?? null;
  // Until WF5 has fetched the channel totals once, add up what the per-video snapshots know.
  if (!ch) {
    source = 'tracked';
    const t = await one<{ views: number | null; subs: number | null }>(
      `SELECT sum(views)::bigint AS views, sum(subs_gained)::bigint AS subs FROM (
         SELECT DISTINCT ON (m.job_id) m.views, m.subs_gained FROM metrics m JOIN jobs j ON j.id = m.job_id
         WHERE j.published_at > now() - interval '90 days'
         ORDER BY m.job_id, m.captured_at DESC) s`);
    subs = t?.subs ?? 0;
    shorts = t?.views ?? 0;
  }
  const daily = (ch?.shorts_daily ?? []).map(([, v]) => v);
  const input = { subs, daily, history: ch?.history ?? [] };
  const before = eta(input, YPP.now);
  const change = new Date(YPP.from.date);
  let when: string | undefined;
  let rule: 'now' | 'from' = 'now';
  if (before.days !== undefined) {
    const d = new Date(Date.now() + before.days * DAY);
    if (d < change) when = ymd(d);
    else {
      rule = 'from';
      const after = eta(input, YPP.from);
      if (after.days !== undefined) when = ymd(new Date(Date.now() + after.days * DAY));
    }
  }
  return {
    source, subs, shorts_views_90d: shorts, longform_hours_365d: hours, fetched_at: ch?.fetched_at ?? null,
    rules: YPP, eta: { ready: before.ready, date: when, rule, views_per_day: before.pace, subs_per_day: before.subsPace },
    history: (ch?.history ?? []).slice(-60),
  };
}

function why(t: { trend_link: string | null; source: string; expected_twist: string | null }): string {
  const base = t.trend_link ? `Trending: "${t.trend_link}"` : t.source === 'launch' ? 'Launch concept' : t.source === 'followup' ? 'Follow-up to a winner' : 'Evergreen angle';
  return t.expected_twist ? `${base}. ${t.expected_twist}` : base;
}

async function whiteboard() {
  const jobs = await q<{ id: number; status: string; format: Format; title: string | null; question: string; slot_at: Date | null; trend_link: string | null; source: string; expected_twist: string | null; hook_type: string | null; voice: string | null }>(
    `SELECT j.id, j.status, j.format, j.packaging->>'title' AS title, t.question, j.slot_at, t.trend_link, t.source, t.expected_twist, j.hook_type, j.voice
     FROM jobs j JOIN topics t ON t.id = j.topic_id
     WHERE j.status = 'awaiting_approval' OR (j.status IN ('approved','published') AND j.slot_at > now())
     ORDER BY j.slot_at NULLS LAST, j.id LIMIT 6`);
  const ideas = await q<{ id: number; question: string; format: Format; trend_link: string | null; source: string; expected_twist: string | null }>(
    `SELECT t.id, t.question, t.format, t.trend_link, t.source, t.expected_twist FROM topics t JOIN datasets d ON d.id = t.dataset_id
     WHERE t.status = 'idea' AND d.enabled
     ORDER BY (t.source = 'launch') DESC, CASE WHEN t.source = 'launch' THEN t.priority END DESC NULLS LAST, t.priority DESC, t.id
     LIMIT 6`);
  const notes = [
    ...jobs.map((j) => ({
      kind: j.status === 'awaiting_approval' ? 'awaiting' : 'booked',
      title: j.title ?? j.question, format: FORMAT_NAMES[j.format] ?? j.format, at: j.slot_at, job: j.id,
      why: [why(j), j.hook_type ? `testing a ${j.hook_type.toLowerCase().replace(/_/g, ' ')} hook` : ''].filter(Boolean).join(' · '),
    })),
    ...ideas.map((t) => ({ kind: 'idea', title: t.question, format: FORMAT_NAMES[t.format] ?? t.format, at: null, job: null, why: why(t) })),
  ].slice(0, 6);
  const counts = await one<{ awaiting: number; booked: number; ideas: number; datasets: number }>(
    `SELECT (SELECT count(*) FROM jobs WHERE status = 'awaiting_approval')::int AS awaiting,
            (SELECT count(*) FROM jobs WHERE status = 'approved' AND slot_at > now())::int AS booked,
            (SELECT count(*) FROM topics WHERE status = 'idea')::int AS ideas,
            (SELECT count(*) FROM datasets WHERE enabled)::int AS datasets`);
  return { notes, counts };
}

async function nextUpload() {
  const j = await one<{ id: number; slot_at: Date; title: string | null }>(
    `SELECT id, slot_at, packaging->>'title' AS title FROM jobs WHERE status IN ('approved','published') AND slot_at > now() ORDER BY slot_at LIMIT 1`);
  if (j) return { at: j.slot_at, job: j.id, title: j.title, booked: true };
  const slot = upcomingSlots(config.publishSlots, config.slotTz, new Date(), 3)[0];
  return { at: slot ?? null, job: null, title: null, booked: false };
}

type Latest = { id: number; title: string | null; format: Format; voice: string | null; hook_type: string | null; length_band: string | null; youtube_url: string | null; published_at: Date; win: string; views: number | null; engaged_views: number | null; avg_view_pct: number | null; score: any };

async function latestSnapshots(days: number): Promise<Latest[]> {
  return q<Latest>(
    `SELECT DISTINCT ON (j.id) j.id, j.packaging->>'title' AS title, j.format, j.voice, j.hook_type, j.length_band, j.youtube_url, j.published_at,
       m.win, m.views, m.engaged_views, m.avg_view_pct, m.score
     FROM jobs j JOIN metrics m ON m.job_id = j.id
     WHERE j.published_at > now() - make_interval(days => $1)
     ORDER BY j.id, CASE m.win WHEN '7d' THEN 1 WHEN '72h' THEN 2 ELSE 3 END`, [days]);
}

async function performance(rows: Latest[]) {
  const published = await q<{ id: number; title: string | null; published_at: Date; youtube_url: string | null }>(
    `SELECT id, packaging->>'title' AS title, published_at, youtube_url FROM jobs WHERE status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 8`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return published.map((p) => {
    const r = byId.get(p.id);
    const v = r?.score?.values ?? {};
    return {
      id: p.id, title: p.title, url: p.youtube_url, published_at: p.published_at,
      win: r?.win ?? null, views: r?.views ?? null, stay: v.stay ?? null, finish: r?.avg_view_pct ?? null,
      verdict: r?.score?.verdict ?? null, reason: r?.score?.reason ?? null, grades: r?.score?.grades ?? {},
    };
  });
}

async function experiments(rows: Latest[]) {
  const group = (key: 'format' | 'voice' | 'hook_type' | 'length_band', label: (k: string) => string) => {
    const g = new Map<string, number[]>();
    for (const r of rows) {
      const k = r[key];
      const v = r.engaged_views ?? r.views;
      if (k && v !== null) g.set(k, [...(g.get(k) ?? []), v]);
    }
    return [...g.entries()].map(([k, v]) => ({ key: k, label: label(k), median: median(v), n: v.length })).sort((a, b) => (b.median ?? 0) - (a.median ?? 0));
  };
  const tune = await getTune();
  const opening = await openingTest().catch(() => null);
  return {
    opening, // the Map Reveal opening test, with its own readiness rule
    formats: group('format', (k) => FORMAT_NAMES[k as Format] ?? k),
    voices: group('voice', (k) => k),
    hooks: group('hook_type', (k) => k.toLowerCase().replace(/_/g, ' ')),
    lengths: group('length_band', (k) => `${k} s`),
    tune: { enabled: tune.enabled, weights: tune.weights, updated_at: tune.updated_at ?? null },
    tests: { formats: [...new Set(config.formats)].map((f) => FORMAT_NAMES[f]), voices: [...new Set([config.voiceA, config.voiceB])], hooks: [...new Set(config.hookTest)], lengths: [...new Set(config.lengthTest)] },
    measured: rows.length,
  };
}

let cache: { at: number; data: unknown } | undefined;

export async function studioState() {
  if (cache && Date.now() - cache.at < 30_000) return cache.data;
  const rows = await latestSnapshots(90);
  const [y, wb, next, perf, exp] = await Promise.all([ypp(), whiteboard(), nextUpload(), performance(rows), experiments(rows)]);
  const data = {
    generated_at: new Date().toISOString(),
    channel: { name: config.channelName, handle: config.channelHandle },
    tz: { slot: config.slotTz, local: config.localTz },
    ypp: y, whiteboard: wb, next_upload: next, performance: perf, experiments: exp,
    earnings: { locked: true, reason: 'Unlocks when the channel joins the YouTube Partner Program and the earnings permission is added.' },
  };
  cache = { at: Date.now(), data };
  return data;
}

export const studio = express.Router();

studio.get('/', (req, res, next) => {
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, `${req.baseUrl}/`);
  res.set('Cache-Control', 'no-store').sendFile(path.join(pageDir, 'index.html'), (e) => e && next(e));
});
studio.use('/fonts', express.static(fontDir, { maxAge: '30d', fallthrough: false }));
// The office floor script and its art (generated on the PC GPU by tools/office-art; optional).
studio.use('/office', express.static(path.join(pageDir, 'office'), { maxAge: '1h', fallthrough: false }));

studio.get('/api/state', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await studioState());
  } catch (e) {
    next(e);
  }
});

// Server-sent events: the agents' state on connect, then every change as it happens.
studio.get('/api/live', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', { ...office.snapshot(), queue: queue.status() });
  const off = office.subscribe((event, data) => {
    send(event, data);
    if (event === 'log') { cache = undefined; send('queue', queue.status()); }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { off(); clearInterval(ping); });
});
