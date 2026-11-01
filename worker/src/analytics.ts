// WF5's data: which videos need a 24h / 72h / 7d snapshot, storing what n8n fetched from the
// YouTube APIs (plus the Reel's Instagram insights), the scorecard message for each snapshot,
// and the Sunday report with auto-tuning.
import { config, FORMAT_NAMES, type Format } from './config.js';
import { getSetting, q, setSetting } from './db.js';
import { esc, say } from './telegram.js';
import { ig, igToken } from './publish.js';
import { score, mmss, nextStep, quantile, MIN_SAMPLE, STAGE_NAME, type Grade, type IgInsights, type Score, type Snapshot, type StepContext, type VideoInfo } from './scorecard.js';
import { autoFollowup, hasFollowups, queueFollowup } from './followups.js';
import type { Keyboard } from './telegram.js';
import { isCurrent, versionOf, versionName } from './changes.js';
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
// "Mon 16 Nov" in Niko's time zone.
const day = (d: Date | number) => new Intl.DateTimeFormat('en-GB', { timeZone: config.localTz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));
const ANALYTICS_LAG_DAYS = 3; // YouTube Analytics runs 2–3 days behind, so a window's scorecard comes about this much later

// YouTube Analytics lags 2–3 days behind Studio, so a snapshot taken on time often has no engaged
// views yet. Such a snapshot is fetched again every run until the data arrives (or RETRY_HOURS run
// out). The report always ends on the window's own last day, so a late or backfilled "24h" still
// measures day one, not everything up to today.
const RETRY_HOURS = 96;

export async function dueSnapshots() {
  await nagUnlinked().catch((e) => console.error('[nag]', e.message));
  const jobs = await q<{ id: number; youtube_video_id: string; published_at: Date }>(
    `SELECT id, youtube_video_id, published_at FROM jobs WHERE youtube_video_id IS NOT NULL AND published_at IS NOT NULL AND published_at > now() - interval '30 days'`);
  const have = new Map((await q<{ job_id: number; win: string; ready: boolean; captured_at: Date }>(
    'SELECT job_id, win, engaged_views IS NOT NULL AS ready, captured_at FROM metrics')).map((m) => [`${m.job_id}:${m.win}`, m]));
  const out: { job_id: number; video_id: string; win: string; start_date: string; end_date: string }[] = [];
  for (const j of jobs) {
    const pub = +new Date(j.published_at);
    for (const w of WINDOWS) {
      const at = pub + w.hours * 3600_000;
      if (at > Date.now()) break;
      const m = have.get(`${j.id}:${w.win}`);
      // 12 h past RETRY_HOURS leaves room for the final run that sends the scorecard anyway.
      const retry = m && !m.ready && Date.now() < at + (RETRY_HOURS + 12) * 3600_000 && Date.now() - +new Date(m.captured_at) > 5 * 3600_000;
      if (!m || retry) {
        out.push({ job_id: j.id, video_id: j.youtube_video_id, win: w.win, start_date: ymd(new Date(pub)), end_date: ymd(new Date(Math.min(at, Date.now()))) });
        break; // one window per video per run; the next run catches up
      }
    }
  }
  return out.slice(0, 40);
}

