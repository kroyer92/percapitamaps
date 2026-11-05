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
import { chooseTheme, planLongform, type Dataset, type LongPlan } from './plan.js';
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

export async function renderLongVideo(props: LongformProps, outFile: string, onProgress?: (p: number) => void): Promise<void> {
  const url = await serveUrl();
  const browserExecutable = process.env.REMOTION_BROWSER || null;
  const composition = await selectComposition({ serveUrl: url, id: 'Longform', inputProps: props as any, browserExecutable });
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

function publishSlot(): Date {
  // Sunday 11:00 US Eastern (17:00 in Copenhagen): the next one at least 3 hours away.
  const from = new Date(Date.now() + 3 * 3600_000);
  return upcomingSlots(['11:00'], config.slotTz, from, 8).find((d) => new Intl.DateTimeFormat('en-US', { timeZone: config.slotTz, weekday: 'short' }).format(d) === 'Sun') ?? from;
}

export function longDir(n: number) { return path.join(config.rendersDir, 'longform', String(n)); }
export function longVideo(n: number) { return path.join(config.rendersDir, `longform-${n}.mp4`); }
export function longThumb(n: number) { return path.join(config.rendersDir, `longform-${n}-thumb.png`); }

export async function makeLongform(opts: { theme?: string; maps?: number } = {}): Promise<number | undefined> {
  const views = await viewsByDataset();
  const recent = (await q<{ theme: string }>(`SELECT theme FROM longforms WHERE status <> 'failed' ORDER BY n DESC LIMIT 4`)).map((r) => r.theme);
  let theme: Theme;
  if (opts.theme) {
    const t = themeByKey(opts.theme);
    if (!t) { await say(`No theme called "${esc(opts.theme)}". Themes: ${THEMES.map((x) => x.key).join(', ')}`); return undefined; }
    theme = t;
  } else theme = chooseTheme(views, recent);
  const row = await one<{ n: number }>(`INSERT INTO longforms (theme) VALUES ($1) RETURNING n`, [theme.key]);
  const n = row!.n;
  const dir = longDir(n);
  const step = (s: string) => { console.log(`[longform ${n}] ${s}`); office.working('editor', `Long-form #${n}: ${s}`); };
  await say(`🎞 Making long-form #${n}: <b>${esc(theme.name)}</b>${opts.theme ? '' : ' (the theme whose maps got your Shorts the most views)'}. About an hour; it arrives here when it's done.`);
  try {
    await fs.mkdir(dir, { recursive: true });
    step('picking the maps');
    const plan = await planLongform({ theme, viewsByDataset: views, lookup, maps: opts.maps, onStep: step });
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

    // A light check: the file plays, has sound, and is as long as planned.
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', longVideo(n)]);
    const probe = JSON.parse(stdout);
    const dur = Number(probe.format?.duration);
    const hasAudio = (probe.streams ?? []).some((s: any) => s.codec_type === 'audio');
    const video = (probe.streams ?? []).find((s: any) => s.codec_type === 'video');
    if (!hasAudio || !(Math.abs(dur - timed.seconds) < 2) || video?.width !== 1920 || video?.height !== 1080) {
      throw new Error(`Check failed: ${dur.toFixed(1)} s (planned ${timed.seconds.toFixed(1)} s), audio ${hasAudio ? 'yes' : 'no'}, ${video?.width}x${video?.height}`);
    }

    // Copies under the media domain, so the files can be downloaded on the PC from a link.
    const key = crypto.randomBytes(8).toString('hex');
    const pub = { video: `${key}-longform-${n}.mp4`, thumb: `${key}-longform-${n}-thumb.png` };
    await fs.mkdir(path.join(config.mediaDir, 'longform'), { recursive: true });
    await fs.copyFile(longVideo(n), path.join(config.mediaDir, 'longform', pub.video));
    await fs.copyFile(longThumb(n), path.join(config.mediaDir, 'longform', pub.thumb));

    const packaging = longPackaging(plan, timed, n, music?.credit);
    const related = await relatedShorts(plan.segments.map((s) => s.dataset_id));
    await q(`UPDATE longforms SET status = 'ready', packaging = $2, chapters = $3, related = $4, seconds = $5, video_path = $6, thumb_path = $7, public_files = $8, updated_at = now() WHERE n = $1`,
      [n, packaging, JSON.stringify(timed.chapters), JSON.stringify(related), timed.seconds, longVideo(n), longThumb(n), pub]);
    office.finished('editor', `Long-form #${n} ready: ${clock(timed.seconds)}`);
    await rm(path.join(dir, 'voice'));

    const link = (f: string) => `https://${config.mediaDomain}/longform/${f}`;
    const keyboard: Keyboard = [[{ text: '✅ Approve', callback_data: `la:${n}` }, { text: '❌ Reject', callback_data: `lr:${n}` }]];
    await sendPhoto(longThumb(n), [
      `<b>Long-form #${n}</b> · ${esc(theme.name)} · ${plan.segments.length} maps · ${clock(timed.seconds)}`,
      `<b>Title:</b> ${esc(packaging.title)}`,
      `<b>Maps:</b> ${esc(plan.segments.map((s) => s.facts.title).join(' · '))}`,
      `<b>Watch it:</b> ${link(pub.video)}`,
      'Every number comes from the data; no language model wrote any line. Tap Approve for the upload steps.',
    ].join('\n'), keyboard);
    if (plan.skipped.length) console.log(`[longform ${n}] skipped: ${plan.skipped.join('; ')}`);
    return n;
  } catch (e: any) {
    office.failed('editor', `Long-form #${n} failed: ${String(e.message ?? e).slice(0, 140)}`);
    await q(`UPDATE longforms SET status = 'failed', error = $2, updated_at = now() WHERE n = $1`, [n, String(e.message ?? e)]);
    await say(`⚠️ Long-form #${n} failed: ${esc(String(e.message ?? e).slice(0, 800))}\nNothing for you to do; I'll look at it. Send /longform to try again.`);
    return n;
  }
}

async function rm(p: string) { await fs.rm(p, { recursive: true, force: true }).catch(() => undefined); }

export async function approveLongform(n: number): Promise<void> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return;
  if (lf.status !== 'ready') { await say(`Long-form #${n} is already ${lf.status}.`); return; }
  await q(`UPDATE longforms SET status = 'approved', updated_at = now() WHERE n = $1`, [n]);
  const p = lf.packaging;
  const link = (f: string) => `https://${config.mediaDomain}/longform/${f}`;
  const slot = publishSlot();
  const related: RelatedShort[] = lf.related ?? [];
  await say([
    `✅ <b>Approved long-form #${n}</b>. Do these steps on your PC (about 15 minutes):`,
    '',
    `<b>1.</b> Download the video: ${link(lf.public_files.video)}`,
    `<b>2.</b> Download the thumbnail: ${link(lf.public_files.thumb)}`,
    '<b>3.</b> YouTube Studio → Create → Upload videos → pick the video.',
    '<b>4.</b> Paste the title and description below, and upload the thumbnail.',
    '<b>5.</b> Audience: No, it\'s not made for kids. Show more → Tags: paste the tags. Altered content: No.',
    '<b>6.</b> Video elements → End screen → Add → pick "1 video, 1 subscribe" → video: "Best for viewer". Save.',
    `<b>7.</b> Visibility → Schedule → <b>${fmtIn(slot, config.localTz)} your time</b> (${fmtIn(slot, config.slotTz)} US Eastern) → Schedule.`,
    `<b>8.</b> When it's scheduled, copy its link and send: <code>/link L${n} </code>followed by the link.`,
    '',
    '<b>Title</b>', `<code>${esc(p.title)}</code>`,
    '', '<b>Description</b>', `<pre>${esc(p.description)}</pre>`,
    '', '<b>Tags</b>', `<code>${esc(p.tags.join(', '))}</code>`,
    '', '<b>Comment to post and pin</b> (after it goes live)', `<code>${esc(p.pinned_comment)}</code>`,
    ...(related.length ? ['', `<b>After it goes live:</b> on each of these Shorts, Studio → Details → Related video → pick this long-form video:`, ...related.map((r) => `• ${esc(r.title ?? `#${r.job_id}`)} ${esc(r.url)}`)] : []),
  ].join('\n'));
}

export async function rejectLongform(n: number): Promise<void> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return;
  await q(`UPDATE longforms SET status = 'rejected', updated_at = now() WHERE n = $1`, [n]);
  if (lf.public_files) for (const f of Object.values(lf.public_files) as string[]) await fs.rm(path.join(config.mediaDir, 'longform', f), { force: true });
  await say(`❌ Rejected long-form #${n}. Send /longform to make another, or /longform money (or health, food, work, people, energy, tech, nature) for a theme of your choice.`);
}

export async function linkLongform(n: number, url: string): Promise<string> {
  const lf = await one<any>('SELECT * FROM longforms WHERE n = $1', [n]);
  if (!lf) return `There is no long-form #${n}.`;
  await q(`UPDATE longforms SET status = 'published', youtube_url = $2, updated_at = now() WHERE n = $1`, [n, url]);
  return `🔗 Linked long-form #${n} to ${esc(url)}. Next week's long-form is made on Saturday evening.`;
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
