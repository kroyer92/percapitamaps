// Scores one analytics snapshot: a grade per stage (stay, finish, spread, convert), a verdict,
// where in the video viewers left, and what to change. The bands are the ones in the "per-video
// metric targets" doc; once 10 videos have the same snapshot, the channel's own spread replaces them.
import type { Beat } from './validate.js';
import type { VoiceClip } from './voice.js';
import { place } from './timeline.js';

export type Grade = 'kill' | 'weak' | 'ok' | 'strong';
export type Verdict = 'winner' | 'average' | 'loser' | 'early';
type Band = { kill: number; ok: number; strong: number; lower?: boolean };

export interface IgInsights {
  views?: number;
  reach?: number;
  likes?: number;
  saved?: number;
  shares?: number;
  avg_watch_sec?: number;
  skip_rate?: number;
  age_hours?: number;
  error?: string;
}

export interface Snapshot {
  win: string;
  views: number | null;
  engaged_views: number | null;
  avg_view_pct: number | null;
  likes: number | null;
  shares: number | null;
  subs_gained: number | null;
  curve: [number, number][] | null;
  ig: IgInsights | null;
}

export interface VideoInfo {
  hook_type: string | null;
  beats: Beat[];
  clips: VoiceClip[];
  seconds: number;
}

export interface Drop { from: number; to: number; loss: number; beat: number; line: string; kind: 'hook' | 'reveal' | 'middle' }

export interface Score {
  verdict: Verdict;
  reason: string;
  values: Record<string, number | undefined>;
  grades: Record<string, Grade | undefined>;
  relative?: number; // engaged views ÷ the channel median at the same snapshot
  drop?: Drop;
  fixes: string[];
  peers: number;
}

// Creator-reported ranges for YouTube (1of10, Sep 2026) and estimates for the rest.
// "stay" is engaged views ÷ views: since March 2025 a view counts from the first frame, so this is
// the API's closest match to Studio's "viewed vs swiped away" (a little lower, replays add views).
export const BANDS: Record<string, Band> = {
  stay: { kill: 55, ok: 65, strong: 75 },
  finish: { kill: 70, ok: 80, strong: 90 }, // average percentage viewed, 30–35 s Shorts
  shares: { kill: 2, ok: 3, strong: 10 }, // per 1,000 engaged views
  likes: { kill: 2, ok: 3, strong: 5 }, // % of engaged views
  subs: { kill: 1, ok: 2, strong: 5 }, // per 1,000 engaged views
  ig_skip: { kill: 60, ok: 50, strong: 35, lower: true }, // % who scroll past in the first 3 s
  ig_watch: { kill: 50, ok: 65, strong: 80 }, // average watch time as % of the video
  ig_share: { kill: 0.5, ok: 1, strong: 2 }, // shares as % of reach
};

export const MIN_SAMPLE = 300; // views (YouTube) or reach (Instagram) before percentages mean much
const PEERS_FOR_BANDS = 10;
const PEERS_FOR_MEDIAN = 5;

export function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

function bandFor(key: string, peers: number[]): Band {
  const fixed = BANDS[key];
  if (peers.length < PEERS_FOR_BANDS) return fixed;
  // Our own bottom 20% / median / top 20%.
  return fixed.lower
    ? { kill: quantile(peers, 0.8), ok: quantile(peers, 0.5), strong: quantile(peers, 0.2), lower: true }
    : { kill: quantile(peers, 0.2), ok: quantile(peers, 0.5), strong: quantile(peers, 0.8) };
}

export function grade(v: number | undefined, b: Band): Grade | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  if (b.lower) return v > b.kill ? 'kill' : v > b.ok ? 'weak' : v > b.strong ? 'ok' : 'strong';
  return v < b.kill ? 'kill' : v < b.ok ? 'weak' : v < b.strong ? 'ok' : 'strong';
}

const per = (n: number | null | undefined, d: number | null | undefined, k: number) =>
  n === null || n === undefined || !d ? undefined : (n / d) * k;

export function valuesOf(s: Snapshot, seconds: number): Record<string, number | undefined> {
  const eng = s.engaged_views ?? undefined;
  const ig = s.ig && !s.ig.error ? s.ig : undefined;
  return {
    views: s.views ?? undefined,
    engaged: eng,
    stay: s.views && eng !== undefined ? Math.min(100, (eng / s.views) * 100) : undefined,
    finish: s.avg_view_pct ?? undefined,
    shares: per(s.shares, eng, 1000),
    likes: per(s.likes, eng, 100),
    subs: per(s.subs_gained, eng, 1000),
    ig_reach: ig?.reach,
    ig_skip: ig?.skip_rate,
    ig_watch: ig?.avg_watch_sec !== undefined && seconds ? Math.min(100, (ig.avg_watch_sec / seconds) * 100) : undefined,
    ig_watch_sec: ig?.avg_watch_sec,
    ig_share: per(ig?.shares, ig?.reach, 100),
  };
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
export { mmss };

// The steepest 2-second fall in the retention curve, and the script beat on screen at that moment.
export function biggestDrop(curve: [number, number][] | null, v: VideoInfo): Drop | undefined {
  if (!curve || curve.length < 5 || !v.seconds) return undefined;
  const pts = curve.map(([r, w]) => ({ t: r * v.seconds, w })).sort((a, b) => a.t - b.t);
  let best: { from: number; to: number; loss: number } | undefined;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].t < 1) continue;
    const j = pts.findIndex((p) => p.t >= pts[i].t + 2);
    if (j < 0 || pts[j].t > v.seconds - 1) break;
    const loss = pts[i].w - pts[j].w;
    if (!best || loss > best.loss) best = { from: pts[i].t, to: pts[j].t, loss };
  }
  if (!best || best.loss <= 0.02) return undefined;
  let beat = 0;
  if (v.beats.length && v.clips.length === v.beats.length) {
    const { placed } = place(v.beats, v.clips);
    const mid = (best.from + best.to) / 2;
    placed.forEach((p, i) => { if (p.visualAt <= mid) beat = i; });
  }
  const reveal = v.beats.findIndex((b) => b.visual?.startsWith('reveal'));
  const kind = beat === 0 ? 'hook' : reveal >= 0 && (beat === reveal || beat === reveal - 1) ? 'reveal' : 'middle';
  const words = (v.beats[beat]?.vo ?? '').split(/\s+/);
  return { ...best, beat, line: words.slice(0, 7).join(' ') + (words.length > 7 ? '…' : ''), kind };
}

