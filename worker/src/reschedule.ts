// A pinned Short (data/pinned.ts) jumps the queue: on approval it takes the next normal publishing
// slot, and the Shorts already scheduled move back one slot each, keeping their order, until a free
// slot ends the chain. No extra slots are ever used.
//
// The moves are written to the jobs table at once. A Short that is already uploaded also has its
// scheduled time changed on YouTube: n8n's WF8 (n8n/workflows/auto/wf8.json) asks for the list every
// 5 minutes, checks each video is still a private, scheduled video on our channel, and sets its new
// publishAt (videos.update, part=status). A Short still uploading is fixed the same way once WF3
// reports its video id. If YouTube can't be changed before the old time, Telegram says so.
import { config, NATION } from './config.js';
import { getSetting, one, q, setSetting } from './db.js';
import { alert, esc } from './telegram.js';
import { fmtIn, upcomingSlots } from './lib/time.js';
import { activeReplacement } from './replace.js';

// Never move a Short that goes live this soon: the change might not reach YouTube in time.
export const MIN_LEAD_MIN = 75;
const MOVER = 'WF8 Reschedule moved Shorts';

interface Move { job: number; from: string; to: string; state: 'pending' | 'done' | 'failed'; detail?: string; warned?: boolean; updated_at: string }
type Book = Record<string, Move>;

async function book(): Promise<Book> {
  return (await getSetting<Book>('reschedules')) ?? {};
}
async function save(m: Move): Promise<void> {
  const b = await book();
  b[m.job] = { ...m, updated_at: new Date().toISOString() };
  await setSetting('reschedules', b);
}

export async function moverReady(): Promise<boolean> {
  return ((await getSetting<{ workflows: string[] }>('n8n_auto'))?.workflows ?? []).includes(MOVER);
}

type Holder = { id: number; title: string | null; source: string | null };

// Pure part of jumpQueue: the pinned Short's slot and the chain of moves. Pinned Shorts approved
// earlier keep their place, so this one goes after them (1 then 2). Then whoever holds the slot moves
// to the next one, and so on, until a slot is free.
export function planJump(slots: Date[], at: Map<number, Holder>): Jump | undefined {
  let i = 0;
  while (i < slots.length && at.get(+slots[i])?.source === 'pinned') i++;
  if (i >= slots.length) return undefined;
  const moved: Jump['moved'] = [];
  for (let k = i, holder = at.get(+slots[i]); holder && k + 1 < slots.length; k++) {
    const next = slots[k + 1];
    moved.push({ job: holder.id, title: holder.title ?? `#${holder.id}`, from: slots[k], to: next });
    holder = at.get(+next);
  }
  return { slot: slots[i], moved };
}

export interface Jump { slot: Date; moved: { job: number; title: string; from: Date; to: Date }[] }

// The slot for pinned job `id`, and the Shorts that move back to make room. Returns undefined when
// the queue can't be moved safely (WF8 not installed yet, or a scheduled Short is being swapped);
// the caller then uses the next free slot as usual.
export async function jumpQueue(id: number): Promise<Jump | undefined> {
  if (config.youtubeApiUploads && !(await moverReady())) return undefined;
  const lead = new Date(Date.now() + MIN_LEAD_MIN * 60_000);
  const slots = upcomingSlots(config.publishSlots, config.slotTz, lead, 60);
  const booked = await q<{ id: number; slot_at: Date; title: string | null; source: string | null }>(
    `SELECT j.id, j.slot_at, j.packaging->>'title' AS title, t.source FROM jobs j LEFT JOIN topics t ON t.id = j.topic_id
     WHERE j.slot_at >= $1 AND j.status IN ('approved','published') AND j.format <> $2 AND j.id <> $3 ORDER BY j.slot_at`,
    [lead, NATION, id]);
  const at = new Map(booked.map((b) => [+new Date(b.slot_at), b]));
  for (const b of booked) if (await activeReplacement(b.id)) return undefined;

  const plan = planJump(slots, at);
  if (!plan) return undefined;
  const { slot, moved } = plan;
  // Last first, so no two jobs ever share a slot in the table.
  for (const m of [...moved].reverse()) {
    await q(
      `UPDATE jobs SET slot_at = $2,
         published_at = CASE WHEN published_at IS NOT NULL THEN $2::timestamptz ELSE NULL END,
         ig_due_at = CASE WHEN ig_status IS NULL AND ig_due_at IS NOT NULL THEN ig_due_at + ($2::timestamptz - slot_at) ELSE ig_due_at END,
         updated_at = now() WHERE id = $1`,
      [m.job, m.to]);
    if (config.youtubeApiUploads) {
      const prev = (await book())[m.job];
      // A Short moved twice keeps the time YouTube still has as its "from".
      await save({ job: m.job, from: prev?.state === 'pending' ? prev.from : m.from.toISOString(), to: m.to.toISOString(), state: 'pending', updated_at: '' });
    }
  }
  return { slot, moved };
}

