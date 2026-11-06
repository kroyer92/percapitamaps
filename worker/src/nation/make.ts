// Per Capita Nation's daily episode: census at a fixed time, script, voice, render, QA, Telegram
// preview, then the same automatic YouTube upload (n8n WF3) and Instagram Reel (WF4) as every Short.
// The preview approves itself before the slot unless you reject it, so the series runs on its own.
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { config, NATION } from '../config.js';
import { one, q } from '../db.js';
import { esc, say, alert, sendVideo, type Keyboard } from '../telegram.js';
import { fmtIn } from '../lib/time.js';
import { iso3ToIso2 } from '../data/countries.js';
import { synthesize, transcribe, type Word } from '../voice.js';
import { place, timedBeats, FPS } from '../timeline.js';
import { buildVoiceTrack, finalMix, pickMusic } from '../audio.js';
import { mixSfx, type SfxCue } from '../sfx.js';
import { serveUrl } from '../render.js';
import { runQa, qaSummary } from '../qa.js';
import { pickVoice, jobDir, jobVideo, type JobRow } from '../produce.js';
import { handToN8n } from '../publish.js';
import { queue } from '../lib/queue.js';
import * as office from '../activity.js';
import { METRIC } from './data.js';
import { FLAG_COLOURS, VOTES, dayNumber, dayTimes, openVoteDay, takeCensus, voteFor, type Census } from './census.js';
import { censusStamp, nationBeats, nationFacts, nationPackaging } from './script.js';
import { countryShape } from './shape.js';
import type { NationProps } from '../../remotion/nation/types.js';
import type { TimedBeat } from '../../remotion/types.js';

const fmt = (n: number) => n.toLocaleString('en-US');

function nationProps(c: Census, beats: TimedBeat[], durationInFrames: number): NationProps {
  const isos = new Set([...c.top.map((t) => t.iso3), ...c.newest.map((x) => x.iso3), ...c.ladder.map((r) => r.iso3), c.target?.iso3, c.passed?.iso3].filter((x): x is string => !!x));
  const iso2: Record<string, string> = {};
  for (const iso of isos) { const i2 = iso3ToIso2(iso); if (i2) iso2[iso] = i2; }
  const flagIndex = c.state.flag ? VOTES[0].options.indexOf(c.state.flag) : -1;
  return {
    durationInFrames, beats, census: c, iso2,
    shape: c.target ? countryShape(c.target.iso3) : null,
    flag: flagIndex >= 0 ? FLAG_COLOURS[flagIndex] : null,
    stamp: censusStamp(c),
    metricLabel: METRIC[c.metric].label,
    handle: config.channelHandle,
  };
}

// The sounds follow the scenes: a whoosh on every new scene, ticks while the counter runs and as
// the new citizens' cards slide in, a hit when the nation lands on the ladder and on a vote result.
function nationCues(beats: TimedBeat[], c: Census): SfxCue[] {
  const sec = (fr: number) => Math.max(0, fr / FPS);
  const cues: SfxCue[] = [{ sound: 'whoosh', at: 0 }];
  const hook = beats[0];
  const ticks = Math.min(14, Math.max(2, c.n));
  for (let k = 0; k < ticks; k++) cues.push({ sound: 'tick', at: sec(2 + ((hook.end - 8) * k) / ticks) });
  for (const b of beats.slice(1)) {
    const tag = b.visual.split(':')[1];
    cues.push({ sound: 'whoosh', at: sec(b.start - 6) });
    if (tag === 'new') c.newest.forEach((_, i) => cues.push({ sound: 'tick', at: sec(b.start + 6 + i * 7) }));
    if (tag === 'rank') cues.push({ sound: 'hit', at: sec(b.start + 34) });
    if (tag === 'voted') cues.push({ sound: 'hit', at: sec(b.start + 4) });
  }
  return cues.sort((a, b) => a.at - b.at);
}