// The hook types prompts.ts asks for; a failing one hands over to the next.
const NEXT_HOOK: Record<string, string> = { STAKES: 'CONTRADICTION', CONTRADICTION: 'RANK_TEASE', RANK_TEASE: 'YOU', YOU: 'DIRECT_QUESTION', DIRECT_QUESTION: 'STAKES' };

function fixesFor(g: Score['grades'], drop: Drop | undefined, hookType: string | null): string[] {
  const bad = (x?: Grade) => x === 'kill' || x === 'weak';
  const out: string[] = [];
  if (bad(g.stay)) {
    out.push(`Viewers swipe in the first second. Keep frame 0 coloured and moving with the hook text already on screen, and make sure the title says the same thing as the first line.${hookType && NEXT_HOOK[hookType] ? ` This one used a ${hookType} hook; tap ${NEXT_HOOK[hookType]} on the next preview if it is offered.` : ''}`);
  } else if (bad(g.finish)) {
    if (drop?.kind === 'hook') out.push('People leave during the opening line: cut it to 9 words or fewer and show the map change on the first word.');
    else if (drop?.kind === 'reveal') out.push('People leave just before the payoff: reveal the #1 by about 70% of the runtime, and keep amber hidden until then.');
    else if (drop) out.push(`Cut or shorten beat ${drop.beat + 1} ("${drop.line}"). Keep it to 2 contenders and 28–32 s in total.`);
    else out.push('The middle drags. Keep it to 2 contenders, 28–32 s in total, and a visual change every 2–3 s.');
  } else if (bad(g.shares)) {
    out.push('People watch but don\'t send it on. Pick topics with a surprising #1 or a neighbour rivalry, and end on a contrast worth sending.');
  } else if (bad(g.subs)) {
    out.push('People don\'t subscribe. Make the series obvious: series name in the title and the "new map every day" end card.');
  }
  if (bad(g.ig_skip) && !bad(g.stay)) out.push('Instagram skips more than YouTube does because Reels often start muted. The hook has to read without sound, so use a big caption at frame 0.');
  return out;
}

export function score(s: Snapshot, v: VideoInfo, peers: Snapshot[]): Score {
  const values = valuesOf(s, v.seconds);
  const peerValues = peers.map((p) => valuesOf(p, v.seconds));
  const col = (k: string) => peerValues.map((p) => p[k]).filter((x): x is number => x !== undefined && Number.isFinite(x));
  const ytEnough = (s.views ?? 0) >= MIN_SAMPLE;
  const igEnough = (values.ig_reach ?? 0) >= MIN_SAMPLE;
  const grades: Score['grades'] = {};
  for (const k of ['stay', 'finish', 'shares', 'likes', 'subs']) grades[k] = ytEnough ? grade(values[k], bandFor(k, col(k))) : undefined;
  for (const k of ['ig_skip', 'ig_watch', 'ig_share']) grades[k] = igEnough ? grade(values[k], bandFor(k, col(k))) : undefined;

  const engagedPeers = col('engaged');
  const med = engagedPeers.length >= PEERS_FOR_MEDIAN ? quantile(engagedPeers, 0.5) : undefined;
  const relative = med && values.engaged !== undefined ? values.engaged / med : undefined;
  const stages = [grades.stay, grades.finish, grades.shares, grades.subs];
  const strong = stages.filter((x) => x === 'strong').length;
  const anyKill = stages.includes('kill');
  const drop = biggestDrop(s.curve, v);

  let verdict: Verdict;
  let reason: string;
  if (relative !== undefined && relative >= 2) {
    verdict = 'winner'; reason = `${relative.toFixed(1)}× your median engaged views`;
  } else if (ytEnough && strong >= 2 && !anyKill) {
    verdict = 'winner'; reason = `${strong} stages strong, none failing`;
  } else if (ytEnough && grades.stay === 'kill') {
    verdict = 'loser'; reason = 'too many viewers swipe away in the first second';
  } else if (s.win === '7d' && relative !== undefined && relative < 0.5) {
    verdict = 'loser'; reason = `${relative.toFixed(1)}× your median engaged views after 7 days`;
  } else if (s.win === '7d' && !ytEnough) {
    verdict = 'loser'; reason = `under ${MIN_SAMPLE} views in 7 days, so the feed stopped testing it (the first seconds are the usual cause)`;
  } else if (!ytEnough) {
    verdict = 'early'; reason = `under ${MIN_SAMPLE} views so far, too few to judge`;
  } else {
    verdict = 'average'; reason = anyKill ? 'a stage is failing' : stages.includes('weak') ? 'nothing failing, but below target in places' : 'on target, nothing standing out';
  }
  return { verdict, reason, values, grades, relative, drop, fixes: fixesFor(grades, drop, v.hook_type), peers: peers.length };
}
