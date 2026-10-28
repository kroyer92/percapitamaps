// The Telegram bot: buttons on previews plus a few commands. Long-polls Telegram, so it
// needs no webhook and doesn't clash with n8n.
import { config } from './config.js';
import { one, q, getSetting, setSetting } from './db.js';
import { tg, say, esc } from './telegram.js';
import { queue } from './lib/queue.js';
import { produceOne, swapHook, type JobRow } from './produce.js';
import { approve, linkVideo, parseVideoId } from './publish.js';
import { followup } from './discover.js';
import { fmtIn } from './lib/time.js';
import { setTune } from './tune.js';

const HELP = [
  '<b>Per Capita Maps Studio</b>',
  'Buttons on each preview: ✅ Approve, ❌ Reject, Hook 1–5 (re-render with that opening line).',
  '',
  '/link &lt;job&gt; &lt;url&gt; – connect an uploaded video to its job',
  '/followup &lt;job or video URL&gt; – queue 2 related videos for a winner',
  '/produce [n] – make n videos now (default 1)',
  '/tune [on|off|reset] – see or undo the weekly hook/length auto-tuning',
  '/status – queue, waiting approvals and next slots',
  '/help – this list',
].join('\n');

async function jobFromRef(ref: string): Promise<number | undefined> {
  if (/^\d+$/.test(ref)) return Number(ref);
  const vid = parseVideoId(ref);
  if (!vid) return undefined;
  return (await one<{ id: number }>('SELECT id FROM jobs WHERE youtube_video_id = $1', [vid]))?.id;
}

async function status(): Promise<string> {
  const counts = await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status`);
  const ideas = await one<{ n: number }>(`SELECT count(*)::int AS n FROM topics WHERE status = 'idea'`);
  const slots = await q<{ id: number; slot_at: Date }>(`SELECT id, slot_at FROM jobs WHERE status IN ('approved','published') AND slot_at > now() ORDER BY slot_at LIMIT 5`);
  const qs = queue.status();
  return [
    '<b>Status</b>',
    `Jobs: ${counts.map((c) => `${c.status} ${c.n}`).join(', ') || 'none yet'}`,
    `Topic ideas waiting: ${ideas?.n ?? 0}`,
    `Working on: ${qs.running.join(', ') || 'nothing'}${qs.waiting.length ? ` (then ${qs.waiting.join(', ')})` : ''}`,
    `Upcoming slots: ${slots.map((s) => `#${s.id} ${fmtIn(new Date(s.slot_at), config.localTz)}`).join(', ') || 'none booked'}`,
  ].join('\n');
}

async function queueFollowup(id: number): Promise<void> {
  queue.add(`followup #${id}`, async () => {
    const r = await followup(id);
    await say(`➕ Follow-ups for #${id}: ${r.inserted} queued at top priority.${r.skipped.length ? `\nSkipped: ${esc(r.skipped.join('; '))}` : ''}`);
  });
  await say(`Working on follow-ups for #${id}…`);
}

async function onMessage(text: string): Promise<void> {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  switch (cmd) {
    case '/start':
    case '/help':
      await say(HELP);
      return;
    case '/status':
      await say(await status());
      return;
    case '/produce': {
      const n = Math.min(10, Math.max(1, Number(args[0]) || 1));
      for (let i = 0; i < n; i++) queue.add('produce', async () => { await produceOne(); });
      await say(`🎬 Queued ${n} video${n > 1 ? 's' : ''}. Each takes about 10–20 minutes; previews arrive here.`);
      return;
    }
    case '/link': {
      const id = Number(args[0]);
      const vid = args[1] ? parseVideoId(args[1]) : undefined;
      if (!id || !vid) { await say('Use it like this: <code>/link 12 https://youtube.com/shorts/abc123DEF45</code>'); return; }
      await say(await linkVideo(id, vid, args[1]));
      return;
    }
    case '/followup': {
      const id = args[0] ? await jobFromRef(args[0]) : undefined;
      if (!id) { await say('Use it like this: <code>/followup 12</code> or <code>/followup https://youtube.com/shorts/…</code>'); return; }
      await queueFollowup(id);
      return;
    }
    case '/tune':
      await say(await setTune((args[0] ?? '').toLowerCase()));
      return;
    default:
      if (text.startsWith('/')) await say(HELP);
  }
}

async function onCallback(cb: any): Promise<void> {
  const [kind, idRaw, arg] = String(cb.data ?? '').split(':');
  const id = Number(idRaw);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => undefined);
  const job = await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  if (!job) return;
  const clearButtons = () => tg('editMessageReplyMarkup', { chat_id: config.telegramChatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  if (kind === 'ap') {
    await clearButtons();
    await approve(id);
  } else if (kind === 'rj') {
    if (job.status !== 'awaiting_approval') { await say(`#${id} is already ${job.status}.`); return; }
    await clearButtons();
    await q(`UPDATE jobs SET status = 'rejected', updated_at = now() WHERE id = $1`, [id]);
    await q(`UPDATE topics SET status = 'skipped' WHERE id = $1`, [job.topic_id]);
    await say(`❌ Rejected #${id}.`);
  } else if (kind === 'fu') {
    await clearButtons();
    await queueFollowup(id);
  } else if (kind === 'hk') {
    if (job.status !== 'awaiting_approval') { await say(`#${id} is already ${job.status}.`); return; }
    await clearButtons();
    queue.add(`hook swap #${id}`, () => swapHook(id, Number(arg)));
  }
}

export async function startBot(): Promise<void> {
  if (!config.telegramToken || !config.telegramChatId || config.telegramToken.startsWith('PASTE_')) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; the bot is off.');
    return;
  }
  // A webhook would block long polling; make sure none is set.
  await tg('deleteWebhook', {}).catch(() => undefined);
  await tg('setMyCommands', {
    commands: [
      { command: 'status', description: 'Queue, approvals and next slots' },
      { command: 'produce', description: 'Make videos now: /produce 2' },
      { command: 'link', description: 'Connect an upload: /link 12 <url>' },
      { command: 'followup', description: 'Two related videos for a winner' },
      { command: 'tune', description: 'See or undo auto-tuning: /tune off' },
      { command: 'help', description: 'All commands' },
    ],
  }).catch(() => undefined);
  let offset = (await getSetting<number>('telegram_offset').catch(() => undefined)) ?? 0;
  for (;;) {
    try {
      const updates = await tg<any[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 70_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        await setSetting('telegram_offset', offset).catch(() => undefined);
        const chat = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? '');
        if (chat !== String(config.telegramChatId)) continue; // only you can control the bot
        try {
          if (u.callback_query) await onCallback(u.callback_query);
          else if (u.message?.text) await onMessage(u.message.text);
        } catch (e: any) {
          console.error('[bot]', e);
          await say(`⚠️ ${esc(String(e.message ?? e))}`).catch(() => undefined);
        }
      }
    } catch (e: any) {
      console.error('[bot] polling error', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
