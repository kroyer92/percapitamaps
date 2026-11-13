// Makes the weekly long-form video end to end: theme, maps, voice, render, thumbnail, upload pack.
// Runs in the worker's one work lane (lib/queue), so it never overlaps a Short. It takes about an
// hour on the VPS, most of it the render; the weekly run starts Saturday evening (server.ts).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { getDataset } from '../datasets.js';
import { iso3ToIso2 } from '../data/countries.js';
import { synthesize, transcribe, type VoiceClip, type Word } from '../voice.js';
import { captionWords, FPS, type Placed } from '../timeline.js';
import { buildVoiceTrack, finalMix, pickMusic } from '../audio.js';
import { run } from '../lib/proc.js';
import { esc, say, sendPhoto, type Keyboard } from '../telegram.js';
import { fmtIn, upcomingSlots } from '../lib/time.js';
import { pickVoice } from '../produce.js';
import * as office from '../activity.js';
import type { Beat } from '../validate.js';
import type { RankItem } from '../../remotion/types.js';
import type { LongBeat, LongformProps, LongSegment, ThumbProps } from '../../remotion/longform-types.js';
import type { GameProps } from '../../remotion/game-types.js';
import { mixSfx } from '../sfx.js';
import { pickMaps, rankThemes, planLongform, TooFewMapsError, type Dataset, type LongPlan } from './plan.js';
import { GAME_MIN_ROUNDS, gameLines, gameUnusable, planGame, roundsWanted } from './game.js';
import { gamePackaging, gameProps, gameScript, gameThumbProps, timeGame } from './game-time.js';
import { longformStyle, type LongStyle } from './score.js';
import { THEMES, themeByKey, type Theme } from './themes.js';

// Pauses (seconds) that give the long video room to breathe: the Shorts run tighter.
const GAP = 0.25;
const AFTER_TITLE = 0.6;
const AFTER_REVEAL = 0.6;
const BETWEEN_MAPS = 0.9;
const REVEAL_HOLD = 0.4;
const LEAD = 0.3;
const TAIL = 2.5;

export interface Timed { beats: LongBeat[]; placed: Placed[]; seconds: number; chapters: { at: number; label: string }[] }

// Lays every beat on one timeline. `clips` are in the same order as `flat`.
// `heard`: Whisper's word timings of the finished voice track. Without them the caption words are
// spread over each line by their length, which drifts from the voice on numbers and pauses.
export function timeLongform(plan: LongPlan, clips: VoiceClip[], heard: Word[] = []): Timed {
  const flat = flatBeats(plan);
  const placed: Placed[] = [];
  const beats: LongBeat[] = [];
  const chapters: Timed['chapters'] = [{ at: 0, label: 'Intro' }];
  let t = LEAD;
  flat.forEach(({ beat, seg }, i) => {
    const prev = flat[i - 1];
    if (prev && prev.seg !== seg) {
      t += BETWEEN_MAPS - GAP;
      if (seg >= 0) chapters.push({ at: t, label: `${seg + 1}. ${plan.segments[seg].facts.title}` });
      else chapters.push({ at: t, label: 'Every #1' });
    }
    const clip = clips[i];
    const visualAt = i === 0 ? 0 : t;
    const voiceAt = t + (beat.visual === 'reveal_answer' ? REVEAL_HOLD : 0);
    let endAt = voiceAt + clip.seconds;
    if (beat.visual === 'title') endAt += AFTER_TITLE;
    if (beat.visual === 'reveal_answer') endAt += AFTER_REVEAL;
    placed.push({ beat, clip, visualAt, voiceAt, endAt });
    t = endAt + GAP;
  });
  const seconds = t - GAP + TAIL;
  placed.forEach((p, i) => {
    beats.push({
      seg: flat[i].seg,
      start: Math.round(p.visualAt * FPS),
      voStart: Math.round(p.voiceAt * FPS),
      end: Math.round((placed[i + 1]?.visualAt ?? seconds) * FPS),
      vo: p.beat.vo,
      on_screen: p.beat.on_screen,
      visual: p.beat.visual,
      words: captionWords(p.beat.vo, p.voiceAt, p.clip.seconds, heard),
    });
  });
  return { beats, placed, seconds, chapters };
}

