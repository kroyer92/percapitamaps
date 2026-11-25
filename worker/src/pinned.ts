// Pinned Shorts (data/pinned.ts) at start-up: their datasets are written and checked against the
// World Bank, each new topic is queued at the front with the numbers it will use sent to Telegram,
// and the videos are made right away instead of waiting for the next 07:00 or 15:00 UTC run.
// A topic already in the table is left alone, so a restart never makes a video twice.
import { getSetting, one, q, setSetting } from './db.js';
import { requestReplacement } from './replace.js';
import { PINNED_DATASETS, PINNED_TOPICS } from './data/pinned.js';
import { getDataset, upsertDataset } from './datasets.js';
import { checkDatasets } from './cli/check-datasets.js';
import { angleHash } from './discover.js';
import { loadFacts } from './facts.js';
import { produceOne, renderAndPreview, type JobRow } from './produce.js';
import { wordCount } from './validate.js';
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

  await syncQuestions();
  await fixCutHeadlinesOnce();

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
      `The previews come here for approval as usual. Once approved, each takes the next normal slot and the Shorts already scheduled move back one slot each (YouTube is updated by itself). Nothing else to do.`,
    ].join('\n\n'));
    for (const id of made) queue.add('produce (pinned)', async () => { await produceOne(2, 0, id); });
  }
  if (waiting && attempt < RECHECKS) {
    setTimeout(() => void queuePinned(attempt + 1).catch((e) => console.error('[pinned]', e.message)), RECHECK_MINUTES * 60_000);
  }
}

// A question changed in data/pinned.ts after its topic was queued (job #103: a 10-word question was
// cut to "Which economy does GTA 6's first" on screen). The topic takes the new wording. Only a Map
// Reveal with the classic opening shows the question as its headline, so only such a preview is
// rendered again (Countdown and Guess show the spoken hook instead: #104 was re-sent for nothing).
async function syncQuestions(): Promise<void> {
  for (const t of PINNED_TOPICS) {
    const topic = await one<{ id: number; question: string }>(`SELECT id, question FROM topics WHERE concept_key = $1 AND source = 'pinned'`, [t.key]);
    if (!topic || topic.question === t.question) continue;
    await q('UPDATE topics SET question = $2 WHERE id = $1', [topic.id, t.question]);
    const jobs = await q<JobRow>(`SELECT * FROM jobs WHERE topic_id = $1 AND status = 'awaiting_approval' AND script IS NOT NULL`, [topic.id]);
    for (const job of jobs) if (showsQuestion(job)) await fixHeadline(job, t.question);
  }
}

const showsQuestion = (job: JobRow) => job.format === 'MAP_REVEAL' && !job.script?.opening;

function withQuestion(job: JobRow, question: string): JobRow['script'] {
  return { ...job.script, beats: job.script.beats.map((b, i) => (i === 0 && wordCount(question) <= 9 ? { ...b, on_screen: question } : b)) };
}

// The headline of a preview still waiting for approval: written into the script, then the video is
// rendered again with the same voice and sent as a new preview.
async function fixHeadline(job: JobRow, question: string): Promise<void> {
  const old = job.script.beats[0]?.on_screen ?? '';
  await q('UPDATE jobs SET script = $2, updated_at = now() WHERE id = $1', [job.id, withQuestion(job, question)]);
  queue.add(`re-render #${job.id} (full question)`, async () => { await renderAndPreview(job.id, true); });
  await say(`🔁 #${job.id} is being rendered again${old && old !== question ? `: the screen showed only "${esc(old)}"` : ''}. The new preview shows "${esc(question)}" in full; approve that one. Nothing else to do.`);
}

// Once (25 Nov 2026): the GTA map Short (#103) still had the cut headline after PR #54, whatever
// happened to it since. Its latest video is put right by its state: a waiting preview is rendered
// again; a scheduled upload is swapped for a fixed render in the same slot (replace.ts); a rejected
// or failed one is made again from scratch. One that is already live is left alone.
export async function fixCutHeadlinesOnce(): Promise<void> {
  const key = 'pinned_headline_fix_v1';
  if (await getSetting(key)) return;
  await setSetting(key, { at: new Date().toISOString() });
  for (const t of PINNED_TOPICS.filter((x) => x.format === 'MAP_REVEAL')) {
    const topic = await one<{ id: number; status: string }>(`SELECT id, status FROM topics WHERE concept_key = $1 AND source = 'pinned'`, [t.key]);
    if (!topic) continue;
    const job = await one<JobRow>('SELECT * FROM jobs WHERE topic_id = $1 ORDER BY id DESC LIMIT 1', [topic.id]);
    if (!job || job.script?.opening) continue;
    if (job.status === 'awaiting_approval' && job.script) { await fixHeadline(job, t.question); continue; }
    if (['approved', 'published'].includes(job.status) && job.script) {
      await q('UPDATE jobs SET script = $2, updated_at = now() WHERE id = $1', [job.id, withQuestion(job, t.question)]);
      if (job.youtube_video_id) await say(await requestReplacement(job.id, `The question is now shown in full ("${t.question}"); the old version showed only its first 6 words.`));
      else await say(`#${job.id} is already approved but not uploaded yet, so it goes up with the short headline. Nothing to do.`);
      continue;
    }
    if (['rejected', 'skipped', 'render_failed', 'needs_human', 'dead_letter'].includes(job.status)) {
      await q(`UPDATE topics SET status = 'idea', fail_count = 0 WHERE id = $1`, [topic.id]);
      queue.add('produce (pinned, again)', async () => { await produceOne(2, 0, topic.id); });
      await say(`🔁 #${job.id} (${esc(t.question)}) is ${job.status}, so it is being made again from scratch with the full question on screen. The new preview comes here for approval. Nothing else to do.`);
    }
  }
}
