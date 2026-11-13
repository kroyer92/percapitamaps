// The weekly long-form video's own scorecard. WF5 measures it like a Short, as job "L<n>", at
// 72 hours, 7 days and 28 days after it goes public (n8n passes the job id through unchanged, so
// nothing changes there). A long video is judged on other things than a Short:
//   · still watching at 0:30: how many viewers the opening keeps (target 60%)
//   · watched: how much of the video an average view covers (target 30%)
//   · watch hours, which count toward the Partner Program
//   · the chapter (round) that loses the most viewers
// The targets are common rules of thumb for long videos (vidIQ's retention benchmarks), not
// YouTube's numbers. No single video changes the recipe: the Sunday report compares the game style
// with the classic one once 3 game-style videos have 7-day numbers (longformReport).
import { config } from '../config.js';
import { getSetting, q, setSetting } from '../db.js';
import { parseVideoId } from '../publish.js';
import { esc, say, type Keyboard } from '../telegram.js';

export type LongStyle = 'game' | 'classic';
export const STYLE_NAME: Record<LongStyle, string> = { game: 'game style', classic: 'classic style' };

const WINDOWS = [{ win: '72h', hours: 72 }, { win: '7d', hours: 168 }, { win: '28d', hours: 672 }];
const LAG_DAYS = 3; // YouTube Analytics runs 2–3 days behind (as for the Shorts, analytics.ts)
const RETRY_HOURS = 96;
export const KEEP_TARGET = 60; // % still watching at 0:30
export const WATCHED_TARGET = 30; // % of the video watched by an average view
const MIN_VIEWS = 30; // fewer views than this say nothing yet
const GAME_VIDEOS_FOR_CALL = 3;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const day = (d: Date | number) => new Intl.DateTimeFormat('en-GB', { timeZone: config.localTz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));
const settleAt = (pub: number, hours: number) => pub + hours * 3600_000 + LAG_DAYS * 86_400_000;
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const pct = (x?: number) => (x === undefined ? '–' : `${Math.round(x)}%`);

// The style the weekly run makes: what Niko last chose with the button in the Sunday report, else
// LONGFORM_STYLE, else the game.
export async function longformStyle(): Promise<LongStyle> {
  const set = await getSetting<string>('longform_style').catch(() => undefined);
  const v = (set ?? process.env.LONGFORM_STYLE ?? 'game').toLowerCase();
  return v === 'classic' ? 'classic' : 'game';
}

export async function setLongformStyle(style: LongStyle): Promise<string> {
  await setSetting('longform_style', style);
  return `✅ The weekly long-form is made in the ${STYLE_NAME[style]} from now on. To make one now: /longform${style === 'classic' ? ' classic' : ''}`;
}

// ---------- WF5: which long-forms need a snapshot (listed before the Shorts in /analytics/due)
export interface DueRow { job_id: string; video_id: string; win: string; start_date: string; end_date: string }

export async function longformDue(): Promise<DueRow[]> {
  const lfs = await q<{ n: number; youtube_url: string; publish_at: Date }>(
    `SELECT n, youtube_url, publish_at FROM longforms WHERE status = 'published' AND youtube_url IS NOT NULL
       AND publish_at IS NOT NULL AND publish_at < now() AND publish_at > now() - interval '45 days'`);
  if (!lfs.length) return [];
  const have = new Map((await q<{ n: number; win: string; ready: boolean; captured_at: Date }>(
    'SELECT n, win, avg_view_pct IS NOT NULL AS ready, captured_at FROM longform_metrics')).map((m) => [`${m.n}:${m.win}`, m]));
  const out: DueRow[] = [];
  for (const lf of lfs) {
    const videoId = parseVideoId(lf.youtube_url);
    if (!videoId) continue;
    const pub = +new Date(lf.publish_at);
    for (const w of WINDOWS) {
      const at = pub + w.hours * 3600_000;
      if (at > Date.now()) break;
      const m = have.get(`${lf.n}:${w.win}`);
      const waiting = m && !m.ready && Date.now() < at + (RETRY_HOURS + 12) * 3600_000;
      const unsettled = m && +new Date(m.captured_at) < settleAt(pub, w.hours);
      const retry = (waiting || unsettled) && Date.now() - +new Date(m.captured_at) > 5 * 3600_000;
      if (!m || retry) {
        out.push({ job_id: `L${lf.n}`, video_id: videoId, win: w.win, start_date: ymd(new Date(pub)), end_date: ymd(new Date(Math.min(at, Date.now()))) });
        break; // one window per video per run; the next run catches up
      }
    }
  }
  return out;
}