export function flatBeats(plan: LongPlan): { beat: Beat; seg: number }[] {
  return [
    ...plan.intro.map((beat) => ({ beat, seg: -1 })),
    ...plan.segments.flatMap((s, i) => s.beats.map((beat) => ({ beat, seg: i }))),
    ...plan.outro.map((beat) => ({ beat, seg: -1 })),
  ];
}

const rankItem = (r: { rank: number; iso3: string; name: string; value: number; display: string }): RankItem => ({ ...r, iso2: iso3ToIso2(r.iso3) });

export function longProps(plan: LongPlan, timed: Timed): LongformProps {
  const segments: LongSegment[] = plan.segments.map((s) => ({
    n: s.n,
    title: s.facts.title,
    yearText: s.facts.year_text ?? String(s.facts.year),
    unit: s.facts.unit,
    map: s.facts.map,
    top: s.facts.ranking.slice(0, 10).map(rankItem),
    extra: s.facts.ranking.filter((r) => s.extraIsos.includes(r.iso3)).map(rankItem),
    threshold: s.ds.threshold,
    sourceLine: s.facts.source_line,
  }));
  return {
    durationInFrames: Math.ceil(timed.seconds * FPS),
    themeName: plan.theme.name,
    count: plan.segments.length,
    beats: timed.beats,
    segments,
    handle: config.channelHandle,
  };
}

export function thumbProps(plan: LongPlan): ThumbProps {
  const first = plan.segments[0];
  return { line1: `${plan.segments.length} MAPS`, line2: `OF ${plan.theme.name.toUpperCase()}`, line3: "WHO'S #1?", map: first.facts.map, answerIso: first.facts.ranking[0]?.iso3 };
}