// WF8's list: uploaded Shorts whose YouTube time still has to change.
export async function pendingReschedules() {
  const pending = Object.values(await book()).filter((m) => m.state === 'pending');
  if (!pending.length) return [];
  const jobs = await q<{ id: number; youtube_video_id: string | null; slot_at: Date; title: string | null }>(
    `SELECT id, youtube_video_id, slot_at, packaging->>'title' AS title FROM jobs WHERE id = ANY($1)`, [pending.map((m) => m.job)]);
  return jobs.filter((j) => j.youtube_video_id).map((j) => ({
    job: j.id, video_id: j.youtube_video_id!, publish_at: new Date(j.slot_at).toISOString(), title: j.title ?? '',
  }));
}

export async function rescheduleResult(jobId: number, body: { ok: boolean; detail?: string }): Promise<void> {
  const m = (await book())[jobId];
  if (!m || m.state !== 'pending') return;
  await save({ ...m, state: body.ok ? 'done' : 'failed', detail: body.detail });
  if (!body.ok) {
    await alert(`#${jobId} was moved back to ${fmtIn(new Date(m.to), config.localTz)} your time to make room for a pinned Short, but YouTube could not be changed (${body.detail ?? 'no reason given'}). In YouTube Studio, set its scheduled time to ${fmtIn(new Date(m.to), config.localTz)}, or it goes live at ${fmtIn(new Date(m.from), config.localTz)} next to the pinned one.`);
  }
}

// Every 2 minutes: a move YouTube hasn't taken 20 minutes before the old time gets one warning.
export async function rescheduleWatch(): Promise<void> {
  for (const m of Object.values(await book())) {
    if (m.state !== 'pending' || m.warned) continue;
    const left = (+new Date(m.from) - Date.now()) / 60_000;
    if (left > 20) continue;
    if (left < -60) { await save({ ...m, state: 'failed', detail: 'never confirmed' }); continue; }
    await save({ ...m, warned: true });
    const job = await one<{ youtube_url: string | null }>('SELECT youtube_url FROM jobs WHERE id = $1', [m.job]);
    await alert(`#${m.job} should have moved to ${fmtIn(new Date(m.to), config.localTz)} your time, but WF8 hasn't changed it on YouTube yet. In YouTube Studio, set its scheduled time to ${fmtIn(new Date(m.to), config.localTz)}${job?.youtube_url ? ` (${job.youtube_url})` : ''}, or it goes live at ${fmtIn(new Date(m.from), config.localTz)}.`);
  }
}

export function jumpText(j: Jump): string {
  if (!j.moved.length) return '';
  const lines = j.moved.map((m) => `• #${m.job} ${esc(m.title)}: ${fmtIn(m.from, config.localTz)} → <b>${fmtIn(m.to, config.localTz)}</b>`);
  return `\n\nTo make room, ${j.moved.length === 1 ? 'one scheduled Short moves' : `${j.moved.length} scheduled Shorts move`} back one slot (your time)${config.youtubeApiUploads ? '; YouTube is updated by itself within minutes' : ''}:\n${lines.join('\n')}`;
}
