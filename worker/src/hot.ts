// The argue-about topic slot (from 28 Nov 2026, the "viral playbook" plan). Our indicator
// questions all stalled near 1,000 views on YouTube and Instagram alike, while map Shorts that
// break out ask about things viewers already feel something about. So every other video is a
// "hot" topic (topics.source = 'hot') and the rest stay as before: the control. Both halves go
// through the same formats and the Map Reveal opening test, so that test stays fair.
//
// Hot topics come from data/hot.ts (queued at start-up) and from the daily idea finder, which
// borrows the topics of the map Shorts winning this week (scan.ts). A hot video also gets a
// statement-with-a-twist title and ends on an open question to the viewer (content.ts).
import { one, q } from './db.js';
import { chatJson } from './llm.js';
import * as P from './prompts.js';
import { enabledDatasets, upsertDataset, type DatasetRow } from './datasets.js';
import { checkDatasets } from './cli/check-datasets.js';
import { angleHash, fitsData, insertTopics, lowEndProblem, recentTitles } from './discover.js';
import { HIGH_END } from './data/catalog.js';
import { HOT_DATASETS, HOT_TOPICS } from './data/hot.js';
import { scanIfDue, type Winner } from './scan.js';

export const HOT = 'hot';

// Whose turn is it? Hot after a control video and the other way round. Pinned news Shorts and
// launch concepts don't count, so they never push the split off half and half.
export async function hotTurn(): Promise<boolean> {
  const last = await one<{ source: string }>(
    `SELECT t.source FROM jobs j JOIN topics t ON t.id = j.topic_id
     WHERE j.status NOT IN ('needs_human','dead_letter','skipped','render_failed','rejected')
       AND t.source NOT IN ('pinned','launch') AND j.created_at > '2026-11-28'
     ORDER BY j.id DESC LIMIT 1`);
  return last?.source !== HOT;
}

// The first hot topics, queued once (at start-up). A topic already in the table is left alone.
export async function queueHotSeeds(): Promise<number> {
  for (const ds of HOT_DATASETS) await upsertDataset(ds);
  const ids = HOT_DATASETS.map((d) => d.id);
  const stale = await q<{ id: string }>(`SELECT id FROM datasets WHERE id = ANY($1) AND (NOT enabled OR verified_at IS NULL OR resolved_ref IS NULL)`, [ids]);
  if (stale.length) await checkDatasets(stale.map((r) => r.id));
  let added = 0;
  for (const [i, t] of HOT_TOPICS.entries()) {
    const exists = await one<{ id: number }>(`SELECT id FROM topics WHERE concept_key = $1 AND source = $2`, [t.key, HOT]);
    if (exists) continue;
    const ds = await one<{ enabled: boolean }>('SELECT enabled FROM datasets WHERE id = $1', [t.dataset]);
    if (!ds?.enabled) { console.error(`[hot] ${t.key}: dataset ${t.dataset} not ready, skipped for now`); continue; }
    const row = await one<{ id: number }>(
      `INSERT INTO topics (dataset_id, question, expected_twist, format, priority, angle_hash, source, concept_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dataset_id, angle_hash) DO NOTHING RETURNING id`,
      [t.dataset, t.question, t.twist, t.format, 500 - i, angleHash(t.question), HOT, t.key],
    );
    if (row) added++;
  }
  if (added) console.log(`[hot] queued ${added} argue-about topics`);
  return added;
}

function winnerLines(winners: Winner[]): string {
  return winners.map((w) => `${w.title} | ${w.views.toLocaleString('en-US')} views | ${w.ratio}x`).join('\n');
}

function hotDatasetTable(rows: DatasetRow[]): string {
  return rows.map((d) => {
    const high = HIGH_END[d.id];
    const line = d.spec.threshold ? `${d.spec.threshold.label} (over ${d.spec.threshold.value})` : '';
    return `${d.id} | ${d.spec.title}${high ? ` (#1 = ${high.means})` : ''} | ${d.spec.unit} | ${d.latest_year ?? '?'} | ${d.countries ?? '?'} | ${line}`;
  }).join('\n');
}

// Daily, inside the idea finder: up to 3 new hot topics, more when the queue runs low.
export async function discoverHot(): Promise<{ inserted: number; skipped: string[] }> {
  const waiting = await one<{ n: number }>(`SELECT count(*)::int AS n FROM topics WHERE source = $1 AND status = 'idea'`, [HOT]);
  if ((waiting?.n ?? 0) >= 10) return { inserted: 0, skipped: [] };
  const scan = await scanIfDue();
  const fresh = (d: DatasetRow) => !d.last_used_at || Date.now() - +new Date(d.last_used_at) > 21 * 86_400_000;
  const hotIds = new Set(HOT_DATASETS.map((d) => d.id));
  // The plain catalog plus our own hot datasets (left out of the plain idea finder).
  const pool = [
    ...(await enabledDatasets()).filter(fresh),
    ...(await q<DatasetRow>(`SELECT * FROM datasets WHERE enabled AND id = ANY($1)`, [[...hotIds]])).filter(fresh),
  ];
  if (!pool.length) return { inserted: 0, skipped: ['no fresh datasets'] };
  const count = (waiting?.n ?? 0) < 4 ? 5 : 3;
  const res = await chatJson<{ angles: { dataset_id: string; question: string; expected_twist?: string; format: string; trend_link?: string | null; scores?: Record<string, number> }[] }>({
    temperature: 0.7,
    system: P.ANGLE_SYSTEM,
    user: P.hotAngleUser(scan?.winners?.length ? winnerLines(scan.winners) : '(no scan yet: use the shapes below)', hotDatasetTable(pool), await recentTitles(), count),
    numPredict: 2000,
  });
  const angles = (res.angles ?? [])
    .filter((a) => a?.question && a.question.split(/\s+/).length <= 9)
    .map((a) => ({ ...a, format: a.format === 'GUESS' ? 'GUESS' : 'MAP_REVEAL' }));
  const low = angles.filter((a) => lowEndProblem(a.question, a.dataset_id));
  const fit = await fitsData(angles.filter((a) => !low.includes(a)), pool);
  const out = await insertTopics(fit.keep, pool, HOT, 50);
  return { inserted: out.inserted, skipped: [...low.map((a) => `${a.question}: asks about the low end`), ...fit.skipped, ...out.skipped] };
}