function clock(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface RelatedShort { job_id: number; url: string; title: string; dataset_id: string }

export function longPackaging(plan: LongPlan, timed: Timed, n: number, musicCredit?: string) {
  const theme = plan.theme;
  // Titles are written for 10 maps; a week with fewer usable maps says how many there are.
  const count = String(plan.segments.length);
  const fix = (t: string) => t.replace(/\b10\b/, count);
  const title = fix(theme.titles[(n - 1) % theme.titles.length]);
  const sources = [...new Map(plan.segments.map((s) => [s.dataset_id, `${s.facts.title}: ${s.facts.source_line.replace(/^Data: /, '')} ${s.facts.source_url}`])).values()];
  const description = [
    `${plan.segments.length} world maps of ${theme.name.toLowerCase()}, each from open data: who is #1, who is last, where the big countries land, and who led ten years earlier.`,
    '',
    ...timed.chapters.map((c) => `${clock(c.at)} ${c.label}`),
    '',
    'Sources (latest year with data; territories under 300,000 people left out):',
    ...sources.map((s) => `• ${s}`),
    musicCredit ? `\nMusic: ${musicCredit}` : '',
    '',
    'Spotted a mistake? Say so in the comments. Corrections get pinned.',
    '',
    '#maps #geography #data',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, title_options: theme.titles.map(fix), description, tags: theme.tags, pinned_comment: fix(theme.question) };
}

let bundlePromise: Promise<string> | undefined;
async function serveUrl(): Promise<string> {
  try {
    await fs.access(path.join(config.bundleDir, 'index.html'));
    return config.bundleDir;
  } catch {
    bundlePromise ??= bundle({ entryPoint: path.resolve('remotion/index.ts') });
    return bundlePromise;
  }
}

// id: 'Longform' (the classic) or 'LongformGame' (the map quiz, remotion/Game.tsx).
export async function renderLongVideo(props: LongformProps | GameProps, outFile: string, onProgress?: (p: number) => void, id = 'Longform'): Promise<void> {
  const url = await serveUrl();
  const browserExecutable = process.env.REMOTION_BROWSER || null;
  const composition = await selectComposition({ serveUrl: url, id, inputProps: props as any, browserExecutable });
  await renderMedia({
    composition, serveUrl: url, codec: 'h264', crf: 20, pixelFormat: 'yuv420p', muted: true, outputLocation: outFile,
    inputProps: props as any, concurrency: config.renderThreads, browserExecutable,
    onProgress: ({ progress }) => onProgress?.(progress),
  });
}

export async function renderThumb(props: ThumbProps, outFile: string): Promise<void> {
  const url = await serveUrl();
  const browserExecutable = process.env.REMOTION_BROWSER || null;
  const composition = await selectComposition({ serveUrl: url, id: 'LongformThumb', inputProps: props as any, browserExecutable });
  await renderStill({ composition, serveUrl: url, output: outFile, inputProps: props as any, imageFormat: 'png', browserExecutable });
}

// Views per dataset across the published Shorts (latest snapshot of each).
async function viewsByDataset(): Promise<Map<string, number>> {
  const rows = await q<{ dataset_id: string; views: number }>(
    `SELECT t.dataset_id, sum(v.views)::bigint AS views FROM (
       SELECT DISTINCT ON (m.job_id) m.job_id, m.views FROM metrics m WHERE m.views IS NOT NULL ORDER BY m.job_id, m.captured_at DESC
     ) v JOIN jobs j ON j.id = v.job_id JOIN topics t ON t.id = j.topic_id GROUP BY t.dataset_id`);
  return new Map(rows.map((r) => [r.dataset_id, Number(r.views)]));
}

async function lookup(id: string): Promise<Dataset | undefined> {
  const row = await one<{ enabled: boolean }>('SELECT enabled FROM datasets WHERE id = $1', [id]);
  if (!row?.enabled) return undefined;
  return getDataset(id);
}

export async function relatedShorts(datasets: string[]): Promise<RelatedShort[]> {
  return q<RelatedShort>(
    `SELECT j.id AS job_id, j.youtube_url AS url, j.packaging->>'title' AS title, t.dataset_id FROM jobs j JOIN topics t ON t.id = j.topic_id
     WHERE j.youtube_url IS NOT NULL AND t.dataset_id = ANY($1) ORDER BY j.id`, [datasets]);
}

function publishSlot(after = new Date()): Date {
  // Sunday 11:00 US Eastern (17:00 in Copenhagen): the next one at least 3 hours away.
  const from = new Date(after.getTime() + 3 * 3600_000);
  return upcomingSlots(['11:00'], config.slotTz, from, 8).find((d) => new Intl.DateTimeFormat('en-US', { timeZone: config.slotTz, weekday: 'short' }).format(d) === 'Sun') ?? from;
}

export function longDir(n: number) { return path.join(config.rendersDir, 'longform', String(n)); }
export function longVideo(n: number) { return path.join(config.rendersDir, `longform-${n}.mp4`); }
export function longThumb(n: number) { return path.join(config.rendersDir, `longform-${n}-thumb.png`); }

// What one style's builder hands back: the finished video and thumbnail are at longVideo(n) and
// longThumb(n); the rest goes into the database and the Telegram preview.
interface Made {
  theme: Theme;
  seconds: number;
  chapters: { at: number; label: string }[];
  packaging: { title: string; title_options: string[]; description: string; tags: string[]; pinned_comment: string };
  datasets: string[];
  head: string; // "10 maps", "map quiz, 9 rounds"
  lines: string[]; // HTML lines for the preview
}

interface LongJob {
  n: number;
  dir: string;
  candidates: Theme[];
  views: Map<string, number>;
  opts: { theme?: string; maps?: number };
  step: (s: string) => void;
  told: Set<string>; // themes already announced (the classic fallback doesn't repeat it)
}

export async function makeLongform(opts: { theme?: string; maps?: number; style?: LongStyle } = {}): Promise<number | undefined> {
  const views = await viewsByDataset();
  // Only long-forms that were actually made count as "used": a rejected or failed one doesn't use
  // up its theme.
  const recent = (await q<{ theme: string }>(`SELECT theme FROM longforms WHERE status IN ('ready', 'approved', 'uploading', 'published') ORDER BY n DESC LIMIT 4`)).map((r) => r.theme);
  let candidates: Theme[];
  if (opts.theme) {
    const t = themeByKey(opts.theme);
    if (!t) { await say(`No theme called "${esc(opts.theme)}". Themes: ${THEMES.map((x) => x.key).join(', ')}`); return undefined; }
    candidates = [t];
  } else candidates = rankThemes(views, recent);
  // The map quiz unless the Sunday report's button (or LONGFORM_STYLE) chose the classic one.
  const style = opts.style ?? await longformStyle();
  const row = await one<{ n: number }>(`INSERT INTO longforms (theme, style) VALUES ($1, $2) RETURNING n`, [candidates[0].key, style]);
  const n = row!.n;
  const dir = longDir(n);
  const step = (s: string) => { console.log(`[longform ${n}] ${s}`); office.working('editor', `Long-form #${n}: ${s}`); };
  await say(`🎞 Making long-form #${n}${style === 'game' ? ' as a map quiz' : ''}. About an hour; it arrives here when it's done.`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const job: LongJob = { n, dir, candidates, views, opts, step, told: new Set() };
    let made: Made | undefined;
    if (style === 'game') {
      try {
        made = await makeGame(job);
      } catch (e: any) {
        // Too few maps for a quiz is too few for the classic one as well: it needs more.
        if (e instanceof TooFewMapsError) throw e;
        // The weekly video must still come, so a quiz that fails becomes a classic long-form.
        console.error(`[longform ${n}] the map quiz failed:`, e);
        await q(`UPDATE longforms SET style = 'classic', updated_at = now() WHERE n = $1`, [n]);
        await say(`⚠️ The map quiz for long-form #${n} failed: ${esc(String(e.message ?? e).slice(0, 400))}\nI'm making the classic long-form instead, so this week's video still comes. Nothing for you to do; I'll look at the quiz.`);
      }
    }
    made ??= await makeClassic(job);

    // A light check: the file plays, has sound, and is as long as planned.
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', longVideo(n)]);
    const probe = JSON.parse(stdout);
    const dur = Number(probe.format?.duration);
    const hasAudio = (probe.streams ?? []).some((s: any) => s.codec_type === 'audio');
    const video = (probe.streams ?? []).find((s: any) => s.codec_type === 'video');
    if (!hasAudio || !(Math.abs(dur - made.seconds) < 2) || video?.width !== 1920 || video?.height !== 1080) {
      throw new Error(`Check failed: ${dur.toFixed(1)} s (planned ${made.seconds.toFixed(1)} s), audio ${hasAudio ? 'yes' : 'no'}, ${video?.width}x${video?.height}`);
    }

    // Copies under the media domain, so the files can be downloaded on the PC from a link.
    const key = crypto.randomBytes(8).toString('hex');
    const pub = { video: `${key}-longform-${n}.mp4`, thumb: `${key}-longform-${n}-thumb.png` };
    await fs.mkdir(path.join(config.mediaDir, 'longform'), { recursive: true });
    await fs.copyFile(longVideo(n), path.join(config.mediaDir, 'longform', pub.video));
    await fs.copyFile(longThumb(n), path.join(config.mediaDir, 'longform', pub.thumb));

    const related = await relatedShorts(made.datasets);
    await q(`UPDATE longforms SET status = 'ready', packaging = $2, chapters = $3, related = $4, seconds = $5, video_path = $6, thumb_path = $7, public_files = $8, updated_at = now() WHERE n = $1`,
      [n, made.packaging, JSON.stringify(made.chapters), JSON.stringify(related), made.seconds, longVideo(n), longThumb(n), pub]);
    office.finished('editor', `Long-form #${n} ready: ${clock(made.seconds)}`);
    await rm(path.join(dir, 'voice'));

    const link = (f: string) => `https://${config.mediaDomain}/longform/${f}`;
    const keyboard: Keyboard = [[{ text: '✅ Approve', callback_data: `la:${n}` }, { text: '❌ Reject', callback_data: `lr:${n}` }]];
    const caption = (extra: string[]) => [
      `<b>Long-form #${n}</b> · ${esc(made.theme.name)} · ${made.head} · ${clock(made.seconds)}`,
      `<b>Title:</b> ${esc(made.packaging.title)}`,
      ...extra,
      `<b>Watch it:</b> ${link(pub.video)}`,
      'Every number comes from the data; no language model wrote any line. Tap Approve for the upload steps.',
    ].join('\n');
    // Telegram cuts a photo caption at 1,024 characters, which could split an HTML tag and fail the send.
    await sendPhoto(longThumb(n), caption(caption(made.lines).length <= 1000 ? made.lines : []), keyboard);
    return n;
  } catch (e: any) {
    office.failed('editor', `Long-form #${n} failed: ${String(e.message ?? e).slice(0, 140)}`);
    await q(`UPDATE longforms SET status = 'failed', error = $2, updated_at = now() WHERE n = $1`, [n, String(e.message ?? e)]);
    await say(`⚠️ Long-form #${n} failed: ${esc(String(e.message ?? e).slice(0, 800))}\nNothing for you to do; I'll look at it. Send /longform to try again.`);
    return n;
  }
}

// A theme with too few good maps is skipped for the next best one, so the weekly video still gets
// made. A theme Niko asked for by name is not swapped.
async function firstTheme<T>(job: LongJob, plan: (t: Theme) => Promise<T>): Promise<{ theme: Theme; plan: T }> {
  const tooFew: string[] = [];
  for (const t of job.candidates) {
    job.step(`picking the maps for ${t.name}`);
    try {
      const made = await plan(t);
      await q(`UPDATE longforms SET theme = $2, updated_at = now() WHERE n = $1`, [job.n, t.key]);
      if (!job.told.has(t.key)) {
        job.told.add(t.key);
        await say(`🎞 Long-form #${job.n} theme: <b>${esc(t.name)}</b>${job.opts.theme ? '' : ' (the theme whose maps got your Shorts the most views)'}${tooFew.length ? `. Skipped ${esc(tooFew.join(', '))}: too few maps with good data` : ''}.`);
      }
      return { theme: t, plan: made };
    } catch (e) {
      if (!(e instanceof TooFewMapsError) || job.candidates.length === 1) throw e;
      tooFew.push(t.name);
      job.step(String((e as Error).message).slice(0, 200));
    }
  }
  throw new TooFewMapsError(`No theme has enough usable maps (tried ${tooFew.join(', ')}).`);
}

// The classic long-form: eight to ten maps, each counted down to its #1 (plan.ts, Longform.tsx).
async function makeClassic(job: LongJob): Promise<Made> {
  const { n, dir, step } = job;
  const { theme, plan } = await firstTheme(job, (t) => planLongform({ theme: t, viewsByDataset: job.views, lookup, maps: job.opts.maps, onStep: step }));
  await q(`UPDATE longforms SET datasets = $2, updated_at = now() WHERE n = $1`, [n, plan.segments.map((s) => s.dataset_id)]);

  // Voice: one call per map, so no single call runs into the voice engine's time limit.
  const voice = pickVoice();
  office.working('narrator', `Recording long-form #${n} (${voice})`);
  const groups: Beat[][] = [plan.intro, ...plan.segments.map((s) => s.beats), plan.outro];
  const clips: VoiceClip[] = [];
  for (const [g, beats] of groups.entries()) {
    step(`recording the voice, part ${g + 1} of ${groups.length}`);
    clips.push(...await synthesize(beats.map((b, i) => ({ id: `g${String(g).padStart(2, '0')}b${String(i).padStart(2, '0')}`, text: b.vo })), voice, path.join(dir, 'voice')));
  }
  office.finished('narrator', `Long-form #${n}: ${clips.length} lines recorded`);
  let timed = timeLongform(plan, clips);
  const voiceTrack = path.join(dir, 'voice.wav');
  await buildVoiceTrack(timed.placed, timed.seconds, voiceTrack);
  // Time the captions from what the voice actually says, as the Shorts do. The placement doesn't
  // depend on it, so only the caption words change.
  try {
    step('timing the captions from the voice');
    timed = timeLongform(plan, clips, await transcribe(voiceTrack, 40 * 60_000));
  } catch (e: any) {
    step(`caption timing fell back to estimates: ${String(e.message).slice(0, 120)}`);
  }
  const props = longProps(plan, timed);
  await fs.writeFile(path.join(dir, 'props.json'), JSON.stringify(props));

  step(`rendering ${clock(timed.seconds)} of video (the longest step)`);
  const silent = path.join(dir, 'silent.mp4');
  await renderLongVideo(props, silent, (p) => office.progress('editor', p));
  step('mixing voice and music');
  const music = await pickMusic(n);
  await finalMix(silent, voiceTrack, music, timed.seconds, longVideo(n));
  await fs.rm(silent, { force: true });
  step('drawing the thumbnail');
  await renderThumb(thumbProps(plan), longThumb(n));
  if (plan.skipped.length) console.log(`[longform ${n}] skipped: ${plan.skipped.join('; ')}`);
  return {
    theme, seconds: timed.seconds, chapters: timed.chapters,
    packaging: longPackaging(plan, timed, n, music?.credit),
    datasets: plan.segments.map((s) => s.dataset_id),
    head: `${plan.segments.length} maps`,
    lines: [`<b>Maps:</b> ${esc(plan.segments.map((s) => s.facts.title).join(' · '))}`],
  };
}

// The map quiz: a cold open, then a round per map where the viewer guesses before a timer runs out,
// then the last reveal and the score (game.ts, game-time.ts, Game.tsx).
async function makeGame(job: LongJob): Promise<Made> {
  const { n, dir, step } = job;
  const want = roundsWanted(job.opts.maps);
  const { theme, plan } = await firstTheme(job, async (t) => {
    const { picked, skipped } = await pickMaps({ theme: t, viewsByDataset: job.views, lookup, want, min: GAME_MIN_ROUNDS, onStep: step, skip: gameUnusable });
    return planGame(t, picked, skipped);
  });
  await q(`UPDATE longforms SET datasets = $2, updated_at = now() WHERE n = $1`, [n, plan.rounds.map((r) => r.dataset_id)]);
  console.log(`[longform ${n}] the quiz:\n${gameScript(plan)}`);

  // Voice: one call per round (and one for the open and the ending), so no single call runs into
  // the voice engine's time limit.
  const voice = pickVoice();
  office.working('narrator', `Recording long-form #${n} (${voice})`);
  const flat = gameLines(plan);
  const parts: number[][] = [];
  flat.forEach((l, i) => {
    const prev = flat[i - 1];
    if (prev && prev.part === l.part && prev.round === l.round) parts[parts.length - 1].push(i);
    else parts.push([i]);
  });
  const clips: VoiceClip[] = [];
  for (const [g, idx] of parts.entries()) {
    step(`recording the voice, part ${g + 1} of ${parts.length}`);
    clips.push(...await synthesize(idx.map((i) => ({ id: `q${String(i).padStart(3, '0')}`, text: flat[i].line.vo })), voice, path.join(dir, 'voice')));
  }
  office.finished('narrator', `Long-form #${n}: ${clips.length} lines recorded`);
  let timed = timeGame(plan, clips);
  const voiceTrack = path.join(dir, 'voice.wav');
  await buildVoiceTrack(timed.placed, timed.seconds, voiceTrack);
  // Cards pop on the word that names them, so the word timings come from the voice itself, as the
  // Shorts' captions do. The lines stay where they are; only the moments inside them move.
  try {
    step('timing the words from the voice');
    timed = timeGame(plan, clips, await transcribe(voiceTrack, 40 * 60_000));
  } catch (e: any) {
    step(`word timing fell back to estimates: ${String(e.message).slice(0, 120)}`);
  }
  const props = gameProps(plan, timed, config.channelHandle);
  await fs.writeFile(path.join(dir, 'props.json'), JSON.stringify(props));

  step(`rendering ${clock(timed.seconds)} of video (the longest step)`);
  const silent = path.join(dir, 'silent.mp4');
  await renderLongVideo(props, silent, (p) => office.progress('editor', p), 'LongformGame');
  step('mixing voice, music and sound effects');
  const music = await pickMusic(n);
  const sfx = await mixSfx(timed.sfx, timed.seconds, dir);
  await finalMix(silent, voiceTrack, music, timed.seconds, longVideo(n), sfx);
  await rm(silent);
  await rm(path.join(dir, 'sfx'));
  if (sfx) await rm(sfx);
  step('drawing the thumbnail');
  await renderThumb(gameThumbProps(plan), longThumb(n));
  if (plan.skipped.length) console.log(`[longform ${n}] skipped: ${plan.skipped.join('; ')}`);
  return {
    theme, seconds: timed.seconds, chapters: timed.chapters,
    packaging: gamePackaging(plan, timed, n, music?.credit),
    datasets: plan.rounds.map((r) => r.dataset_id),
    head: `map quiz, ${plan.rounds.length} rounds`,
    lines: [`<b>Rounds:</b> ${esc(plan.rounds.map((r) => r.view.title).join(' · '))}`],
  };
}

async function rm(p: string) { await fs.rm(p, { recursive: true, force: true }).catch(() => undefined); }

export async function approveLongform(n: number, opts: { manual?: boolean } = {}): Promise<void> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return;
  if (lf.status !== 'ready') { await say(`Long-form #${n} is already ${lf.status}.`); return; }
  const slot = publishSlot();
  await q(`UPDATE longforms SET status = 'approved', publish_at = $2, updated_at = now() WHERE n = $1`, [n, slot]);
  const p = lf.packaging;
  const link = (f: string) => `https://${config.mediaDomain}/longform/${f}`;
  const when = `<b>${fmtIn(slot, config.localTz)} your time</b> (${fmtIn(slot, config.slotTz)} US Eastern)`;
  if (config.youtubeApiUploads && !opts.manual) {
    try {
      await sendToYoutube(lf, slot);
      await say(`✅ Approved long-form #${n}. Uploading through the YouTube API with its title, description, tags, thumbnail and comment, scheduled for ${when}. Nothing for you to do; a message comes when it's on YouTube.`);
      return;
    } catch (e: any) {
      await say(`⚠️ The automatic upload of long-form #${n} didn't start: ${esc(String(e.message ?? e))}\nThe steps to do it by hand follow, so the slot is still kept.`);
    }
  }
  await say([
    `✅ <b>Approved long-form #${n}</b>. Do these steps on your PC (about 15 minutes):`,
    '',
    `<b>1.</b> Download the video: ${link(lf.public_files.video)}`,
    `<b>2.</b> Download the thumbnail: ${link(lf.public_files.thumb)}`,
    '<b>3.</b> YouTube Studio → Create → Upload videos → pick the video.',
    '<b>4.</b> Paste the title and description below, and upload the thumbnail.',
    '<b>5.</b> Audience: No, it\'s not made for kids. Show more → Tags: paste the tags. Altered content: No.',
    `<b>6.</b> Visibility → Schedule → ${when} → Schedule.`,
    `<b>7.</b> When it's scheduled, copy its link and send: <code>/link L${n} </code>followed by the link.`,
    '',
    '<b>Title</b>', `<code>${esc(p.title)}</code>`,
    '', '<b>Description</b>', `<pre>${esc(p.description)}</pre>`,
    '', '<b>Tags</b>', `<code>${esc(p.tags.join(', '))}</code>`,
    '', '<b>Comment to post</b> (after it goes live)', `<code>${esc(p.pinned_comment)}</code>`,
  ].join('\n'));
}

