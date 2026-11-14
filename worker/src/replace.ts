// Swapping a Short that is already uploaded and scheduled (private, publishes at its slot) for a
// fresh render made with the current code, without anyone opening YouTube Studio.
//
// 1. The job is rendered again from its stored script (same voice, same facts) into a new file,
//    and the new file has to pass the usual QA gate.
// 2. The new file goes to WF3 like any approved video, scheduled for the job's own slot.
// 3. When WF3 reports the new video id, the old video is put on the deletion list. The server's
//    autodeploy timer (tools/autodeploy/youtube-delete.py, every 5 minutes) deletes it through
//    the YouTube API with n8n's YouTube login, but only after checking that the old video is
//    still private and scheduled and that the new one is uploaded for the same time. So the slot
//    never ends up empty, and nothing that is already public is ever deleted.
// 4. One Telegram message says what happened, with a contact sheet of the new video.
//
// /replace <job> starts it by hand; the map fix of 14 Nov 2026 (Russia cut at 180°, India's
// Kashmir) starts it once for every scheduled Short rendered before that fix (MAP_VERSION).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, isNation, NATION } from './config.js';
import { getSetting, one, q, setSetting } from './db.js';
import { alert, esc, say, sendPhoto } from './telegram.js';
import { queue } from './lib/queue.js';
import { run } from './lib/proc.js';
import { fmtIn } from './lib/time.js';
import { MAP_VERSION, renderShort } from './render.js';
import { runQa, qaSummary } from './qa.js';
import { getDataset } from './datasets.js';
import { handToN8n, linkVideo } from './publish.js';
import { jobDir, renderAndPreview, type JobRow } from './produce.js';

type State = 'queued' | 'rendering' | 'ready' | 'uploading' | 'deleting' | 'done' | 'failed';
interface Replacement {
  job: number;
  reason: string;
  old_video_id: string;
  title: string;
  slot: string; // ISO
  state: State;
  new_video_id?: string;
  video?: string;
  sheet?: string; // contact sheet of the new render (media dir)
  error?: string;
  updated_at: string;
}
type Book = Record<string, Replacement>;

// Never start a swap this close to the slot: the old video then simply stays.
const MIN_LEAD_MIN = 75;
// WF3 normally reports back within a few minutes.
const UPLOAD_TIMEOUT_MIN = 60;

async function book(): Promise<Book> {
  return (await getSetting<Book>('replacements')) ?? {};
}
async function save(r: Replacement): Promise<void> {
  const b = await book();
  b[r.job] = { ...r, updated_at: new Date().toISOString() };
  await setSetting('replacements', b);
}

export async function activeReplacement(jobId: number): Promise<Replacement | undefined> {
  const r = (await book())[jobId];
  return r && !['done', 'failed'].includes(r.state) ? r : undefined;
}

const minutesTo = (iso: string) => (new Date(iso).getTime() - Date.now()) / 60_000;

// Puts a scheduled Short on the list. Returns what to tell the person.
export async function requestReplacement(jobId: number, reason: string): Promise<string> {
  const job = await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) return `No job #${jobId}.`;
  if (isNation(job.format)) return `#${jobId} is a Per Capita Nation episode; those aren't swapped this way.`;
  if (!job.youtube_video_id || !job.slot_at || job.status !== 'published') return `#${jobId} isn't an uploaded, scheduled video.`;
  const slot = new Date(job.slot_at).toISOString();
  if (minutesTo(slot) < MIN_LEAD_MIN) return `#${jobId} goes live in under ${MIN_LEAD_MIN} minutes (or already did), so it stays as it is.`;
  if (await activeReplacement(jobId)) return `#${jobId} is already being replaced.`;
  await save({ job: jobId, reason, old_video_id: job.youtube_video_id, title: job.packaging?.title ?? '', slot, state: 'queued', updated_at: '' });
  void tick();
  return `♻️ Replacing #${jobId}: a new render with the current code, scheduled for the same time, then the old scheduled video is deleted.`;
}

// A frame every 2 seconds, in one picture: for the Telegram note and for Claude's check.
async function contactSheet(video: string, jobId: number): Promise<string> {
  const out = path.join(path.dirname(video), `job-${jobId}-sheet.jpg`);
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-vf', 'fps=1/2,scale=216:-1,tile=8x3:padding=4:color=black', '-frames:v', '1', '-q:v', '4', out]);
  // A copy next to the analysis export (same unguessable token), so Claude can look at it too.
  if (config.analysisExport && config.analysisExportToken.length >= 24) {
    const dir = path.join(config.mediaDir, 'analysis');
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(out, path.join(dir, `${config.analysisExportToken}-job-${jobId}-sheet.jpg`));
  }
  return out;
}

