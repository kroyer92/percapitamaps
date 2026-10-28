// WF5's data: which videos need a 24h / 72h / 7d snapshot, storing what n8n fetched from the
// YouTube APIs (plus the Reel's Instagram insights), the scorecard message for each snapshot,
// and the Sunday report with auto-tuning.
import { config, FORMAT_NAMES, type Format } from './config.js';
import { getSetting, q, setSetting } from './db.js';
import { esc, say } from './telegram.js';
import { ig, igToken } from './publish.js';
import { score, mmss, type Grade, type IgInsights, type Score, type Snapshot, type VideoInfo } from './scorecard.js';
import { autoTune, getTune } from './tune.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Beat } from './validate.js';
import type { VoiceClip } from './voice.js';
import * as office from './activity.js';

const WINDOWS: { win: string; hours: number }[] = [
  { win: '24h', hours: 24 },
  { win: '72h', hours: 72 },
  { win: '7d', hours: 168 },
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function dueSnapshots() {
  const jobs = await q<{ id: number; youtube_video_id: string; published_at: Date }>(
    `SELECT id, youtube_video_id, published_at FROM jobs WHERE youtube_video_id IS NOT NULL AND published_at IS NOT NULL AND published_at > now() - interval '30 days'`);
  const have = new Set((await q<{ job_id: number; win: string }>('SELECT job_id, win FROM metrics')).map((m) => `${m.job_id}:${m.win}`));
  const out: { job_id: number; video_id: string; win: string; start_date: string; end_date: string }[] = [];
  for (const j of jobs) {
    for (const w of WINDOWS) {
      const at = +new Date(j.published_at) + w.hours * 3600_000;
      if (at <= Date.now() && !have.has(`${j.id}:${w.win}`)) {
        out.push({ job_id: j.id, video_id: j.youtube_video_id, win: w.win, start_date: ymd(new Date(j.published_at)), end_date: ymd(new Date()) });
        break; // one window per video per run; the next run catches up
      }
    }
  }
  return out.slice(0, 40);
}

function analyticsRow(a: any): Record<string, number> {
  const headers: string[] = (a?.columnHeaders ?? []).map((h: any) => h.name);
  const row: number[] = a?.rows?.[0] ?? [];
  return Object.fromEntries(headers.map((h, i) => [h, Number(row[i])]));
}

export async function storeSnapshot(body: any): Promise<void> {
  const stats = body.stats?.items?.[0]?.statistics ?? body.stats ?? {};
  const a = analyticsRow(body.analytics);
  const num = (v: any) => (v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));
  const jobId = Number(body.job_id);
  office.working('analyst', `Reading the ${body.win} numbers for #${jobId}`, jobId);
  const ig = await igInsights(jobId);
  const curve = curveRows(body.curve);
  await q(
    `INSERT INTO metrics (job_id, win, views, engaged_views, avg_view_pct, avg_view_sec, likes, shares, comments, subs_gained, raw, curve, ig)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (job_id, win) DO UPDATE SET captured_at = now(), views = EXCLUDED.views, engaged_views = EXCLUDED.engaged_views,
       avg_view_pct = EXCLUDED.avg_view_pct, avg_view_sec = EXCLUDED.avg_view_sec, likes = EXCLUDED.likes, shares = EXCLUDED.shares,
       comments = EXCLUDED.comments, subs_gained = EXCLUDED.subs_gained, raw = EXCLUDED.raw, curve = EXCLUDED.curve, ig = EXCLUDED.ig`,
    [
      jobId, body.win,
      num(stats.viewCount) ?? num(a.views),
      num(a.engagedViews),
      num(a.averageViewPercentage),
      num(a.averageViewDuration),
      num(stats.likeCount) ?? num(a.likes),
      num(a.shares),
      num(stats.commentCount) ?? num(a.comments),
      num(a.subscribersGained),
      body,
      curve ? JSON.stringify(curve) : null,
      ig,
    ],
  );
  await scoreAndTell(jobId, body.win);
}

// YouTube Analytics' audience retention report: rows of [elapsedVideoTimeRatio, audienceWatchRatio].
function curveRows(r: any): [number, number][] | null {
  const headers: string[] = (r?.columnHeaders ?? []).map((h: any) => h.name);
  const t = headers.indexOf('elapsedVideoTimeRatio');
  const w = headers.indexOf('audienceWatchRatio');
  if (t < 0 || w < 0 || !r.rows?.length) return null;
  return r.rows.map((row: any[]) => [Number(row[t]), Number(row[w])] as [number, number]);
}

