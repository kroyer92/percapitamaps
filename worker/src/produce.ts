// WF2's work: claim the best topic, build facts, write, render, check, and send the preview.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, FORMAT_NAMES, type Format } from './config.js';
import { one, q } from './db.js';
import { getDataset } from './datasets.js';
import { loadFacts, type Facts } from './facts.js';
import { generateContent, NeedsHuman, type Content, type Hook } from './content.js';
import { unloadModels } from './llm.js';
import { renderShort } from './render.js';
import { runQa, qaSummary, type QaReport } from './qa.js';
import { esc, sendVideo, say, alert, type Keyboard } from './telegram.js';
import { fitFormat, pickFormat, blockedFormat } from './formats.js';
import { localDate } from './lib/time.js';
import type { VoiceClip } from './voice.js';
import type { MusicPick } from './audio.js';

export interface JobRow {
  id: number;
  topic_id: number;
  status: string;
  format: Format;
  voice: string;
  length_band: string | null;
  hook_type: string | null;
  facts: Facts;
  script: Content['script'];
  hooks: { list: Hook[]; original: string };
  packaging: Content['packaging'];
  critic: Content['critic'];
  chosen_hook: number;
  video_path: string | null;
  render: { clips: VoiceClip[]; seconds: number; music?: MusicPick } | null;
  qa: QaReport | null;
  slot_at: Date | null;
  series_no: number | null;
  youtube_video_id: string | null;
  youtube_url: string | null;
  published_at: Date | null;
  created_at: Date;
}

export function pickVoice(): string {
  if (config.voice) return config.voice;
  if (config.voiceRotation === 'alternate_days') {
    const d = localDate(new Date(), config.slotTz);
    const dayNumber = Math.floor(Date.UTC(d.y, d.m - 1, d.d) / 86_400_000);
    return dayNumber % 2 === 0 ? config.voiceA : config.voiceB;
  }
  return config.voiceA;
}

async function nthJob(): Promise<number> {
  const r = await one<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE status NOT IN ('needs_human','dead_letter')");
  return r?.n ?? 0;
}

export function jobDir(id: number) {
  return path.join(config.rendersDir, 'jobs', String(id));
}

export function jobVideo(id: number) {
  return path.join(config.rendersDir, `job-${id}.mp4`);
}

