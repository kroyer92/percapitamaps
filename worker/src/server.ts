// The render worker's HTTP API (called by the n8n workflows) plus the Telegram bot.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { applySchema, one, q } from './db.js';
import { queue } from './lib/queue.js';
import { produceOne, cleanupOldRenders } from './produce.js';
import { discover } from './discover.js';
import { instagramDue, linkVideo } from './publish.js';
import { dueSnapshots, storeSnapshot, weeklyReport } from './analytics.js';
import { startBot } from './bot.js';
import { alert, say, esc } from './telegram.js';
import { run } from './lib/proc.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', async (_req, res) => {
  const db = await one('SELECT 1 AS ok').then(() => true, () => false);
  res.json({ ok: db, db, queue: queue.status() });
});

// WF2: queue production. Answers at once; previews and errors arrive in Telegram.
app.post('/produce', (req, res) => {
  const batch = Math.min(10, Math.max(1, Number(req.body?.batch ?? req.query.batch ?? 1)));
  for (let i = 0; i < batch; i++) queue.add('produce', async () => { await produceOne(); });
  res.status(202).json({ queued: batch, queue: queue.status() });
});

// WF1: find new topics.
app.post('/discover', (_req, res) => {
  queue.add('discover', async () => {
    try {
      const r = await discover();
      console.log(`[discover] ${r.signals} signals, ${r.inserted} new topics, ${r.skipped.length} skipped`);
    } catch (e: any) {
      await alert(`WF1 Discover failed: ${e.message}`);
    }
  });
  res.status(202).json({ queued: true });
});

// WF4: post due Reels to Instagram.
app.post('/instagram/run', async (_req, res) => {
  res.status(202).json({ started: true });
  try {
    const r = await instagramDue();
    if (r.posted.length) await say(`📸 Posted to Instagram: ${r.posted.map((id) => `#${id}`).join(', ')}`);
    if (r.failed.length) await alert(`Instagram failed: ${r.failed.join('; ')}`);
  } catch (e: any) {
    await alert(`WF4 Instagram failed: ${e.message}`);
  }
});

// WF3 (after the API audit): n8n uploaded the video and reports its id.
app.post('/jobs/:id/youtube', async (req, res) => {
  const id = Number(req.params.id);
  const videoId = String(req.body?.video_id ?? '');
  if (!videoId) return res.status(400).json({ error: 'video_id missing' });
  const msg = await linkVideo(id, videoId);
  await say(`${msg}\nPin the comment once it's live.`);
  res.json({ ok: true });
});

app.get('/jobs/:id', async (req, res) => {
  const job = await one('SELECT id, status, format, packaging, qa, youtube_video_id, slot_at FROM jobs WHERE id = $1', [Number(req.params.id)]);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// WF5: analytics.
app.get('/analytics/due', async (_req, res) => res.json(await dueSnapshots()));
app.post('/analytics/snapshot', async (req, res) => {
  await storeSnapshot(req.body);
  res.json({ ok: true });
});
app.post('/report/weekly', async (_req, res) => res.json({ text: await weeklyReport() }));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: String(err?.message ?? err) });
});

// Nightly housekeeping at about 03:30 UTC: old renders, stale media copies, disk space.
async function housekeeping() {
  try {
    await cleanupOldRenders();
    for (const sub of ['yt', 'ig']) {
      const dir = path.join(config.mediaDir, sub);
      for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
        const st = await fs.stat(path.join(dir, f));
        if (Date.now() - st.mtimeMs > 3 * 86_400_000) await fs.rm(path.join(dir, f), { force: true });
      }
    }
    const { stdout } = await run('df', ['-P', config.rendersDir]);
    const used = Number(stdout.trim().split('\n').pop()!.split(/\s+/)[4].replace('%', ''));
    if (used > 80) await alert(`Disk is ${used}% full on the server.`);
  } catch (e: any) {
    console.error('[housekeeping]', e);
  }
}
let lastHousekeeping = '';
setInterval(() => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 3 && now.getUTCMinutes() >= 30 && lastHousekeeping !== day) {
    lastHousekeeping = day;
    void housekeeping();
  }
}, 60_000);

// Jobs that were mid-production when the worker restarted would otherwise hang forever.
async function recoverInterrupted() {
  const stuck = await q<{ id: number; topic_id: number }>(`UPDATE jobs SET status = 'render_failed', error = 'worker restarted', updated_at = now() WHERE status IN ('producing','rendering') RETURNING id, topic_id`);
  for (const s of stuck) await q(`UPDATE topics SET status = 'idea' WHERE id = $1 AND status = 'producing'`, [s.topic_id]);
  if (stuck.length) await alert(`The worker restarted while making ${stuck.map((s) => `#${s.id}`).join(', ')}. Those topics are back in the queue.`);
}

app.listen(config.port, async () => {
  console.log(`render-worker listening on ${config.port}`);
  await applySchema().catch((e) => console.error('[schema]', e.message));
  await recoverInterrupted().catch((e) => console.error('[recover]', e));
  void startBot();
  await say(`🟢 Render worker started. Send /status any time. ${esc(config.channelName)}`).catch(() => undefined);
});