// The Reel's insights, read at the same moment as the YouTube snapshot. Reels go up a day after
// YouTube, so the 24h snapshot usually has none, and Meta's numbers can lag up to 48 hours.
// reels_skip_rate is marked "in development" by Meta, so it is asked for separately.
async function igInsights(jobId: number): Promise<IgInsights | null> {
  const job = await q<{ ig_media_id: string | null; ig_due_at: Date | null }>('SELECT ig_media_id, ig_due_at FROM jobs WHERE id = $1', [jobId]);
  const mediaId = job[0]?.ig_media_id;
  if (!mediaId || !config.instagramToken) return null;
  const token = await igToken();
  const read = async (metric: string) => {
    const r = await ig(`${mediaId}/insights`, { metric, access_token: token }, 'GET');
    const out: Record<string, number> = {};
    for (const d of r.data ?? []) {
      const v = d.values?.[0]?.value ?? d.total_value?.value;
      if (v !== undefined && !isNaN(Number(v))) out[d.name] = Number(v);
    }
    return out;
  };
  const res: IgInsights = {};
  if (job[0].ig_due_at) res.age_hours = Math.round((Date.now() - +new Date(job[0].ig_due_at)) / 3600_000);
  try {
    const m = await read('views,reach,likes,saved,shares,ig_reels_avg_watch_time');
    Object.assign(res, { views: m.views, reach: m.reach, likes: m.likes, saved: m.saved, shares: m.shares });
    if (m.ig_reels_avg_watch_time !== undefined) res.avg_watch_sec = m.ig_reels_avg_watch_time / 1000;
  } catch (e: any) {
    return { ...res, error: String(e.message ?? e) };
  }
  try {
    const s = (await read('reels_skip_rate')).reels_skip_rate;
    if (s !== undefined) res.skip_rate = s <= 1 ? s * 100 : s;
  } catch { /* not available for this account yet */ }
  return res;
}

type JobInfo = { id: number; title: string | null; hook_type: string | null; script: { beats: Beat[] } | null; render: { clips: VoiceClip[]; seconds: number } | null; youtube_video_id: string };

// Scores a fresh snapshot against the bands and the channel's other videos, saves the verdict and
// tells you in Telegram what to change. Winners get a follow-up button.
async function scoreAndTell(jobId: number, win: string): Promise<void> {
  const job = (await q<JobInfo>(`SELECT id, packaging->>'title' AS title, hook_type, script, render, youtube_video_id FROM jobs WHERE id = $1`, [jobId]))[0];
  const snap = (await q<Snapshot>('SELECT * FROM metrics WHERE job_id = $1 AND win = $2', [jobId, win]))[0];
  if (!job || !snap) return;
  const peers = await q<Snapshot>(
    `SELECT m.* FROM metrics m JOIN jobs j ON j.id = m.job_id
     WHERE m.win = $1 AND m.job_id <> $2 AND j.published_at > now() - interval '90 days'`, [win, jobId]);
  const video: VideoInfo = { hook_type: job.hook_type, beats: job.script?.beats ?? [], clips: job.render?.clips ?? [], seconds: job.render?.seconds ?? 0 };
  const sc = score(snap, video, peers);
  await q('UPDATE metrics SET score = $3 WHERE job_id = $1 AND win = $2', [jobId, win, sc]);
  const keyboard = sc.verdict === 'winner' ? [[{ text: '➕ Make 2 follow-ups', callback_data: `fu:${jobId}` }]] : undefined;
  office.finished('analyst', `#${jobId} at ${win}: ${VERDICT[sc.verdict]}, ${sc.reason}`, jobId);
  await say(scoreText(job, win, snap, sc), keyboard);
}

const VERDICT: Record<Score['verdict'], string> = { winner: '🏆 Winner', average: '🙂 Average', loser: '🔻 Loser', early: '⏳ Too early' };
const g = (x?: Grade) => (x ? ` (${x})` : '');
const n1 = (x?: number) => (x === undefined ? '–' : x >= 10 ? String(Math.round(x)) : x.toFixed(1));