async function rerender(r: Replacement): Promise<void> {
  const job = (await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [r.job]))!;
  const ds = await getDataset((await one<{ dataset_id: string }>('SELECT dataset_id FROM topics WHERE id = $1', [job.topic_id]))!.dataset_id);
  const dir = jobDir(r.job);
  const out = path.join(config.rendersDir, `job-${r.job}-r${Date.now()}.mp4`);
  const res = await renderShort({
    workDir: dir, outFile: out, format: job.format, facts: job.facts, ds,
    beats: job.script.beats, opening: job.script.opening, voice: job.voice, seed: r.job,
    reuseClips: job.render?.clips,
    onStep: (s) => console.log(`[replace ${r.job}] ${s}`),
  });
  const qa = await runQa({
    video: res.video, voiceTrack: path.join(dir, 'voice.wav'), beats: res.props.beats, fps: 30,
    sourceLine: job.facts.source_line, license: job.facts.license, numbersOk: true, criticVerdict: job.critic?.verdict, heard: res.heard,
    guessOptions: job.format === 'GUESS' ? job.facts.guess?.options : undefined,
  });
  if (!qa.passed) throw new Error(`the new render failed QA:\n${qaSummary(qa)}`);
  const sheet = await contactSheet(res.video, r.job).catch((e) => { console.error('[replace sheet]', e.message); return undefined; });
  if (minutesTo(r.slot) < MIN_LEAD_MIN / 2) throw new Error('the render finished too close to the slot');
  // The job now points at the new file (Instagram cross-posts it later), with its new render info.
  await q(`UPDATE jobs SET video_path = $2, render = $3, qa = $4, updated_at = now() WHERE id = $1`,
    [r.job, res.video, { clips: res.clips, seconds: res.seconds, music: res.music, map: MAP_VERSION }, qa]);
  await save({ ...r, state: 'ready', video: res.video, sheet });
  void tick();
}

// The upload waits until WF7 (the delete step) is installed: installing it restarts n8n, which must
// not happen in the middle of WF3's upload, and without it the old video could not be deleted.
const DELETER = 'WF7 Delete replaced video';
async function deleterReady(): Promise<boolean> {
  return ((await getSetting<{ workflows: string[] }>('n8n_auto'))?.workflows ?? []).includes(DELETER);
}

async function upload(r: Replacement): Promise<void> {
  const fresh = (await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [r.job]))!;
  // Same title, description and tags as the scheduled one (already through the spoiler check).
  await save({ ...r, state: 'uploading' });
  await handToN8n(fresh, fresh.packaging as any, new Date(r.slot));
}

// autodeploy.sh says which n8n/workflows/auto/ workflows it installed.
export async function n8nInstalled(workflows: string[]): Promise<void> {
  const old = (await getSetting<{ workflows: string[] }>('n8n_auto'))?.workflows ?? [];
  await setSetting('n8n_auto', { workflows: [...new Set([...old, ...workflows])], at: new Date().toISOString() });
  void tick();
}

// WF3 reported the new upload. Returns true when this was a replacement (it gets its own message).
export async function replacementUploaded(jobId: number, videoId: string): Promise<boolean> {
  const r = (await book())[jobId];
  // A late answer after the upload timeout still counts: the new video exists, so the old one must go.
  const late = r?.state === 'failed' && r.error === 'WF3 never reported the upload';
  if (!r || !(r.state === 'uploading' || late) || videoId === r.old_video_id || !r.title) return false;
  await linkVideo(jobId, videoId); // the job now tracks the new video (scorecards, Instagram)
  await save({ ...r, state: 'deleting', new_video_id: videoId });
  return true;
}

// For the server's delete step: old videos whose replacement is uploaded.
export async function pendingDeletions() {
  return Object.values(await book())
    .filter((r) => r.state === 'deleting' && r.new_video_id)
    .map((r) => ({ job: r.job, old_video_id: r.old_video_id, new_video_id: r.new_video_id!, title: r.title, slot: r.slot }));
}

// The delete step's answer: deleted (or already gone), or refused/failed with the reason.
export async function deletionResult(jobId: number, body: { ok: boolean; detail?: string }): Promise<void> {
  const r = await activeReplacement(jobId);
  if (!r || r.state !== 'deleting') return;
  const when = fmtIn(new Date(r.slot), config.localTz);
  if (body.ok) {
    await save({ ...r, state: 'done', error: undefined });
    const text = `♻️ <b>#${r.job} replaced</b>: ${esc(r.title)}\n${esc(r.reason)}\nThe new version is scheduled for ${when} (https://youtu.be/${r.new_video_id}); the old scheduled video is deleted. Nothing to do.`;
    if (r.sheet) await sendPhoto(r.sheet, text).catch(() => say(text));
    else await say(text);
    return;
  }
  await save({ ...r, state: 'failed', error: body.detail });
  await alert(`#${r.job}: the new version is scheduled for ${when} (https://youtu.be/${r.new_video_id}), but the old scheduled video https://youtu.be/${r.old_video_id} could not be deleted automatically (${body.detail ?? 'no reason given'}). Delete the old one in YouTube Studio before ${when}, or both go live.`);
}