// Called when WF3 could not set the thumbnail: everything else is uploaded.
export async function longformThumbFailed(n: number, videoId: string): Promise<void> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return;
  await say([
    `⚠️ Long-form #${n} is uploaded and scheduled, but YouTube refused its thumbnail (custom thumbnails need a phone-verified channel: youtube.com/verify).`,
    `To add it by hand: download https://${config.mediaDomain}/longform/${lf.public_files?.thumb}, then Studio → Content → the video${videoId ? ` (https://youtu.be/${videoId})` : ''} → Details → Thumbnail → Upload file → Save.`,
  ].join('\n'));
}

// The same n8n workflow as the Shorts (WF3): upload, schedule, playlist, comment, thumbnail.
// It reports back on /jobs/L<n>/youtube, which links the video here.
async function sendToYoutube(lf: any, slot: Date): Promise<void> {
  const n = lf.n;
  const p = lf.packaging;
  const link = (f: string) => `https://${config.mediaDomain}/longform/${f}`;
  const res = await fetch(config.n8nApprovedWebhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      job_id: `L${n}`, file_url: link(lf.public_files.video), thumb_url: link(lf.public_files.thumb),
      title: p.title, description: p.description, tags: p.tags, publish_at: slot.toISOString(),
      playlist_id: config.playlistLongform || null, pinned_comment: p.pinned_comment, category_id: '27',
    }),
  });
  if (!res.ok) throw new Error(`n8n WF3 webhook answered ${res.status}. Is WF3 active?`);
  await q(`UPDATE longforms SET status = 'uploading', upload_tries = upload_tries + 1, publish_at = $2, updated_at = now() WHERE n = $1`, [n, slot]);
  office.working('publisher', `Uploading long-form #${n}`);
}