// ---------- The score
export interface LongScore {
  views: number;
  keep30?: number; // % still watching at 0:30
  watched?: number; // % of the video an average view covers
  avgSec?: number;
  watchHours?: number;
  comments?: number;
  subs?: number;
  // The chapter that loses viewers fastest. left: % of those watching at its start who left during
  // it; rate: the same per second, so a long chapter and a short one compare fairly.
  drop?: { label: string; from: number; to: number; left: number; rate: number };
  verdict: 'early' | 'on_target' | 'mixed' | 'below';
  provisional?: boolean;
}

// YouTube's retention curve: [share of the video, viewers there per view], about 100 points.
export function watchingAt(curve: [number, number][] | null | undefined, ratio: number): number | undefined {
  if (!curve?.length) return undefined;
  const pts = [...curve].sort((a, b) => a[0] - b[0]);
  if (ratio <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (ratio <= x1) return y0 + ((y1 - y0) * (ratio - x0)) / Math.max(1e-9, x1 - x0);
  }
  return pts[pts.length - 1][1];
}

export function scoreLong(
  s: { views: number | null; avg_view_pct: number | null; avg_view_sec: number | null; comments: number | null; subs_gained: number | null; curve: [number, number][] | null },
  seconds: number, chapters: { at: number; label: string }[],
): LongScore {
  const views = Number(s.views ?? 0);
  const out: LongScore = { views, verdict: 'early' };
  if (s.avg_view_pct !== null) out.watched = Number(s.avg_view_pct);
  if (s.avg_view_sec !== null) { out.avgSec = Number(s.avg_view_sec); out.watchHours = (views * out.avgSec) / 3600; }
  if (s.comments !== null) out.comments = Number(s.comments);
  if (s.subs_gained !== null) out.subs = Number(s.subs_gained);
  if (seconds > 30) {
    const k = watchingAt(s.curve, 30 / seconds);
    if (k !== undefined) out.keep30 = Math.min(100, k * 100);
  }
  // The chapter that loses viewers fastest. The opening is left out (every video loses most there),
  // and so are the last 20 seconds, where viewers leave because the video ends.
  if (s.curve?.length && seconds > 0) {
    const stop = seconds - 20;
    for (let i = 1; i < chapters.length; i++) {
      const from = chapters[i].at;
      const to = Math.min(chapters[i + 1]?.at ?? seconds, stop);
      if (to - from < 5) continue;
      const a = watchingAt(s.curve, from / seconds);
      const b = watchingAt(s.curve, to / seconds);
      if (a === undefined || b === undefined || a <= 0) continue;
      const rate = Math.log(a / Math.max(b, 1e-6)) / (to - from);
      if (!out.drop || rate > out.drop.rate) out.drop = { label: chapters[i].label, from, to, left: Math.max(0, (1 - b / a) * 100), rate };
    }
  }
  if (views < MIN_VIEWS || out.watched === undefined) return out;
  const hits = [out.keep30 === undefined ? undefined : out.keep30 >= KEEP_TARGET, out.watched >= WATCHED_TARGET].filter((x): x is boolean => x !== undefined);
  out.verdict = hits.every(Boolean) ? 'on_target' : hits.some(Boolean) ? 'mixed' : 'below';
  return out;
}

const VERDICT: Record<LongScore['verdict'], string> = { on_target: '🏆 On target', mixed: '🙂 Mixed', below: '🔻 Below target', early: '⏳ Too early' };