export async function renderNation(opts: { workDir: string; outFile: string; census: Census; voice: string; seed: number; onStep?: (s: string) => void; onProgress?: (p: number) => void }) {
  const { workDir, census } = opts;
  await fs.mkdir(workDir, { recursive: true });
  const beats = nationBeats(census);
  opts.onStep?.('Recording the voice');
  const clips = await synthesize(beats.map((b, i) => ({ id: `n${String(i).padStart(2, '0')}`, text: b.vo })), opts.voice, path.join(workDir, 'voice'));
  const { placed, seconds } = place(beats, clips);
  const voiceTrack = path.join(workDir, 'voice.wav');
  await buildVoiceTrack(placed, seconds, voiceTrack);
  let heard: Word[] | undefined;
  try {
    opts.onStep?.('Timing the captions from the voice');
    heard = await transcribe(voiceTrack);
  } catch (e: any) {
    opts.onStep?.(`Caption timing fell back to estimates: ${String(e.message).slice(0, 120)}`);
  }
  const timed = timedBeats(placed, seconds, heard);
  const props = nationProps(census, timed, Math.ceil(seconds * FPS));
  await fs.writeFile(path.join(workDir, 'props.json'), JSON.stringify(props));
  opts.onStep?.('Drawing the island');
  const url = await serveUrl();
  const composition = await selectComposition({ serveUrl: url, id: 'Nation', inputProps: props as any, browserExecutable: process.env.REMOTION_BROWSER || null });
  const silent = path.join(workDir, 'silent.mp4');
  await renderMedia({
    composition, serveUrl: url, codec: 'h264', crf: 18, pixelFormat: 'yuv420p', muted: true, outputLocation: silent,
    inputProps: props as any, concurrency: config.renderThreads, browserExecutable: process.env.REMOTION_BROWSER || null,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });
  opts.onStep?.('Mixing voice, music and sound effects');
  const music = await pickMusic(opts.seed);
  const sfx = await mixSfx(nationCues(timed, census), seconds, workDir);
  await fs.mkdir(path.dirname(opts.outFile), { recursive: true });
  await finalMix(silent, voiceTrack, music, seconds, opts.outFile, sfx);
  await fs.rm(silent, { force: true });
  return { video: opts.outFile, seconds, props, music, clips, heard, beats };
}

// Makes the day's episode. `test` renders a preview only (no day is used up, nothing uploads), for
// a look before NATION_START.
export async function makeNation(opts: { day?: number; test?: boolean; force?: boolean } = {}): Promise<number | undefined> {
  const now = new Date();
  const day = opts.test ? Math.max(1, dayNumber(now) ?? 1) : opts.day ?? dayNumber(now);
  if (!day || day < 1) { await say('Per Capita Nation has not started: set NATION_START in app/.env (see the README).'); return undefined; }
  if (!opts.test) {
    const had = await one<{ job_id: number | null; status: string | null }>('SELECT d.job_id, j.status FROM nation_days d LEFT JOIN jobs j ON j.id = d.job_id WHERE d.day = $1', [day]);
    if (had && !opts.force && had.status && !['rejected', 'render_failed'].includes(had.status)) { await say(`Day ${day} is already made (#${had.job_id}, ${had.status}).`); return had.job_id ?? undefined; }
    if (had?.job_id && opts.force) await q(`UPDATE jobs SET status = 'rejected', updated_at = now() WHERE id = $1 AND status IN ('awaiting_approval','render_failed','producing','rendering')`, [had.job_id]);
  }
  office.working('writer', `Taking the Per Capita Nation census for Day ${day}`);
  const census = await takeCensus(day, now);
  const voice = pickVoice();
  const beats = nationBeats(census);
  const facts = nationFacts(census);
  const packaging = nationPackaging(census);
  const job = await one<{ id: number }>(
    `INSERT INTO jobs (topic_id, status, format, voice, facts, script, packaging) VALUES (NULL, 'rendering', $1, $2, $3, $4, $5) RETURNING id`,
    [NATION, voice, facts, { beats, models: ['census (no model)'] }, packaging]);
  const id = job!.id;
  const slot = dayTimes(now).slot;
  if (!opts.test) {
    await q(`INSERT INTO nation_days (day, census_at, census, slot_at, job_id) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (day) DO UPDATE SET census_at = $2, census = $3, slot_at = $4, job_id = $5`, [day, now, census, slot, id]);
  }
  office.finished('writer', `Census: ${fmt(census.n)} citizens, script ready`, id);
  try {
    const dir = jobDir(id);
    const res = await renderNation({
      workDir: dir, outFile: jobVideo(id), census, voice, seed: id,
      onStep: (s) => { console.log(`[nation #${id}] ${s}`); office.working(s.startsWith('Recording') ? 'narrator' : 'editor', s, id); },
      onProgress: (p) => office.progress('editor', p),
    });
    office.working('checker', 'Checking format, loudness, dead air and speech', id);
    const qa = await runQa({ video: res.video, voiceTrack: path.join(dir, 'voice.wav'), beats: res.props.beats, fps: FPS, sourceLine: facts.source_line, license: facts.license, numbersOk: true, heard: res.heard });
    const status = !qa.passed ? 'render_failed' : opts.test ? 'test' : 'awaiting_approval';
    await q(`UPDATE jobs SET video_path = $2, render = $3, qa = $4, status = $5, updated_at = now() WHERE id = $1`,
      [id, res.video, { clips: res.clips, seconds: res.seconds, music: res.music }, qa, status]);
    if (!qa.passed) {
      office.failed('checker', 'Per Capita Nation episode failed QA', id);
      await alert(`Per Capita Nation Day ${day} (#${id}) failed QA:\n${qaSummary(qa)}\nSend /nation make to try again.`);
      return id;
    }
    office.finished('checker', 'All checks passed', id);
    await sendNationPreview(id, census, opts.test ? undefined : slot);
    return id;
  } catch (e: any) {
    office.failJob(id, `Per Capita Nation render failed: ${e.message}`);
    await q(`UPDATE jobs SET status = 'render_failed', error = $2, updated_at = now() WHERE id = $1`, [id, String(e.message ?? e)]);
    await alert(`Per Capita Nation Day ${day} (#${id}) failed: ${e.message}\nSend /nation make to try again.`);
    return id;
  }
}

