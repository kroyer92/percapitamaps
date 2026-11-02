// Follow-ups to winners: 2 related topics in the same format, queued at top priority. A winning
// scorecard queues them by itself (once per video), so nobody has to tap or type anything; the
// follow-ups' previews still come to Telegram for approval like every other video.
import { getSetting, setSetting } from './db.js';
import { say, esc } from './telegram.js';
import { queue } from './lib/queue.js';
import { followup } from './discover.js';
import { track } from './activity.js';

const KEY = 'followups_queued'; // job ids that already have follow-ups

export async function hasFollowups(id: number): Promise<boolean> {
  return ((await getSetting<number[]>(KEY)) ?? []).includes(id);
}

async function mark(id: number): Promise<void> {
  const done = (await getSetting<number[]>(KEY)) ?? [];
  if (!done.includes(id)) await setSetting(KEY, [...done, id].slice(-500));
}

export async function queueFollowup(id: number, quiet = false): Promise<void> {
  await mark(id);
  queue.add(`followup #${id}`, async () => {
    const r = await track('scout', `Finding 2 follow-ups to winner #${id}`, () => followup(id), (r) => `Queued ${r.inserted} follow-up${r.inserted === 1 ? '' : 's'} to #${id}`);
    await say(r.inserted
      ? `➕ Follow-ups to #${id}: ${r.inserted} queued at top priority. Their previews come here for approval as usual; nothing else to do.${r.skipped.length ? `\n<i>Skipped: ${esc(r.skipped.join('; '))}</i>` : ''}`
      : `➕ No follow-ups to #${id}: no unused dataset fits it.${r.skipped.length ? ` <i>(${esc(r.skipped.join('; '))})</i>` : ''} Nothing to do; the normal queue carries on.`);
  });
  if (!quiet) await say(`Working on follow-ups for #${id}…`);
}

// Called for every winning scorecard. Returns 'queued' the first time, 'already' after that.
export async function autoFollowup(id: number): Promise<'queued' | 'already'> {
  if (await hasFollowups(id)) return 'already';
  await queueFollowup(id, true);
  return 'queued';
}