export function longScoreText(lf: { n: number; title?: string | null; style: string }, win: string, sc: LongScore, next?: { win: string; at: string }): string {
  const reason = sc.verdict === 'early'
    ? `${sc.views.toLocaleString('en-US')} views so far; under ${MIN_VIEWS} says nothing yet.`
    : `${pct(sc.keep30)} still watching at 0:30 (target ${KEEP_TARGET}%), ${pct(sc.watched)} watched on average (target ${WATCHED_TARGET}%).`;
  const lines = [
    `📊 <b>Long-form #${lf.n} · ${win}</b> · ${esc(lf.title ?? '')} · ${STYLE_NAME[lf.style as LongStyle] ?? esc(lf.style)}`,
    `${VERDICT[sc.verdict]}: ${reason}`,
    `<b>YouTube</b> ${sc.views.toLocaleString('en-US')} views · watched ${pct(sc.watched)}${sc.avgSec !== undefined ? ` (${mmss(sc.avgSec)} on average)` : ''}${sc.watchHours !== undefined ? ` · ${sc.watchHours >= 10 ? Math.round(sc.watchHours) : sc.watchHours.toFixed(1)} watch hours` : ''}${sc.comments !== undefined ? ` · ${sc.comments} comments` : ''}${sc.subs !== undefined ? ` · +${sc.subs} subs` : ''}`,
  ];
  if (sc.drop && sc.drop.left >= 1) lines.push(`<b>Loses viewers fastest</b> ${esc(sc.drop.label)} (${mmss(sc.drop.from)}–${mmss(sc.drop.to)}): ${Math.round(sc.drop.left)}% of those watching at its start left during it.`);
  const later = next ? ` The ${next.win} numbers come around ${next.at}.` : '';
  lines.push(`<b>Your move:</b> ${sc.verdict === 'early'
    ? `✅ Nothing.${later}`
    : `✅ Nothing. One video is not enough to change the long-form; the Sunday report compares the styles once ${GAME_VIDEOS_FOR_CALL} game-style videos have 7-day numbers.${later}`}`);
  // YouTube API Developer Policies III.E.4.h: derived numbers must be marked as not from YouTube.
  lines.push('<i>From YouTube: views, watched %, average view duration, comments, subscribers and the retention curve. Still watching at 0:30, watch hours, the chapter that loses viewers fastest and the verdict are calculated by this tool, not YouTube metrics.</i>');
  return lines.join('\n');
}

// ---------- WF5 delivered a snapshot for "L<n>" (analytics.ts parses the body and hands it over)
export async function storeLongformSnapshot(x: {
  n: number; win: string; body: any; ytPublished?: string;
  views: number | null; avg_view_pct: number | null; avg_view_sec: number | null; likes: number | null; shares: number | null; comments: number | null; subs_gained: number | null;
  curve: [number, number][] | null;
}): Promise<void> {
  const lf = (await q<{ n: number; style: string; title: string | null; publish_at: Date | null; seconds: number | null; chapters: { at: number; label: string }[] | null }>(
    `SELECT n, style, packaging->>'title' AS title, publish_at, seconds, chapters FROM longforms WHERE n = $1`, [x.n]))[0];
  if (!lf?.publish_at) return;
  // YouTube's own publish time beats the slot (a video uploaded or linked by hand can go public at
  // another time). A wrong start shifts every window, so it is fixed and measured again.
  if (x.ytPublished && Math.abs(+new Date(x.ytPublished) - +new Date(lf.publish_at)) > 3600_000) {
    await q('UPDATE longforms SET publish_at = $2 WHERE n = $1', [x.n, x.ytPublished]);
    await q('DELETE FROM longform_metrics WHERE n = $1', [x.n]);
    return;
  }
  const pub = +new Date(lf.publish_at);
  const hours = WINDOWS.find((w) => w.win === x.win)?.hours ?? 0;
  const prev = (await q<{ avg_view_pct: number | null; score: LongScore | null }>('SELECT avg_view_pct, score FROM longform_metrics WHERE n = $1 AND win = $2', [x.n, x.win]))[0];
  const told = !!prev && prev.avg_view_pct !== null && !prev.score?.provisional;
  await q(
    `INSERT INTO longform_metrics (n, win, views, avg_view_pct, avg_view_sec, likes, shares, comments, subs_gained, raw, curve)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (n, win) DO UPDATE SET captured_at = now(), views = EXCLUDED.views, avg_view_pct = EXCLUDED.avg_view_pct,
       avg_view_sec = EXCLUDED.avg_view_sec, likes = EXCLUDED.likes, shares = EXCLUDED.shares, comments = EXCLUDED.comments,
       subs_gained = EXCLUDED.subs_gained, raw = EXCLUDED.raw, curve = EXCLUDED.curve`,
    [x.n, x.win, x.views, x.avg_view_pct, x.avg_view_sec, x.likes, x.shares, x.comments, x.subs_gained, x.body, x.curve ? JSON.stringify(x.curve) : null]);
  const sc = scoreLong(x, Number(lf.seconds ?? 0), lf.chapters ?? []);
  if (Date.now() < settleAt(pub, hours)) sc.provisional = true;
  await q('UPDATE longform_metrics SET score = $3 WHERE n = $1 AND win = $2', [x.n, x.win, sc]);
  // Analytics hasn't caught up yet: the next WF5 run fetches this window again.
  if (x.avg_view_pct === null && Date.now() < pub + (hours + RETRY_HOURS) * 3600_000) return;
  if (sc.provisional || told) return; // early numbers are kept quiet; a later fetch only corrects
  const i = WINDOWS.findIndex((w) => w.win === x.win);
  const nextWin = WINDOWS[i + 1];
  const next = nextWin ? { win: nextWin.win, at: day(Math.max(settleAt(pub, nextWin.hours), Date.now() + 86_400_000)) } : undefined;
  await say(longScoreText({ n: x.n, title: lf.title, style: lf.style }, x.win, sc, next));
}