export function scoreText(job: Pick<JobInfo, 'id' | 'title' | 'youtube_video_id'>, win: string, s: Snapshot, sc: Score): string {
  const v = sc.values;
  const lines = [
    `📊 <b>#${job.id} · ${win}</b> · ${esc(job.title ?? '')}`,
    `${VERDICT[sc.verdict]}: ${esc(sc.reason)}`,
    `<b>YouTube</b> ${(v.views ?? 0).toLocaleString('en-US')} views · stayed ${n1(v.stay)}%${g(sc.grades.stay)} · watched ${n1(v.finish)}%${g(sc.grades.finish)} · ${n1(v.shares)} shares/1k${g(sc.grades.shares)} · ${n1(v.subs)} subs/1k${g(sc.grades.subs)}`,
  ];
  if (s.ig?.error) lines.push(`<b>Instagram</b> no insights: ${esc(s.ig.error.slice(0, 160))}`);
  else if (s.ig) lines.push(`<b>Instagram</b>${s.ig.age_hours !== undefined ? ` (Reel ${s.ig.age_hours}h old)` : ''} ${(s.ig.reach ?? 0).toLocaleString('en-US')} reached · skip ${n1(v.ig_skip)}%${g(sc.grades.ig_skip)} · watch ${n1(v.ig_watch_sec)} s${g(sc.grades.ig_watch)} · share ${n1(v.ig_share)}%${g(sc.grades.ig_share)}`);
  if (sc.drop) lines.push(`<b>Biggest drop</b> −${Math.round(sc.drop.loss * 100)} pts at ${mmss(sc.drop.from)}–${mmss(sc.drop.to)}, beat ${sc.drop.beat + 1}: "${esc(sc.drop.line)}"`);
  for (const f of sc.fixes) lines.push(`👉 ${esc(f)}`);
  if (sc.verdict === 'winner') lines.push('👉 Tap below for 2 follow-ups with the same story shape.');
  if (sc.relative !== undefined) lines.push(`<i>${sc.relative.toFixed(1)}× your median engaged views at ${win}. Bands are your own once ${10} videos have a ${win} snapshot (${sc.peers} now).</i>`);
  return lines.join('\n');
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function weeklyReport(): Promise<string> {
  return office.track('analyst', 'Writing the weekly report and re-tuning hooks and length', weeklyReportInner, () => 'Weekly report sent to Telegram');
}

async function weeklyReportInner(): Promise<string> {
  const rows = await q<{ id: number; format: Format; voice: string; hook_type: string; length_band: string; title: string; views: number; avg_view_pct: number; win: string }>(
    `SELECT DISTINCT ON (j.id) j.id, j.format, j.voice, j.hook_type, j.length_band, j.packaging->>'title' AS title, m.views, m.avg_view_pct, m.win
     FROM jobs j JOIN metrics m ON m.job_id = j.id
     WHERE j.published_at > now() - interval '28 days'
     ORDER BY j.id, CASE m.win WHEN '7d' THEN 1 WHEN '72h' THEN 2 ELSE 3 END`);
  const ideas = await q<{ question: string; format: string; source: string }>(`SELECT question, format, source FROM topics WHERE status = 'idea' ORDER BY (source='launch') DESC, priority DESC LIMIT 5`);
  if (!rows.length) {
    const text = '<b>Weekly report</b>\nNo measured videos yet. Use /link after each upload so analytics can track them.';
    await say(text);
    return text;
  }
  const verdicts = await q<{ verdict: string; n: number }>(
    `SELECT score->>'verdict' AS verdict, count(*)::int AS n FROM (
       SELECT DISTINCT ON (m.job_id) m.score FROM metrics m JOIN jobs j ON j.id = m.job_id
       WHERE j.published_at > now() - interval '28 days' AND m.score IS NOT NULL
       ORDER BY m.job_id, CASE m.win WHEN '7d' THEN 1 WHEN '72h' THEN 2 ELSE 3 END) s
     GROUP BY 1 ORDER BY 2 DESC`);
  const verdictLine = verdicts.map((v) => `${v.verdict} ${v.n}`).join(' · ') || 'none scored yet';
  const tuneLines = await autoTune().catch((e) => [`Auto-tuning failed: ${esc(String(e.message ?? e))}`]);
  const sorted = [...rows].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const cut = sorted[Math.max(0, Math.floor(sorted.length * 0.2) - 1)]?.views ?? Infinity;
  const line = (r: (typeof rows)[number]) => `#${r.id} ${esc(r.title ?? '')} · ${(r.views ?? 0).toLocaleString('en-US')} views${r.avg_view_pct ? ` · ${Math.round(r.avg_view_pct)}% viewed` : ''} (${r.win})${(r.views ?? 0) >= cut ? ' 🏆' : ''}`;
  const group = (key: 'format' | 'voice' | 'hook_type' | 'length_band') => {
    const g = new Map<string, number[]>();
    for (const r of rows) if (r[key]) g.set(String(r[key]), [...(g.get(String(r[key])) ?? []), r.views ?? 0]);
    return [...g.entries()].map(([k, v]) => `${key === 'format' ? FORMAT_NAMES[k as Format] ?? k : k}: median ${Math.round(median(v)).toLocaleString('en-US')} (${v.length} video${v.length === 1 ? '' : 's'})`).join('\n');
  };
  const text = [
    '<b>Weekly report</b> (last 28 days)',
    '', '<b>Top 5</b>', ...sorted.slice(0, 5).map(line),
    ...(sorted.length > 5 ? ['', '<b>Bottom 5</b>', ...sorted.slice(-5).reverse().map(line)] : []),
    '', '<b>By format</b>', group('format'),
    '', '<b>By voice</b>', group('voice'),
    group('hook_type') ? `\n<b>By hook type</b>\n${group('hook_type')}` : '',
    group('length_band') ? `\n<b>By length</b>\n${group('length_band')}` : '',
    '', '<b>Next in the queue</b>', ...ideas.map((i) => `· ${esc(i.question)} (${i.format}${i.source !== 'discover' ? `, ${i.source}` : ''})`),
    '', '<b>Verdicts</b>', verdictLine,
    '', '<b>Auto-tuning</b>', ...tuneLines,
    '', `🏆 = top 20% by views. Send <code>/followup &lt;id&gt;</code> for each winner, <code>/tune</code> to see or undo the weights.`,
  ].filter((l) => l !== undefined).join('\n');
  await say(text);
  await writeExport().catch((e) => console.error('[export]', e.message));
  return text;
}


// Layer 2: the weekly numbers as JSON for Claude's review, at an unguessable path on the media
// domain. Off by default (ANALYSIS_EXPORT=off): the privacy page says API data is never shared,
// so it stays off until the YouTube API audit is approved and the page says otherwise.
export async function writeExport(): Promise<void> {
  const dir = path.join(config.mediaDir, 'analysis');
  if (!config.analysisExport || config.analysisExportToken.length < 24) {
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }
  const rows = await q(
    `SELECT j.id, j.format, j.voice, j.hook_type, j.length_band, j.published_at, j.packaging->>'title' AS title,
       (j.render->>'seconds')::numeric AS seconds,
       json_agg(json_build_object('win', m.win, 'views', m.views, 'engaged_views', m.engaged_views, 'avg_view_pct', m.avg_view_pct,
         'likes', m.likes, 'shares', m.shares, 'subs_gained', m.subs_gained, 'ig', m.ig, 'score', m.score) ORDER BY m.captured_at) AS snapshots
     FROM jobs j JOIN metrics m ON m.job_id = j.id
     WHERE j.published_at > now() - interval '28 days'
     GROUP BY j.id ORDER BY j.id`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${config.analysisExportToken}.json`);
  await fs.writeFile(file, JSON.stringify({ generated_at: new Date().toISOString(), channel: config.channelName, tune: await getTune(), videos: rows }, null, 1));
}

// WF5's channel totals for the studio's YPP wall: subscriber count (Data API), Shorts views per day
// for the last 90 days and long-form watch time for the last 365 days (Analytics API). A subscriber
// history, one point per day, gives the pace for the qualifying date.
export interface ChannelStats {
  subs: number | null;
  shorts_daily: [string, number][]; // [YYYY-MM-DD, views], oldest first
  shorts_views_90d: number | null;
  longform_hours_365d: number | null;
  fetched_at: string;
  history: { d: string; subs: number }[];
}

export async function storeChannel(body: any): Promise<void> {
  const old = await getSetting<ChannelStats>('channel');
  const num = (v: any) => (v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));
  const subs = num(body.channel?.items?.[0]?.statistics?.subscriberCount);
  const daily = analyticsRows(body.shorts);
  // Rows are split by day and content type ("shorts", "videoOnDemand", …); keep the Shorts views per day.
  const isShorts = (r: Record<string, string | number>) => String(r.creatorContentType ?? '').toLowerCase() === 'shorts';
  const perDay = new Map<string, number>();
  for (const r of daily) if (r.day && isShorts(r)) perDay.set(String(r.day), (perDay.get(String(r.day)) ?? 0) + (Number(r.views) || 0));
  const shortsDaily = [...perDay].sort((a, b) => a[0].localeCompare(b[0]));
  // One row per content type; everything but Shorts counts toward the long-form watch-hours path.
  const longRows = analyticsRows(body.longform).filter((r) => !isShorts(r));
  const minutes = longRows.length ? longRows.reduce((a, r) => a + (Number(r.estimatedMinutesWatched) || 0), 0) : undefined;
  const today = ymd(new Date());
  const history = [...(old?.history ?? []).filter((h) => h.d !== today), ...(subs !== null ? [{ d: today, subs }] : [])].slice(-400);
  const stats: ChannelStats = {
    subs: subs ?? old?.subs ?? null,
    shorts_daily: shortsDaily.length ? shortsDaily : old?.shorts_daily ?? [],
    shorts_views_90d: shortsDaily.length ? shortsDaily.reduce((a, [, v]) => a + v, 0) : old?.shorts_views_90d ?? null,
    longform_hours_365d: minutes !== undefined && !isNaN(Number(minutes)) ? Number(minutes) / 60 : old?.longform_hours_365d ?? null,
    fetched_at: new Date().toISOString(),
    history,
  };
  await setSetting('channel', stats);
}

function analyticsRows(a: any): Record<string, string | number>[] {
  const headers: string[] = (a?.columnHeaders ?? []).map((h: any) => h.name);
  return (a?.rows ?? []).map((row: any[]) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
}