// An upload that hasn't reported back after 90 minutes failed in n8n (a dropped connection to
// YouTube, say). Nothing was created on YouTube then, so it is sent again, up to 3 times in all.
// Only after that does Niko get the steps to do it by hand.
export async function retryStuckUploads(): Promise<void> {
  if (!config.youtubeApiUploads) return;
  const stuck = await q<any>(`SELECT * FROM longforms WHERE status = 'uploading' AND updated_at < now() - interval '90 minutes'`);
  for (const lf of stuck) {
    if (lf.upload_tries < 3) {
      const slot = publishSlot();
      try {
        await sendToYoutube(lf, slot);
        await say(`🔁 The upload of long-form #${lf.n} didn't finish, so I started it again (try ${lf.upload_tries + 1} of 3), still scheduled for <b>${fmtIn(slot, config.localTz)} your time</b>. Nothing for you to do.`);
      } catch (e: any) {
        console.error(`[longform ${lf.n}] re-upload`, e.message);
        await q(`UPDATE longforms SET upload_tries = upload_tries + 1, updated_at = now() WHERE n = $1`, [lf.n]);
      }
      continue;
    }
    await q(`UPDATE longforms SET status = 'ready', upload_tries = 0, updated_at = now() WHERE n = $1`, [lf.n]);
    await say(`⚠️ Long-form #${lf.n} failed to upload 3 times, so here are the steps to upload it by hand.`);
    await approveLongform(lf.n, { manual: true });
  }
}