async function claimTopic(preferred: Format) {
  const blocked = (await blockedFormat()) ?? '';
  return one<any>(
    `UPDATE topics SET status = 'producing'
     WHERE id = (
       SELECT t.id FROM topics t JOIN datasets d ON d.id = t.dataset_id
       WHERE t.status = 'idea' AND d.enabled
         AND (t.source IN ('launch','followup') OR d.last_used_at IS NULL OR d.last_used_at < now() - interval '21 days')
       ORDER BY (t.source = 'launch') DESC, CASE WHEN t.source = 'launch' THEN t.priority END DESC NULLS LAST,
         (t.format = $1) DESC, (t.format = $2) ASC, t.priority DESC, t.id
       LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [preferred, blocked],
  );
}

export async function produceOne(skips = 0): Promise<number | undefined> {
  const preferred = await pickFormat();
  const topic = await claimTopic(preferred);
  if (!topic) {
    await alert('WF2 found no topics to produce. Run WF1 (Discover) or queue the launch concepts.');
    return undefined;
  }
  const ds = await getDataset(topic.dataset_id);
  const blocked = await blockedFormat();
  let format: Format = config.formats.includes(topic.format) && topic.format !== blocked ? topic.format : preferred;
  format = fitFormat(format, ds);

  const n = await nthJob();
  const lengthBand = config.lengthTest.length ? config.lengthTest[n % config.lengthTest.length] : null;
  const hookType = config.hookTest.length ? config.hookTest[n % config.hookTest.length] : null;
  const voice = pickVoice();
  const job = await one<{ id: number }>(
    `INSERT INTO jobs (topic_id, status, format, voice, length_band, hook_type) VALUES ($1, 'producing', $2, $3, $4, $5) RETURNING id`,
    [topic.id, format, voice, lengthBand, hookType],
  );
  const id = job!.id;
  try {
    const facts = await loadFacts(ds, format);
    if (format === 'THEN_NOW' && (!facts.series || facts.series.years.length < 10)) {
      format = 'MAP_REVEAL';
      await q('UPDATE jobs SET format = $2 WHERE id = $1', [id, format]);
    }
    await q('UPDATE jobs SET facts = $2 WHERE id = $1', [id, facts]);
    // A ranking needs a clear #1. When the top countries share the same value (internet use: many
    // countries at 100%), there is no story, so the topic is dropped and the next one is tried.
    const tied = facts.ranking.filter((r) => r.display === facts.ranking[0]?.display).length;
    if (format !== 'SCALE' && tied >= 2) {
      await q(`UPDATE jobs SET status = 'skipped', error = $2, updated_at = now() WHERE id = $1`, [id, `top ${tied} tied at ${facts.ranking[0].display}`]);
      await q(`UPDATE topics SET status = 'skipped' WHERE id = $1`, [topic.id]);
      await alert(`Skipped "${topic.question}": the top ${tied} countries are all at ${facts.ranking[0].display}, so there is no #1.${skips < 2 ? ' Trying the next topic.' : ''}`);
      return skips < 2 ? produceOne(skips + 1) : undefined;
    }
    // The last 10 scripts, so the writer can steer clear of wording they already used.
    const recent = await q<{ script: Content['script'] }>(`SELECT script FROM jobs WHERE script IS NOT NULL AND id <> $1 ORDER BY id DESC LIMIT 10`, [id]);
    const recentLines = recent.map((r) => (r.script?.beats ?? []).map((b) => b.vo ?? ''));
    const content = await generateContent({ question: topic.question, format, facts, twist: topic.expected_twist, lengthBand: lengthBand ?? undefined, hookType: hookType ?? undefined, recentLines, onStep: (step) => console.log(`[job ${id}] ${step}`) });
    await q(
      `UPDATE jobs SET script = $2, hooks = $3, packaging = $4, critic = $5, chosen_hook = $6, hook_type = $7, status = 'rendering', updated_at = now() WHERE id = $1`,
      [id, content.script, { list: content.hooks, original: content.originalHook }, content.packaging, content.critic, content.chosenHook, content.hookType],
    );
    await unloadModels();
    await renderAndPreview(id);
    return id;
  } catch (e: any) {
    const human = e instanceof NeedsHuman;
    await q(`UPDATE jobs SET status = $2, error = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1`, [id, human ? 'needs_human' : 'render_failed', String(e.message ?? e)]);
    const t = await one<{ fail_count: number }>(
      `UPDATE topics SET fail_count = fail_count + 1, status = CASE WHEN fail_count + 1 >= 3 THEN 'failed' ELSE 'idea' END, priority = priority - 1 WHERE id = $1 RETURNING fail_count`,
      [topic.id],
    );
    await alert(`Job #${id} (${topic.question}) ${human ? 'needs a human look' : 'failed'}: ${e.message}${e.detail ? `\n${JSON.stringify(e.detail).slice(0, 600)}` : ''}${t && t.fail_count >= 3 ? '\nThe topic failed 3 times and was moved to dead letter.' : ''}`);
    return id;
  }
}