// ---------- The Sunday report's long-form section and its call: keep the game style, or go back.
export async function longformReport(): Promise<{ lines: string[]; move?: string; keyboard?: Keyboard }> {
  const rows = await q<{ n: number; style: string; theme: string; win: string; score: LongScore | null }>(
    `SELECT DISTINCT ON (l.n) l.n, l.style, l.theme, m.win, m.score FROM longforms l JOIN longform_metrics m ON m.n = l.n
     WHERE l.publish_at > now() - interval '120 days' AND m.score IS NOT NULL AND COALESCE(m.score->>'provisional', '') <> 'true'
     ORDER BY l.n, CASE m.win WHEN '7d' THEN 1 WHEN '72h' THEN 2 ELSE 3 END`);
  const style = await longformStyle();
  if (!rows.length) return { lines: [`No long-form has settled numbers yet. The weekly one is made in the ${STYLE_NAME[style]}.`] };
  const lines = rows.map((r) => {
    const s = r.score!;
    return `#${r.n} ${r.style === 'game' ? '🎮' : '🗺'} ${esc(r.theme)} (${r.win}) · ${s.views.toLocaleString('en-US')} views · ${pct(s.keep30)} at 0:30 · ${pct(s.watched)} watched${s.watchHours !== undefined ? ` · ${s.watchHours >= 10 ? Math.round(s.watchHours) : s.watchHours.toFixed(1)} watch h` : ''}`;
  });
  const seven = rows.filter((r) => r.win === '7d' && r.score!.verdict !== 'early');
  const of = (st: string) => seven.filter((r) => r.style === st).map((r) => r.score!);
  const med = (xs: (number | undefined)[]) => {
    const v = xs.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : undefined;
  };
  const game = of('game');
  const classic = of('classic');
  if (game.length < GAME_VIDEOS_FOR_CALL) {
    lines.push(`Game style vs classic: ${game.length} of ${GAME_VIDEOS_FOR_CALL} game-style videos have 7-day numbers; the call comes after that.`);
    return { lines };
  }
  const g = { keep: med(game.map((s) => s.keep30)), watched: med(game.map((s) => s.watched)) };
  const c = { keep: med(classic.map((s) => s.keep30)), watched: med(classic.map((s) => s.watched)) };
  const vs = `game ${pct(g.keep)} at 0:30 and ${pct(g.watched)} watched (${game.length} videos)${classic.length ? ` against classic ${pct(c.keep)} and ${pct(c.watched)} (${classic.length})` : ''}`;
  // Back to classic only when it did clearly better on both (5 points), never on one number.
  const worse = classic.length && g.watched !== undefined && c.watched !== undefined && g.watched + 5 <= c.watched
    && (g.keep === undefined || c.keep === undefined || g.keep + 5 <= c.keep);
  if (worse && style === 'game') {
    lines.push(`Call: the classic style kept viewers better: ${vs}.`);
    return { lines, move: 'Tap "Use the classic long-form" below: the game style keeps viewers worse than the classic one did.', keyboard: [[{ text: '↩️ Use the classic long-form', callback_data: 'ls:0:classic' }]] };
  }
  lines.push(`Call: ${worse ? 'the classic style is in use' : 'keep the game style'}: ${vs}.`);
  return { lines };
}

// For the analysis export: every long-form of the last 120 days with its snapshots.
export async function longformExport(): Promise<unknown[]> {
  return q(
    `SELECT l.n, l.style, l.theme, l.publish_at, l.seconds, l.chapters, l.packaging->>'title' AS title,
       json_agg(json_build_object('win', m.win, 'views', m.views, 'avg_view_pct', m.avg_view_pct, 'avg_view_sec', m.avg_view_sec,
         'likes', m.likes, 'shares', m.shares, 'comments', m.comments, 'subs_gained', m.subs_gained, 'score', m.score) ORDER BY m.captured_at) AS snapshots
     FROM longforms l JOIN longform_metrics m ON m.n = l.n
     WHERE l.publish_at > now() - interval '120 days'
     GROUP BY l.n ORDER BY l.n`);
}