export async function rejectLongform(n: number): Promise<void> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return;
  await q(`UPDATE longforms SET status = 'rejected', updated_at = now() WHERE n = $1`, [n]);
  if (lf.public_files) for (const f of Object.values(lf.public_files) as string[]) await fs.rm(path.join(config.mediaDir, 'longform', f), { force: true });
  await say(`❌ Rejected long-form #${n}. Send /longform to make another, or /longform money (or health, food, work, people, energy, tech, nature) for a theme of your choice.`);
}

export async function linkLongform(n: number, url: string, uploaded = false): Promise<string> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return `There is no long-form #${n}.`;
  const goesPublic: Date = lf.publish_at ? new Date(lf.publish_at) : publishSlot(new Date(lf.updated_at));
  await q(`UPDATE longforms SET status = 'published', youtube_url = $2, publish_at = $3, updated_at = now() WHERE n = $1`, [n, url, goesPublic]);
  office.finished('publisher', `Long-form #${n} is on YouTube`);
  const related: RelatedShort[] = lf.related ?? [];
  // A scheduled video can't be picked as a Short's Related video until it is public, so that list
  // comes when it goes public (sendRelatedWhenPublic).
  const later = related.length && goesPublic > new Date();
  const lines = [
    uploaded ? `📺 Long-form #${n} is uploaded and scheduled: ${esc(url)}` : `🔗 Linked long-form #${n} to ${esc(url)}.`,
    `It goes public ${fmtIn(goesPublic, config.localTz)} your time${later ? '. Then I send you the Shorts to point at it as Related video' : ''}.`,
    'Next week\'s long-form is made on Saturday evening.',
  ];
  if (related.length && !later) {
    lines.push('', ...relatedLines(related));
    await q(`UPDATE longforms SET related_sent = true WHERE n = $1`, [n]);
  }
  return lines.join('\n');
}

