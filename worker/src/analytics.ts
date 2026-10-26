// WF5's data: which videos need a 24h / 72h / 7d snapshot, storing what n8n fetched from the
// YouTube APIs, and the Sunday report.
import { FORMAT_NAMES, type Format } from './config.js';
import { q } from './db.js';
import { esc, say } from './telegram.js';

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
  await q(
    `INSERT INTO metrics (job_id, win, views, engaged_views, avg_view_pct, avg_view_sec, likes, shares, comments, subs_gained, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (job_id, win) DO UPDATE SET captured_at = now(), views = EXCLUDED.views, engaged_views = EXCLUDED.engaged_views,
       avg_view_pct = EXCLUDED.avg_view_pct, avg_view_sec = EXCLUDED.avg_view_sec, likes = EXCLUDED.likes, shares = EXCLUDED.shares,
       comments = EXCLUDED.comments, subs_gained = EXCLUDED.subs_gained, raw = EXCLUDED.raw`,
    [
      body.job_id, body.win,
      num(stats.viewCount) ?? num(a.views),
      num(a.engagedViews),
      num(a.averageViewPercentage),
      num(a.averageViewDuration),
      num(stats.likeCount) ?? num(a.likes),
      num(a.shares),
      num(stats.commentCount) ?? num(a.comments),
      num(a.subscribersGained),
      body,
    ],
  );
  if (body.win === '72h') await studioReminder(Number(body.job_id));
}

// "Viewed vs swiped away" and the retention graph are only in Studio, so after the 72h snapshot
// the bot asks for a look at the videos that need one: the first 10, and later any below the median.
async function studioReminder(jobId: number): Promise<void> {
  const rows = await q<{ job_id: number; views: number }>(
    `SELECT m.job_id, m.views FROM metrics m JOIN jobs j ON j.id = m.job_id
     WHERE m.win = '72h' AND j.published_at > now() - interval '28 days'`);
  const me = rows.find((r) => r.job_id === jobId);
  const job = (await q<{ youtube_video_id: string; title: string }>(`SELECT youtube_video_id, packaging->>'title' AS title FROM jobs WHERE id = $1`, [jobId]))[0];
  if (!me || !job?.youtube_video_id) return;
  const others = rows.filter((r) => r.job_id !== jobId).map((r) => r.views ?? 0);
  const below = (me.views ?? 0) < median(others);
  if (others.length >= 10 && !below) return;
  await say([
    `📊 <b>#${jobId} is 3 days old</b> · ${esc(job.title ?? '')} · ${(me.views ?? 0).toLocaleString('en-US')} views${below ? ' (below your median)' : ''}`,
    `Open <a href="https://studio.youtube.com/video/${job.youtube_video_id}/analytics/tab-overview/period-default">its analytics in Studio</a> and screenshot:`,
    '1. <b>Viewed vs. swiped away</b> (Engagement tab)',
    '2. <b>The audience retention graph</b>',
    'Send both to Claude in the project, so it can find where viewers leave.',
  ].join('\n'));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function weeklyReport(): Promise<string> {
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
    '', `🏆 = top 20%. Send <code>/followup &lt;id&gt;</code> for each winner.`,
    `Views from the YouTube API; "viewed vs swiped" is only in Studio, so check it there.`,
  ].filter((l) => l !== undefined).join('\n');
  await say(text);
  return text;
}