// Approved videos whose slot has passed without a /link get no scorecard or Instagram post, so the
// bot asks for the link: once a day, at most 3 times per video.
async function nagUnlinked(): Promise<void> {
  const rows = await q<{ id: number; title: string | null; slot_at: Date }>(
    `SELECT id, packaging->>'title' AS title, slot_at FROM jobs
     WHERE status = 'approved' AND youtube_video_id IS NULL AND slot_at < now() - interval '2 hours' AND slot_at > now() - interval '14 days'
     ORDER BY slot_at`);
  if (!rows.length) return;
  const asked = (await getSetting<Record<string, { n: number; at: string }>>('link_nag')) ?? {};
  const due = rows.filter((r) => (asked[r.id]?.n ?? 0) < 3 && Date.now() - +new Date(asked[r.id]?.at ?? 0) > 22 * 3600_000);
  if (!due.length) return;
  for (const r of due) asked[r.id] = { n: (asked[r.id]?.n ?? 0) + 1, at: new Date().toISOString() };
  await setSetting('link_nag', asked);
  await say([
    `🔗 <b>${due.length === 1 ? 'One video has' : `${due.length} videos have`} no link yet</b>, so I can't score ${due.length === 1 ? 'it' : 'them'}:`,
    ...due.map((r) => `#${r.id} ${esc(r.title ?? '')} (slot ${ymd(new Date(r.slot_at))}): <code>/link ${r.id} </code>+ its YouTube link`),
    'Skipped one on purpose? Ignore this; I ask at most 3 times.',
  ].join('\n'));
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
  // videos.list statistics are lifetime totals; for a snapshot taken well after its window the
  // Analytics row (which ends on the window's last day) is the honest number.
  const pub = (await q<{ published_at: Date }>('SELECT published_at FROM jobs WHERE id = $1', [jobId]))[0]?.published_at;
  // YouTube's own publish time beats the slot or the moment of /link (videos linked days late got
  // the link time). A wrong start shifts every window, so fix it and measure again from scratch.
  const ytPub = body.stats?.items?.[0]?.snippet?.publishedAt;
  if (ytPub && pub && Math.abs(+new Date(ytPub) - +new Date(pub)) > 3600_000) {
    await q(
      `UPDATE jobs SET published_at = $2,
         ig_due_at = CASE WHEN ig_status IS NULL THEN $2::timestamptz + make_interval(hours => $3) ELSE ig_due_at END WHERE id = $1`,
      [jobId, ytPub, config.instagramDelayHours]);
    await q('DELETE FROM metrics WHERE job_id = $1', [jobId]);
    office.finished('analyst', `#${jobId}: publish time corrected to ${ytPub}, measuring again`, jobId);
    return;
  }
  const hours = WINDOWS.find((w) => w.win === body.win)?.hours ?? 0;
  const late = !!pub && Date.now() > +new Date(pub) + (hours + 30) * 3600_000 && a.views !== undefined && !isNaN(a.views);
  const life = (v: any) => (late ? null : num(v));
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
      life(stats.viewCount) ?? num(a.views),
      num(a.engagedViews),
      num(a.averageViewPercentage),
      num(a.averageViewDuration),
      life(stats.likeCount) ?? num(a.likes),
      num(a.shares),
      life(stats.commentCount) ?? num(a.comments),
      num(a.subscribersGained),
      body,
      curve ? JSON.stringify(curve) : null,
      ig,
    ],
  );
  await scoreAndTell(jobId, body.win, pub ? +new Date(pub) + (hours + RETRY_HOURS) * 3600_000 : 0, late);
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

type JobInfo = { id: number; title: string | null; hook_type: string | null; opening: string | null; script: { beats: Beat[] } | null; render: { clips: VoiceClip[]; seconds: number } | null; youtube_video_id: string };

// Scores a fresh snapshot against the bands and the channel's other videos, saves the verdict and
// tells you in Telegram what it means and what (if anything) has to happen. Winners get their
// follow-ups queued automatically.
async function scoreAndTell(jobId: number, win: string, retryUntil = 0, late = false): Promise<void> {
  const job = (await q<JobInfo & { format: string; published_at: Date | null; created_at: Date }>(`SELECT id, packaging->>'title' AS title, hook_type, opening, format, published_at, created_at, script, render, youtube_video_id FROM jobs WHERE id = $1`, [jobId]))[0];
  const snap = (await q<Snapshot>('SELECT * FROM metrics WHERE job_id = $1 AND win = $2', [jobId, win]))[0];
  if (!job || !snap) return;
  const peers = await q<Snapshot>(
    `SELECT m.* FROM metrics m JOIN jobs j ON j.id = m.job_id
     WHERE m.win = $1 AND m.job_id <> $2 AND j.published_at > now() - interval '90 days'`, [win, jobId]);
  const video: VideoInfo = { hook_type: job.hook_type, beats: job.script?.beats ?? [], clips: job.render?.clips ?? [], seconds: job.render?.seconds ?? 0 };
  const sc = score(snap, video, peers);
  await q('UPDATE metrics SET score = $3 WHERE job_id = $1 AND win = $2', [jobId, win, sc]);
  if (snap.engaged_views === null && Date.now() < retryUntil) {
    // YouTube Analytics hasn't caught up yet; the next WF5 run fetches this window again.
    office.finished('analyst', `#${jobId} at ${win}: waiting for YouTube Analytics to catch up`, jobId);
    return;
  }
  office.finished('analyst', `#${jobId} at ${win}: ${VERDICT[sc.verdict]}, ${sc.reason}`, jobId);
  const ctx: StepContext = { win };
  const i = WINDOWS.findIndex((w) => w.win === win);
  const nextWin = WINDOWS[i + 1];
  if (nextWin && job.published_at) {
    const at = +new Date(job.published_at) + nextWin.hours * 3600_000 + ANALYTICS_LAG_DAYS * 86_400_000;
    ctx.next = { win: nextWin.win, at: day(Math.max(at, Date.now() + 86_400_000)) };
  }
  if (sc.verdict === 'winner') ctx.followups = await autoFollowup(jobId).catch(() => undefined);
  const t = await openingTest().catch(() => undefined);
  if (t) ctx.openingTest = { decided: !!t.decided, readBy: t.readBy };
  const made = isCurrent(job.format, job.created_at) ? null : `Made with an earlier version (${versionName(versionOf(job.format, job.created_at))}), so it shows how that version did, not what to change now.`;
  await say(scoreText(job, win, snap, sc, late, [made, nextStep(sc, ctx)].filter(Boolean).join(' ')));
}