function approveAt(slot: Date): Date | undefined {
  return config.nation.autoApproveMinutes > 0 ? new Date(+slot - config.nation.autoApproveMinutes * 60_000) : undefined;
}

async function sendNationPreview(id: number, c: Census, slot?: Date): Promise<void> {
  const job = (await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]))!;
  const auto = slot && approveAt(slot);
  const lines = [
    `<b>#${id}</b> · Per Capita Nation · Day ${c.day}${slot ? '' : ' · <b>test, not uploaded</b>'} · ${job.voice} · ${job.render?.seconds.toFixed(1)} s`,
    `<b>Census:</b> ${fmt(c.n)} citizens (+${fmt(c.newSince)}), ${c.homelands} homelands${c.rank ? `, #${c.rank} in ${METRIC[c.metric].label} (${esc(c.display ?? '')})` : ''}`,
    ...(c.newest.length ? [`<b>Names on screen:</b> ${c.newest.map((x) => `#${x.no} ${esc(x.name)}`).join(', ')}. To take one out: <code>/nation remove ${c.newest[0].no}</code> (re-renders).`] : []),
    ...(c.result ? [`<b>Vote result:</b> ${esc(c.result.answer)} (${c.result.votes} of ${c.result.total})`] : []),
    `<b>Title:</b> ${esc(job.packaging.title)}`,
    ...(slot ? [`<b>Goes live:</b> ${fmtIn(slot, config.localTz)} your time${auto ? `. It approves itself at ${fmtIn(auto, config.localTz)} unless you press Reject.` : '. Press Approve.'}`] : []),
    qaSummary(job.qa!),
  ];
  const keyboard: Keyboard | undefined = slot ? [[{ text: '✅ Approve', callback_data: `ap:${id}` }, { text: '❌ Reject', callback_data: `rj:${id}` }]] : undefined;
  const messageId = await sendVideo(job.video_path!, lines.join('\n'), keyboard);
  if (messageId) await q('UPDATE jobs SET telegram_message_id = $2 WHERE id = $1', [id, messageId]);
  office.waiting('publisher', `Per Capita Nation Day ${c.day} is waiting${auto ? ' (approves itself)' : ' for your OK'}`, id);
}

// Called by publish.approve for NATION jobs: the day's own slot, then the normal upload.
export async function approveNation(job: JobRow, auto = false): Promise<void> {
  const d = await one<{ day: number; slot_at: Date }>('SELECT day, slot_at FROM nation_days WHERE job_id = $1', [job.id]);
  if (!d) { await say(`#${job.id} is a test episode; it is not uploaded.`); return; }
  const soonest = new Date(Date.now() + 20 * 60_000);
  const slot = new Date(d.slot_at) > soonest ? new Date(d.slot_at) : soonest;
  const packaging = { ...job.packaging, description: job.packaging.description ?? '' };
  await q(`UPDATE jobs SET status = 'approved', slot_at = $2, updated_at = now() WHERE id = $1`, [job.id, slot]);
  const when = `<b>${fmtIn(slot, config.localTz)} your time</b>`;
  office.finished('publisher', `Approved Per Capita Nation Day ${d.day}`, job.id);
  if (config.youtubeApiUploads) {
    await handToN8n(job, packaging, slot, config.nation.playlist || null);
    await say(`✅ ${auto ? 'Approved by itself' : 'Approved'}: Per Capita Nation Day ${d.day} (#${job.id}). Uploading through the YouTube API for ${when}; Instagram follows ${config.nation.igDelayHours ? `${config.nation.igDelayHours} hours after` : 'as soon as'} it is live.`);
    return;
  }
  await say([
    `✅ <b>Approved Per Capita Nation Day ${d.day} (#${job.id})</b>. API uploads are off, so schedule it by hand for ${when}.`,
    '', '<b>Title</b>', `<code>${esc(packaging.title)}</code>`,
    '', '<b>Description</b>', `<pre>${esc(packaging.description)}</pre>`,
    '', '<b>Comment to post</b>', `<code>${esc(packaging.pinned_comment)}</code>`,
    '', `When it's uploaded, send: <code>/link ${job.id} </code>followed by the video URL`,
  ].join('\n'));
}

// Runs every few minutes: takes the census when it's due, and approves a waiting episode in time.
const queuedDays = new Set<number>();
export async function nationTick(now = new Date()): Promise<void> {
  const day = dayNumber(now);
  if (!day || day < 1) return;
  const { census, slot } = dayTimes(now);
  if (now >= census && now < slot && !queuedDays.has(day)) {
    const had = await one('SELECT 1 FROM nation_days WHERE day = $1', [day]);
    if (!had) {
      queuedDays.add(day);
      queue.add(`Per Capita Nation Day ${day}`, async () => {
        await makeNation({ day }).catch(async (e) => { queuedDays.delete(day); await alert(`Per Capita Nation Day ${day} could not be made: ${e.message}. It tries again in a few minutes.`); });
      });
    }
  }
  if (config.nation.autoApproveMinutes <= 0) return;
  const waiting = await q<JobRow & { slot: Date }>(
    `SELECT j.*, d.slot_at AS slot FROM jobs j JOIN nation_days d ON d.job_id = j.id
     WHERE j.status = 'awaiting_approval' AND d.slot_at > now() - interval '6 hours'`);
  for (const j of waiting) {
    if (now >= approveAt(new Date(j.slot))!) await approveNation(j, true).catch((e) => alert(`Per Capita Nation #${j.id} could not approve itself: ${e.message}`));
  }
}

// ---------- Telegram: /nation ----------

export async function nationCommand(args: string[]): Promise<string> {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === 'remove') {
    const no = Number(String(args[1] ?? '').replace('#', ''));
    if (!no) return 'Use it like this: <code>/nation remove 207</code> (the citizen number).';
    const gone = await one<{ name: string }>('DELETE FROM nation_citizens WHERE no = $1 RETURNING name', [no]);
    if (!gone) return `No citizen #${no}.`;
    const day = dayNumber(new Date());
    const waiting = day ? await one<{ job_id: number }>(`SELECT d.job_id FROM nation_days d JOIN jobs j ON j.id = d.job_id WHERE d.day = $1 AND j.status = 'awaiting_approval'`, [day]) : undefined;
    if (waiting) queue.add(`Per Capita Nation Day ${day} again`, async () => { await makeNation({ day, force: true }); });
    return `Removed citizen #${no} (${esc(gone.name)}).${waiting ? ` Today's episode is being made again without them; the new preview comes here.` : ''}`;
  }
  if (sub === 'make' || sub === 'test') {
    const test = sub === 'test' || !dayNumber(new Date()) || dayNumber(new Date())! < 1;
    queue.add(`Per Capita Nation ${test ? 'test' : 'episode'}`, async () => { await makeNation({ test, force: !test }); });
    return test ? '🏝 Making a test episode from the citizens so far. It comes here as a preview and is not uploaded.' : "🏝 Making today's episode again. The preview comes here in a few minutes.";
  }
  const now = new Date();
  const day = dayNumber(now);
  const total = await one<{ n: number; day: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE joined_at > now() - interval '24 hours')::int AS day FROM nation_citizens`);
  const voteDay = await openVoteDay();
  const tally = await q<{ choice: number; n: number }>('SELECT choice, count(*)::int AS n FROM nation_votes WHERE day = $1 GROUP BY choice ORDER BY n DESC', [voteDay]);
  const v = voteFor(voteDay);
  const { census, slot } = dayTimes(now);
  return [
    '<b>Per Capita Nation</b>',
    `Page: ${config.nation.domain ? `https://${config.nation.domain}` : 'NATION_DOMAIN not set in app/.env'}`,
    day && day >= 1 ? `Today is Day ${day}. Census ${fmtIn(census, config.localTz)}, live ${fmtIn(slot, config.localTz)} your time.` : `Not started: Day 1 is NATION_START (${esc(config.nation.start || 'not set')}).`,
    `Citizens: ${fmt(total?.n ?? 0)} (${fmt(total?.day ?? 0)} in the last 24 hours)`,
    `Vote: ${esc(v.question)} ${tally.length ? tally.map((t) => `${esc(v.options[t.choice] ?? '?')} ${t.n}`).join(', ') : 'no votes yet'}`,
    '',
    '/nation test – a preview from the citizens so far (not uploaded)',
    "/nation make – make today's episode again",
    '/nation remove &lt;number&gt; – delete a citizen (asked to, or a bad name)',
  ].join('\n');
}