// YouTube's API has no setting for a Short's "Related video" or for end screens, so these stay
// optional hand steps that help the long-form get views.
function relatedLines(related: RelatedShort[]): string[] {
  return [`<b>Optional, 2 min, helps it get views:</b> on each of these Shorts, Studio → Details → Related video → pick this long-form:`,
    ...related.map((r) => `• ${esc(r.title ?? `#${r.job_id}`)} ${esc(r.url)}`)];
}

// Runs every 10 minutes: once a long-form is public, the Related video list is sent.
export async function sendRelatedWhenPublic(): Promise<void> {
  const rows = await q<any>(`SELECT * FROM longforms WHERE status = 'published' AND NOT related_sent
    AND COALESCE(publish_at, updated_at) > now() - interval '7 days'`);
  for (const lf of rows) {
    // A long-form linked before publish_at was stored goes public in the Sunday slot after its link.
    const goesPublic = lf.publish_at ? new Date(lf.publish_at) : publishSlot(new Date(lf.updated_at));
    if (goesPublic > new Date()) continue;
    await q(`UPDATE longforms SET related_sent = true WHERE n = $1`, [lf.n]);
    const related: RelatedShort[] = lf.related ?? [];
    if (!related.length) continue;
    await say([`🔗 Long-form #${lf.n} is public now: ${esc(lf.youtube_url ?? '')}`, '', ...relatedLines(related)].join('\n'));
  }
}

// The weekly run: Saturday from 21:00 in LOCAL_TZ, once a week, unless LONGFORM_AUTO=off.
export async function weeklyDue(now = new Date()): Promise<boolean> {
  if ((process.env.LONGFORM_AUTO ?? 'on').toLowerCase() === 'off') return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: config.localTz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday !== 'Sat' || Number(parts.hour) < 21) return false;
  // A failed run is not retried the same evening (it would fail again every hour); /longform does.
  const last = await one<{ n: number }>(`SELECT n FROM longforms WHERE created_at > now() - interval '5 days'
    AND (status <> 'failed' OR created_at > now() - interval '20 hours') LIMIT 1`);
  return !last;
}