const VERDICT: Record<Score['verdict'], string> = { winner: '🏆 Winner', average: '🙂 Average', loser: '🔻 Loser', early: '⏳ Too early' };
const g = (x?: Grade) => (x ? ` (${x})` : '');
const n1 = (x?: number) => (x === undefined ? '–' : x >= 10 ? String(Math.round(x)) : x.toFixed(1));

export function scoreText(job: Pick<JobInfo, 'id' | 'title' | 'youtube_video_id'> & { opening?: string | null }, win: string, s: Snapshot, sc: Score, late = false, step?: string): string {
  const v = sc.values;
  const lines = [
    `📊 <b>#${job.id} · ${win}</b>${late ? ' (caught up)' : ''} · ${esc(job.title ?? '')}${job.opening ? ` · ${OPENING_LABEL[job.opening] ?? job.opening} opening` : ''}`,
    `${VERDICT[sc.verdict]}: ${esc(sc.reason)}`,
    `<b>YouTube</b> ${(v.views ?? 0).toLocaleString('en-US')} views · stayed ${n1(v.stay)}%${g(sc.grades.stay)} · watched ${n1(v.finish)}%${g(sc.grades.finish)} · ${n1(v.shares)} shares/1k${g(sc.grades.shares)} · ${n1(v.subs)} subs/1k${g(sc.grades.subs)}`,
  ];
  if (s.ig?.error) lines.push(`<b>Instagram</b> no insights: ${esc(s.ig.error.slice(0, 160))}`);
  else if (s.ig) lines.push(`<b>Instagram</b>${s.ig.age_hours !== undefined ? ` (Reel ${s.ig.age_hours}h old)` : ''} ${(s.ig.reach ?? 0).toLocaleString('en-US')} reached · skip ${n1(v.ig_skip)}%${g(sc.grades.ig_skip)} · watch ${n1(v.ig_watch_sec)} s${g(sc.grades.ig_watch)} · share ${n1(v.ig_share)}%${g(sc.grades.ig_share)}`);
  if (sc.drop) lines.push(`<b>Biggest drop</b> −${Math.round(sc.drop.loss * 100)} pts at ${mmss(sc.drop.from)}–${mmss(sc.drop.to)}, beat ${sc.drop.beat + 1}: "${esc(sc.drop.line)}"`);
  for (const w of sc.why ?? []) lines.push(`<b>Why</b> ${esc(w)}`);
  if (sc.relative !== undefined) lines.push(`<i>${sc.relative.toFixed(1)}× your median engaged views at ${win}.</i>`);
  if (step) lines.push(`<b>Your move:</b> ${esc(step)}`);
  return lines.join('\n');
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The Map Reveal opening test (opening.ts): "stayed" (engaged views ÷ views) at 72 h, rank strip
// against classic. It is read once both openings have 5 videos with 72 h numbers; before that,
// topic luck moves the medians more than an opening can, so the answer is "too early". Then a
// lead of 10 points or more decides it. Without such a lead it runs on to 10 videos each, and
// then whichever is ahead wins. Every message ends with the verdict and the one tap it needs.
const OPENING_MIN = 5;
const OPENING_MAX = 10;
const OPENING_BAR = 10; // points of "stayed"
const OPENING_LAG_DAYS = 5; // the 72 h window, plus YouTube Analytics running 2–3 days behind
const OPENING_LABEL: Record<string, string> = { rank_strip: 'rank strip', classic: 'classic' };
export type OpeningChoice = 'rank_strip' | 'classic';

export interface OpeningArm { key: string; label: string; n: number; median: number | null; pending: number; due: number | null; pendingAt: number[] }
export interface OpeningTest {
  arms: OpeningArm[]; ready: boolean; lead: number | null; min: number; bar: number; lines: string[];
  decided: OpeningChoice | null; // already settled: by the Apply button or MR_OPENING in .env
  apply: OpeningChoice | null; // the test has a verdict that hasn't been applied yet: offer the button
  readBy: string | null; // when the next read is due, e.g. "Mon 16 Nov"
}

// The opening chosen with the Apply button; it beats MR_OPENING in .env.
export async function chosenOpening(): Promise<OpeningChoice | null> {
  const s = await getSetting<{ value: OpeningChoice; at: string }>('mr_opening');
  if (s?.value === 'rank_strip' || s?.value === 'classic') return s.value;
  return config.mrOpening === 'alternate' ? null : config.mrOpening;
}

export async function applyOpening(value: OpeningChoice): Promise<string> {
  await setSetting('mr_opening', { value, at: new Date().toISOString() });
  return `✅ Done: every new Map Reveal now uses the ${OPENING_LABEL[value]} opening. Nothing else to do; no restart needed.`;
}

type OpeningRow = { opening: string; at: Date | null; views: number | null; engaged: number | null };

// The pure part of the read, so it can be checked without a database.
export function readOpening(rows: OpeningRow[], decided: OpeningChoice | null, now = Date.now()): OpeningTest {
  const arms = ['rank_strip', 'classic'].map((key): OpeningArm => {
    const mine = rows.filter((r) => r.opening === key);
    const measured = mine.filter((r) => r.views && r.engaged !== null);
    const stays = measured.map((r) => Math.min(100, (r.engaged! / r.views!) * 100));
    const pendingAt = mine.filter((r) => !measured.includes(r) && r.at).map((r) => +new Date(r.at!)).sort((a, b) => a - b);
    const short = OPENING_MIN - stays.length;
    const due = short > 0 && pendingAt.length >= short ? pendingAt[short - 1] + OPENING_LAG_DAYS * 86_400_000 : null;
    return { key, label: OPENING_LABEL[key][0].toUpperCase() + OPENING_LABEL[key].slice(1), n: stays.length, median: stays.length ? median(stays) : null, pending: pendingAt.length, due, pendingAt };
  });
  const [strip, classic] = arms;
  const ready = arms.every((a) => a.n >= OPENING_MIN);
  const full = arms.every((a) => a.n >= OPENING_MAX);
  const lead = strip.median !== null && classic.median !== null ? strip.median - classic.median : null;
  const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x)}%`);
  // When each arm reaches `target` measured videos, if enough are already out or booked.
  const dueFor = (target: number) => {
    let latest = 0;
    for (const a of arms) {
      const short = target - a.n;
      if (short <= 0) continue;
      if (a.pendingAt.length < short) return { at: null, missing: arms.filter((x) => x.n + x.pendingAt.length < target).map((x) => `${x.label} needs ${target - x.n - x.pendingAt.length} more made`) };
      latest = Math.max(latest, a.pendingAt[short - 1] + OPENING_LAG_DAYS * 86_400_000);
    }
    return { at: latest ? Math.max(latest, now) : null, missing: [] as string[] };
  };
  const lines = arms.map((a) => `${a.label}: ${a.n} of ${ready ? OPENING_MAX : OPENING_MIN} videos measured${a.pending ? ` (${a.pending} more out or booked)` : ''} · median stayed ${pct(a.median)}`);
  let apply: OpeningChoice | null = null;
  let readBy: string | null = null;
  const when = (target: number) => {
    const d = dueFor(target);
    readBy = d.at ? day(d.at) : null;
    return d.at ? `It should be readable around ${readBy}.` : `The bot makes the missing videos itself (${d.missing.join(', ')}), so the date follows once they are booked.`;
  };
  if (decided) {
    lines.push(`✅ Decided: ${OPENING_LABEL[decided]} is the only Map Reveal opening now. Nothing for you to do.`);
  } else if (!ready) {
    lines.push(`⏳ Too early to read: each opening needs ${OPENING_MIN} Map Reveal videos with 72 h numbers. ${when(OPENING_MIN)} Nothing for you to do; leave both openings as they are until then.`);
  } else if (lead! >= OPENING_BAR || lead! <= -OPENING_BAR) {
    apply = lead! > 0 ? 'rank_strip' : 'classic';
    lines.push(`${apply === 'rank_strip' ? '✅' : '🔻'} Verdict: the rank strip keeps ${Math.round(Math.abs(lead!))} points ${lead! > 0 ? 'more' : 'fewer'} viewers. Your move: tap "Use ${OPENING_LABEL[apply]} only" below. That is all; no restart needed.`);
  } else if (full) {
    apply = lead! >= 0 ? 'rank_strip' : 'classic';
    lines.push(`Verdict: no real difference after ${OPENING_MAX} videos each (${lead! >= 0 ? '+' : ''}${Math.round(lead!)} points for the rank strip), so keep the one that is ahead. Your move: tap "Use ${OPENING_LABEL[apply]} only" below. That is all; no restart needed.`);
  } else {
    lines.push(`⏳ No clear winner yet (${lead! >= 0 ? '+' : ''}${Math.round(lead!)} points; it takes ${OPENING_BAR}), so the test runs on to ${OPENING_MAX} videos each. ${when(OPENING_MAX)} Nothing for you to do.`);
  }
  return { arms, ready, lead, min: OPENING_MIN, bar: OPENING_BAR, lines, decided, apply, readBy };
}

export async function openingTest(): Promise<OpeningTest> {
  const rows = await q<OpeningRow>(
    `SELECT j.opening, COALESCE(j.published_at, j.slot_at) AS at, m.views, m.engaged_views AS engaged
     FROM jobs j LEFT JOIN metrics m ON m.job_id = j.id AND m.win = '72h'
     WHERE j.format = 'MAP_REVEAL' AND j.opening IS NOT NULL AND j.status IN ('approved', 'published')`);
  return readOpening(rows, await chosenOpening());
}

export const openingKeyboard = (t: OpeningTest): Keyboard | undefined =>
  t.apply ? [[{ text: `✅ Use ${OPENING_LABEL[t.apply]} only`, callback_data: `op:0:${t.apply}` }]] : undefined;

export async function weeklyReport(): Promise<string> {
  return office.track('analyst', 'Writing the weekly report and re-tuning hooks and length', weeklyReportInner, () => 'Weekly report sent to Telegram');
}

// The channel-wide call in the Sunday report: the first funnel stage (stay → finish → shares →
// subs) that most measured videos fail. It only speaks with 5+ videos past MIN_SAMPLE views, and
// it never asks for a change to what the opening test is measuring before the test is read.
const CHANNEL_MIN = 5;
export interface ChannelCall { kind: 'wait' | 'ok' | 'change'; text: string }

export interface CallVideo { grades: Record<string, Grade | undefined>; current: boolean }

export function channelCall(videos: CallVideo[], opening: Pick<OpeningTest, 'decided' | 'readBy'> | undefined): ChannelCall {
  // Only videos made with the current recipe of their format can say what to change next.
  const old = videos.filter((v) => !v.current && v.grades.stay !== undefined).length;
  const graded = videos.filter((v) => v.current).map((v) => v.grades).filter((g) => g.stay !== undefined);
  if (graded.length < CHANNEL_MIN) {
    return { kind: 'wait', text: `⏳ Too early for a channel-wide call: ${graded.length} of ${CHANNEL_MIN} videos made since the last change to their format have ${MIN_SAMPLE}+ views${old ? ` (${old} older video${old === 1 ? ' was' : 's were'} made with an earlier version, so ${old === 1 ? 'it shows' : 'they show'} how that version did, not what to change now)` : ''}. Nothing for you to do; it comes on its own as views grow.` };
  }
  const bad = (x?: Grade) => x === 'kill' || x === 'weak';
  const failing = ['stay', 'finish', 'shares', 'subs'].find((k) => graded.filter((g) => bad(g[k])).length * 2 > graded.length);
  if (!failing) return { kind: 'ok', text: `✅ On target across ${graded.length} videos made with the current version. Nothing to change and nothing for you to do.` };
  const count = graded.filter((g) => bad(g[failing])).length;
  const share = `${count} of ${graded.length} videos made with the current version are weak on ${STAGE_NAME[failing]}`;
  if (failing === 'stay' && !opening?.decided) {
    return { kind: 'wait', text: `⏳ ${share}. That is what the Map Reveal opening test is fixing, so nothing changes until it is read${opening?.readBy ? ` (around ${opening.readBy})` : ''}. Nothing for you to do.` };
  }
  const next = failing === 'stay'
    ? 'the next opening fix (Guess flags first, then the Countdown anchor)'
    : failing === 'finish' ? 'a shorter middle and an earlier reveal' : failing === 'shares' ? 'topics and endings that are worth sending on' : 'a clearer series hook in the title and end card';
  return { kind: 'change', text: `🛠 ${share}. Next step is ${next}, which is a code change Claude makes. Your move: forward this report to Claude in the project chat; that is all.${opening && !opening.decided ? ' The Map Reveal opening stays untouched until its test is read.' : ''}` };
}

async function weeklyReportInner(): Promise<string> {
  const rows = await q<{ id: number; format: Format; voice: string; hook_type: string; length_band: string; title: string; views: number; avg_view_pct: number; win: string; score: Score | null }>(
    `SELECT DISTINCT ON (j.id) j.id, j.format, j.voice, j.hook_type, j.length_band, j.packaging->>'title' AS title, m.views, m.avg_view_pct, m.win, m.score
     FROM jobs j JOIN metrics m ON m.job_id = j.id
     WHERE j.published_at > now() - interval '28 days'
     ORDER BY j.id, CASE m.win WHEN '7d' THEN 1 WHEN '72h' THEN 2 ELSE 3 END`);
  const ideas = await q<{ question: string; format: string; source: string }>(`SELECT question, format, source FROM topics WHERE status = 'idea' ORDER BY (source='launch') DESC, priority DESC LIMIT 5`);
  const unlinked = await q<{ id: number; title: string | null }>(
    `SELECT id, packaging->>'title' AS title FROM jobs
     WHERE status = 'approved' AND youtube_video_id IS NULL AND slot_at < now() - interval '2 hours' AND slot_at > now() - interval '14 days' ORDER BY id`);
  const linkLines = unlinked.map((r) => `<code>/link ${r.id} </code>+ the YouTube link of "${esc(r.title ?? '')}"`);
  if (!rows.length) {
    const text = ['<b>Weekly report</b>', linkLines.length
      ? `<b>Your move:</b> link ${linkLines.length === 1 ? 'this upload' : 'these uploads'} so I can measure ${linkLines.length === 1 ? 'it' : 'them'}:\n${linkLines.join('\n')}`
      : '<b>Your move:</b> ✅ Nothing. No video has numbers yet; the first scorecards come on their own.'].join('\n');
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
  const opening = await openingTest().catch((e): undefined => { console.error('[opening]', e.message); return undefined; });

  // Winners whose follow-ups haven't been made yet get them now (normally the scorecard already did).
  const winners = rows.filter((r) => r.score?.verdict === 'winner');
  const queued: number[] = [];
  for (const w of winners) if (!(await hasFollowups(w.id))) { await queueFollowup(w.id, true).catch(() => undefined); queued.push(w.id); }
  // Every measured video of the last 90 days, old ones included, each tagged with the version
  // (changes.ts) it was made with.
  const history = await q<{ id: number; format: string; made: Date; win: string; score: Score | null; views: number | null; engaged: number | null; apv: number | null }>(
    `SELECT DISTINCT ON (j.id) j.id, j.format, j.created_at AS made, m.win, m.score, m.views, m.engaged_views AS engaged, m.avg_view_pct AS apv
     FROM jobs j JOIN metrics m ON m.job_id = j.id
     WHERE j.published_at > now() - interval '90 days' AND m.win IN ('72h','7d')
     ORDER BY j.id, CASE m.win WHEN '7d' THEN 1 ELSE 2 END`);
  const call = channelCall(history.filter((r) => r.score).map((r) => ({ grades: r.score!.grades ?? {}, current: isCurrent(r.format, r.made) })), opening);
  const byVersion = new Map<string, { stay: number[]; apv: number[]; n: number }>();
  for (const r of history) {
    const k = `${FORMAT_NAMES[r.format as Format] ?? r.format} · ${versionName(versionOf(r.format, r.made))}${isCurrent(r.format, r.made) ? ' (current)' : ''}`;
    const b = byVersion.get(k) ?? { stay: [], apv: [], n: 0 };
    b.n++;
    if (r.views && r.views >= MIN_SAMPLE && r.engaged !== null) b.stay.push(Math.min(100, (r.engaged / r.views) * 100));
    if (r.apv !== null) b.apv.push(r.apv);
    byVersion.set(k, b);
  }
  const versionLines = [...byVersion.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, b]) =>
    `${esc(k)}: ${b.n} video${b.n === 1 ? '' : 's'} · median stayed ${b.stay.length ? `${Math.round(median(b.stay))}%` : '–'}${b.stay.length < b.n ? ` (${b.stay.length} with ${MIN_SAMPLE}+ views)` : ''} · watched ${b.apv.length ? `${Math.round(median(b.apv))}%` : '–'}`);

  // The top of the report: what Niko has to do, what was done for him, and what waits on data.
  const yours: string[] = [];
  if (linkLines.length) yours.push(`Link ${linkLines.length === 1 ? 'this upload' : 'these uploads'} so I can measure ${linkLines.length === 1 ? 'it' : 'them'}:\n${linkLines.join('\n')}`);
  if (opening?.apply) yours.push(`Tap "Use ${OPENING_LABEL[opening.apply]} only" below (Map Reveal opening test has a verdict).`);
  if (call.kind === 'change') yours.push('Forward this report to Claude in the project chat (see "Channel call").');
  const done = [
    queued.length ? `Queued 2 follow-ups each for winner${queued.length === 1 ? '' : 's'} ${queued.map((i) => `#${i}`).join(', ')}.` : '',
    winners.length && !queued.length ? `Winner${winners.length === 1 ? '' : 's'} ${winners.map((w) => `#${w.id}`).join(', ')} already ${winners.length === 1 ? 'has its' : 'have their'} follow-ups.` : '',
    'Re-weighted hook types and lengths toward what earns more views (details below).',
  ].filter(Boolean);
  const waiting = [
    opening && !opening.decided && !opening.apply && !call.text.includes('opening test') ? `Map Reveal opening test: ${opening.readBy ? `readable around ${opening.readBy}` : 'not readable yet'}.` : '',
    call.kind === 'wait' ? call.text.replace(/^⏳ /, '') : '',
  ].filter(Boolean);

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
    yours.length
      ? `<b>Your move (${yours.length} thing${yours.length === 1 ? '' : 's'}):</b>\n${yours.map((y, i) => `${i + 1}. ${y}`).join('\n')}`
      : '<b>Your move:</b> ✅ Nothing this week.',
    `<b>Done for you:</b> ${done.join(' ')}`,
    ...(waiting.length ? [`<b>Waiting on data:</b> ${esc(waiting.join(' '))}`] : []),
    '', '<b>Channel call</b>', esc(call.text),
    ...(versionLines.length ? ['', '<b>By version</b> (all videos of the last 90 days, at 72 h or 7 d)', ...versionLines] : []),
    '', '<b>Map Reveal opening test</b> (stayed at 72 h)', ...(opening?.lines ?? ['Could not read the test this week; it is retried next Sunday.']).map(esc),
    '', '<b>Top 5</b>', ...sorted.slice(0, 5).map(line),
    ...(sorted.length > 5 ? ['', '<b>Bottom 5</b>', ...sorted.slice(-5).reverse().map(line)] : []),
    '', '<b>By format</b>', group('format'),
    '', '<b>By voice</b>', group('voice'),
    group('hook_type') ? `\n<b>By hook type</b>\n${group('hook_type')}` : '',
    group('length_band') ? `\n<b>By length</b>\n${group('length_band')}` : '',
    '', '<b>Next in the queue</b>', ...ideas.map((i) => `· ${esc(i.question)} (${i.format}${i.source !== 'discover' ? `, ${i.source}` : ''})`),
    '', '<b>Verdicts</b>', verdictLine,
    '', '<b>Auto-tuning</b> (done automatically)', ...tuneLines,
    '', '<i>🏆 = top 20% by views.</i>',
  ].filter((l) => l !== undefined).join('\n');
  await say(text, opening ? openingKeyboard(opening) : undefined);
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
  history: { d: string; subs: number; views?: number }[]; // views: the channel's public view counter
}

export async function storeChannel(body: any): Promise<void> {
  const old = await getSetting<ChannelStats>('channel');
  const num = (v: any) => (v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));
  const subs = num(body.channel?.items?.[0]?.statistics?.subscriberCount);
  // The public view counter (Data API) is near real time; Analytics runs 2–3 days behind.
  const counter = num(body.channel?.items?.[0]?.statistics?.viewCount);
  const daily = analyticsRows(body.shorts);
  // Rows are split by day and content type ("shorts", "videoOnDemand", …); keep the Shorts views per day.
  const isShorts = (r: Record<string, string | number>) => String(r.creatorContentType ?? '').toLowerCase() === 'shorts';
  const perDay = new Map<string, number>();
  for (const r of daily) if (r.day && isShorts(r)) perDay.set(String(r.day), (perDay.get(String(r.day)) ?? 0) + (Number(r.views) || 0));
  const shortsDaily = [...perDay].sort((a, b) => a[0].localeCompare(b[0]));
  // One row per content type; everything but Shorts counts toward the long-form watch-hours path.
  const longRows = analyticsRows(body.longform).filter((r) => !isShorts(r));
  const minutes = body.longform?.columnHeaders ? longRows.reduce((a, r) => a + (Number(r.estimatedMinutesWatched) || 0), 0) : undefined;
  const today = ymd(new Date());
  const history = [...(old?.history ?? []).filter((h) => h.d !== today), ...(subs !== null ? [{ d: today, subs, ...(counter !== null ? { views: counter } : {}) }] : [])].slice(-400);
  // Fill the Analytics lag with what the counter gained since the last day Analytics has: the
  // counter's value stored for that day is its last reading of the day. Until such a reading exists,
  // a channel with only Shorts and no long-form minutes can use the counter itself (all its views
  // are Shorts, and its lifetime is under 90 days for now).
  const analyticsViews = shortsDaily.length ? shortsDaily.reduce((a, [, v]) => a + v, 0) : null;
  const lastDay = shortsDaily.at(-1)?.[0];
  const atLastDay = history.find((h) => h.d === lastDay)?.views;
  let shorts = analyticsViews ?? old?.shorts_views_90d ?? null;
  if (analyticsViews !== null && counter !== null) {
    if (atLastDay !== undefined) shorts = analyticsViews + Math.max(0, counter - atLastDay);
    else if (!minutes) shorts = Math.max(analyticsViews, counter);
  }
  const stats: ChannelStats = {
    subs: subs ?? old?.subs ?? null,
    shorts_daily: shortsDaily.length ? shortsDaily : old?.shorts_daily ?? [],
    shorts_views_90d: shorts,
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

// /videos: every video of the last 30 days, whether it is linked, and each snapshot's verdict.
export async function videosOverview(): Promise<string> {
  const jobs = await q<{ id: number; title: string | null; status: string; slot_at: Date | null; published_at: Date | null; linked: boolean }>(
    `SELECT id, packaging->>'title' AS title, status, slot_at, published_at, youtube_video_id IS NOT NULL AS linked FROM jobs
     WHERE status IN ('approved','published') AND COALESCE(published_at, slot_at, created_at) > now() - interval '30 days'
     ORDER BY COALESCE(published_at, slot_at, created_at)`);
  if (!jobs.length) return 'No approved or published videos in the last 30 days.';
  const snaps = await q<{ job_id: number; win: string; verdict: string | null; ready: boolean }>(
    `SELECT job_id, win, score->>'verdict' AS verdict, engaged_views IS NOT NULL AS ready FROM metrics WHERE job_id = ANY($1)`, [jobs.map((j) => j.id)]);
  const icon: Record<string, string> = { winner: '🏆', average: '🙂', loser: '🔻', early: '⏳' };
  const cell = (id: number, win: string) => {
    const m = snaps.find((x) => x.job_id === id && x.win === win);
    return `${win} ${!m ? '–' : !m.ready && !m.verdict ? '…' : icon[m.verdict ?? ''] ?? '?'}`;
  };
  return [
    '<b>Videos, last 30 days</b>',
    ...jobs.map((j) => `#${j.id} ${esc((j.title ?? '').slice(0, 48))} · ${j.linked ? `${ymd(new Date(j.published_at!))} · ${WINDOWS.map((w) => cell(j.id, w.win)).join(' ')}` : `⚠️ not linked: <code>/link ${j.id} </code>+ link`}`),
    '– not due yet · … waiting for YouTube Analytics (2–3 days behind)',
  ].join('\n');
}