let busy = false;
// Every few minutes: start queued swaps, give up on stuck ones.
export async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (const r of Object.values(await book())) {
      if (r.state === 'queued') {
        if (minutesTo(r.slot) < MIN_LEAD_MIN) {
          await save({ ...r, state: 'failed', error: 'too close to the slot' });
          await alert(`#${r.job} was not replaced: too close to its slot. The old version goes live as scheduled.`);
          continue;
        }
        await save({ ...r, state: 'rendering' });
        queue.add(`replace #${r.job}`, async () => {
          try {
            await rerender({ ...r, state: 'rendering' });
          } catch (e: any) {
            await save({ ...r, state: 'failed', error: String(e.message ?? e) });
            await alert(`#${r.job} was not replaced (${e.message}). The old version goes live as scheduled.`);
          }
        });
      } else if (r.state === 'rendering' && !queue.status().running.concat(queue.status().waiting).some((n) => n === `replace #${r.job}`)) {
        // The worker restarted mid-render: try again if there's still time.
        await save({ ...r, state: 'queued' });
      } else if (r.state === 'ready') {
        if (minutesTo(r.slot) < MIN_LEAD_MIN / 2) {
          await save({ ...r, state: 'failed', error: 'the delete step was not ready in time' });
          await alert(`#${r.job} was not replaced: the n8n delete step (${DELETER}) never reported as installed. The old version goes live as scheduled.`);
        } else if (await deleterReady()) {
          await upload(r).catch(async (e) => {
            await save({ ...r, state: 'failed', error: String(e.message ?? e) });
            await alert(`#${r.job} was not replaced: sending the new version to WF3 failed (${e.message}). The old version goes live as scheduled.`);
          });
        }
      } else if (r.state === 'deleting' && minutesTo(r.slot) < 20) {
        await save({ ...r, state: 'failed', error: 'WF7 did not delete the old video in time' });
        await alert(`#${r.job}: the old scheduled video https://youtu.be/${r.old_video_id} is still there 20 minutes before the slot (WF7 did not run). Delete it in YouTube Studio, or both versions go live. The new one is https://youtu.be/${r.new_video_id}.`);
      } else if (r.state === 'uploading' && Date.now() - new Date(r.updated_at).getTime() > UPLOAD_TIMEOUT_MIN * 60_000) {
        await save({ ...r, state: 'failed', error: 'WF3 never reported the upload' });
        await alert(`#${r.job}: the new version was sent to WF3 ${UPLOAD_TIMEOUT_MIN} minutes ago but never reported back, so the old scheduled video was kept. Check WF3's executions in n8n; if a second copy was uploaded, delete the newer one.`);
      }
    }
  } finally {
    busy = false;
  }
}

// Once, after the 14 Nov 2026 map fix: every scheduled Short rendered with the old maps is swapped,
// and previews still waiting for approval are rendered again (they arrive as new previews).
export async function mapFixSweep(): Promise<void> {
  const key = `map_fix_sweep_v${MAP_VERSION}`;
  if (await getSetting(key)) return;
  await setSetting(key, { at: new Date().toISOString() });
  const reason = 'Re-rendered with the fixed maps: Russia drawn whole (it was cut at the 180° line) and India with all of Kashmir.';
  const scheduled = await q<{ id: number }>(
    `SELECT id FROM jobs WHERE status = 'published' AND youtube_video_id IS NOT NULL AND slot_at > now() + make_interval(mins => $1)
       AND format <> $3 AND COALESCE((render->>'map')::int, 1) < $2 ORDER BY slot_at`, [MIN_LEAD_MIN, MAP_VERSION, NATION]);
  for (const s of scheduled) console.log('[map fix]', await requestReplacement(s.id, reason));
  const waiting = await q<{ id: number }>(
    `SELECT id FROM jobs WHERE status = 'awaiting_approval' AND format <> $2 AND COALESCE((render->>'map')::int, 1) < $1 ORDER BY id`, [MAP_VERSION, NATION]);
  for (const w of waiting) queue.add(`re-render #${w.id} (map fix)`, async () => { await renderAndPreview(w.id, true); });
  if (waiting.length) await say(`🗺 ${waiting.length} preview${waiting.length > 1 ? 's' : ''} waiting for approval (${waiting.map((w) => `#${w.id}`).join(', ')}) ${waiting.length > 1 ? 'are' : 'is'} being rendered again with the fixed maps; the new preview replaces the old one.`);
}