export async function renderAndPreview(id: number, reuseClips = false): Promise<void> {
  const job = (await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]))!;
  const ds = await getDataset((await one<{ dataset_id: string }>('SELECT dataset_id FROM topics WHERE id = $1', [job.topic_id]))!.dataset_id);
  const dir = jobDir(id);
  const res = await renderShort({
    workDir: dir,
    outFile: jobVideo(id),
    format: job.format,
    facts: job.facts,
    ds,
    beats: job.script.beats,
    voice: job.voice,
    seed: id,
    reuseClips: reuseClips && job.render ? job.render.clips : undefined,
  });
  const qa = await runQa({
    video: res.video,
    voiceTrack: path.join(dir, 'voice.wav'),
    beats: res.props.beats,
    fps: 30,
    sourceLine: job.facts.source_line,
    license: job.facts.license,
    numbersOk: true,
    criticVerdict: job.critic?.verdict,
    heard: res.heard,
  });
  await q(`UPDATE jobs SET video_path = $2, render = $3, qa = $4, status = $5, updated_at = now() WHERE id = $1`, [
    id, res.video, { clips: res.clips, seconds: res.seconds, music: res.music }, qa, qa.passed ? 'awaiting_approval' : 'render_failed',
  ]);
  if (!qa.passed) {
    await alert(`Job #${id} failed QA:\n${qaSummary(qa)}`);
    return;
  }
  await sendPreview(id);
}

export function previewKeyboard(job: Pick<JobRow, 'id' | 'hooks' | 'chosen_hook'>): Keyboard {
  const hookButtons = (job.hooks?.list ?? []).map((h, i) => ({ text: `Hook ${i + 1}`, callback_data: `hk:${job.id}:${i}` })).filter((_, i) => i !== job.chosen_hook);
  return [
    [{ text: '✅ Approve', callback_data: `ap:${job.id}` }, { text: '❌ Reject', callback_data: `rj:${job.id}` }],
    ...(hookButtons.length ? [hookButtons] : []),
  ];
}

export async function sendPreview(id: number): Promise<void> {
  const job = (await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]))!;
  const topic = await one<any>('SELECT * FROM topics WHERE id = $1', [job.topic_id]);
  const hooks = job.hooks?.list ?? [];
  const lines = [
    `<b>#${id}</b> · ${FORMAT_NAMES[job.format]} · ${job.voice} · ${job.render?.seconds.toFixed(1)} s`,
    `<b>Q:</b> ${esc(topic.question)}`,
    `<b>Hook now:</b> ${esc(job.script.beats[0].vo)}`,
    ...hooks.map((h, i) => `${i === job.chosen_hook ? '▶' : `${i + 1}.`} ${esc(h.type)}: ${esc(h.text)}`),
    `<b>Title:</b> ${esc(job.packaging.title)}`,
    `<b>Why this video:</b> ${esc(topic.trend_link ? `rides "${topic.trend_link}"` : topic.source === 'launch' ? 'launch concept' : topic.source === 'followup' ? 'follow-up to a winner' : 'evergreen angle')}${topic.expected_twist ? ` · ${esc(topic.expected_twist)}` : ''}`,
    `<b>Source:</b> ${esc(job.facts.source_line)}`,
    qaSummary(job.qa!),
  ];
  const messageId = await sendVideo(job.video_path!, lines.join('\n'), previewKeyboard(job));
  if (messageId) await q('UPDATE jobs SET telegram_message_id = $2 WHERE id = $1', [id, messageId]);
}

export async function swapHook(id: number, index: number): Promise<void> {
  const job = (await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]))!;
  const hook = job.hooks?.list?.[index];
  if (!hook) return;
  const beats = job.script.beats.map((b, i) => (i === 0 ? { ...b, vo: hook.text } : b));
  await q(`UPDATE jobs SET script = $2, chosen_hook = $3, hook_type = $4, status = 'rendering', updated_at = now() WHERE id = $1`, [id, { ...job.script, beats }, index, hook.type]);
  await say(`🎬 Re-rendering #${id} with hook ${index + 1} (${esc(hook.type)}). About 5 minutes.`);
  await renderAndPreview(id, true);
}

export async function cleanupOldRenders(): Promise<void> {
  const old = await q<{ id: number }>(
    `SELECT id FROM jobs WHERE status IN ('published','rejected','render_failed','needs_human','dead_letter') AND updated_at < now() - interval '14 days' AND video_path IS NOT NULL`);
  for (const { id } of old) {
    await fs.rm(jobDir(id), { recursive: true, force: true });
    await fs.rm(jobVideo(id), { force: true });
    await q('UPDATE jobs SET video_path = NULL WHERE id = $1', [id]);
  }
}
