// Pinned Shorts (data/pinned.ts) at start-up: their datasets are written and checked against the
// World Bank, each new topic is queued at the front with the numbers it will use sent to Telegram,
// and the videos are made right away instead of waiting for the next 07:00 or 15:00 UTC run.
// A topic already in the table is left alone, so a restart never makes a video twice.
import { config } from './config.js';
import { one, q } from './db.js';
import { PINNED_DATASETS, PINNED_TOPICS } from './data/pinned.js';
import { getDataset, upsertDataset } from './datasets.js';
import { checkDatasets } from './cli/check-datasets.js';
import { angleHash } from './discover.js';
import { loadFacts } from './facts.js';
import { produceOne } from './produce.js';
import { queue } from './lib/queue.js';
import { esc, say } from './telegram.js';

// A source that is down at start-up is checked again this much later, a few times.
const RECHECK_MINUTES = 20;
const RECHECKS = 3;

export async function queuePinned(attempt = 0): Promise<void> {
  for (const ds of PINNED_DATASETS) await upsertDataset(ds);
  const ids = PINNED_TOPICS.map((t) => t.dataset);
  const stale = await q<{ id: string }>(`SELECT id FROM datasets WHERE id = ANY($1) AND (NOT enabled OR verified_at IS NULL OR resolved_ref IS NULL)`, [ids]);
  if (stale.length) await checkDatasets(stale.map((r) => r.id));

  const lines: string[] = [];
  const made: number[] = [];
  let waiting = 0;
  for (const [i, t] of PINNED_TOPICS.entries()) {
    const ds = await one<{ enabled: boolean; check_error: string | null }>('SELECT enabled, check_error FROM datasets WHERE id = $1', [t.dataset]);
    const exists = await one<{ id: number }>(`SELECT id FROM topics WHERE concept_key = $1 AND source = 'pinned'`, [t.key]);
    if (exists) continue;
    if (!ds?.enabled) {
      waiting++;
      console.error(`[pinned] ${t.key}: dataset not ready (${ds?.check_error ?? 'unknown'})`);
      break; // keep the order: a later one doesn't jump ahead
    }
    // The numbers the video will use, worked out now from the live data, so they are on record.
    const facts = await loadFacts(await getDataset(t.dataset), t.format);
    const row = await one<{ id: number }>(
      `INSERT INTO topics (dataset_id, question, expected_twist, format, priority, angle_hash, source, concept_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'pinned', $7)
       ON CONFLICT (dataset_id, angle_hash) DO NOTHING RETURNING id`,
      [t.dataset, t.question, t.twist, t.format, 2000 - i, angleHash(t.question), t.key],
    );
    if (!row) continue;
    made.push(row.id);
    const top = facts.ranking.slice(0, 3).map((r) => `${r.name} ${r.display}`).join(', ');
    lines.push(
      `<b>${made.length}. ${esc(t.question)}</b>\n` +
      `World Bank ${facts.year}, ${facts.countries_count} countries. Top 3: ${esc(top)}.` +
      (facts.threshold ? ` ${facts.threshold.count} countries have ${esc(facts.threshold.label)}.` : '') +
      ` Median: ${esc(facts.world_median)}.`,
    );
  }

  if (made.length) {
    await say([
      `📌 <b>${made.length} pinned Short${made.length > 1 ? 's' : ''} at the front of the queue</b>, being made now:`,
      ...lines,
      `The previews come here for approval as usual. Once approved, each goes out at the next free time (the extra times ${config.prioritySlots.join(' and ')} US Eastern are open to them), ahead of everything already scheduled. Nothing else to do.`,
    ].join('\n\n'));
    for (const id of made) queue.add('produce (pinned)', async () => { await produceOne(2, 0, id); });
  }
  if (waiting && attempt < RECHECKS) {
    setTimeout(() => void queuePinned(attempt + 1).catch((e) => console.error('[pinned]', e.message)), RECHECK_MINUTES * 60_000);
  }
}
