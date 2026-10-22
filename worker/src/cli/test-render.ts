// `npm run test-render -- --concept cattle`: one full video from live data, without Telegram
// or the database queue. Writes renders/test-<concept>.mp4 and a .qa.json report.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, type Format } from '../config.js';
import { one, pool } from '../db.js';
import { CATALOG } from '../data/catalog.js';
import { CONCEPTS } from '../data/concepts.js';
import { loadFacts } from '../facts.js';
import { generateContent } from '../content.js';
import { unloadModels } from '../llm.js';
import { renderShort } from '../render.js';
import { runQa } from '../qa.js';
import { pickVoice } from '../produce.js';
import { arg } from './args.js';

const key = arg('concept', 'cattle')!;
const concept = CONCEPTS.find((c) => c.key === key);
if (!concept) {
  console.error(`Unknown concept "${key}". Pick one of: ${CONCEPTS.map((c) => c.key).join(', ')}`);
  process.exit(1);
}
const format = (arg('format') as Format) ?? concept.format;
const spec = CATALOG.find((d) => d.id === concept.dataset)!;
// Use the slug the dataset check found, if the database has one.
const row = await one<{ resolved_ref: any; enabled: boolean; check_error: string }>('SELECT resolved_ref, enabled, check_error FROM datasets WHERE id = $1', [spec.id]).catch(() => undefined);
if (row && !row.enabled) {
  console.error(`The ${spec.id} dataset is disabled: ${row.check_error}\nTry another concept, for example: npm run test-render -- --concept hours`);
  process.exit(1);
}
const ds = { ...spec, ref: row?.resolved_ref ?? spec.ref };

const t0 = Date.now();
const step = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${s}`);
step(`Concept "${key}" · ${format} · dataset ${spec.id}`);
const facts = await loadFacts(ds, format);
step(`Facts: ${facts.year}, ${facts.countries_count} countries, #1 ${facts.ranking[0].name} (${facts.ranking[0].display})`);
const content = await generateContent({ question: concept.question, format, facts, twist: concept.twist });
step(`Script written: ${content.script.beats.length} beats, critic ${content.critic.verdict}`);
content.script.beats.forEach((b, i) => console.log(`         ${i + 1}. ${b.vo}   [${b.visual}] "${b.on_screen}"`));
await unloadModels();
const voice = pickVoice();
const workDir = path.join(config.rendersDir, 'jobs', `test-${key}`);
const out = path.join(config.rendersDir, `test-${key}.mp4`);
let lastPct = -10;
const res = await renderShort({
  workDir, outFile: out, format, facts, ds, beats: content.script.beats, voice, seed: Date.now(),
  onStep: step,
  onProgress: (p) => { const pct = Math.floor(p * 100); if (pct >= lastPct + 10) { lastPct = pct; step(`Rendering ${pct}%`); } },
});
step(`Rendered ${res.seconds.toFixed(1)} s with voice ${voice}`);
step('Checking the video (the first run also downloads the speech checker, about 500 MB)');
const qa = await runQa({ video: out, voiceTrack: path.join(workDir, 'voice.wav'), beats: res.props.beats, fps: 30, sourceLine: facts.source_line, license: facts.license, numbersOk: true, criticVerdict: content.critic.verdict });
await fs.writeFile(path.join(config.rendersDir, `test-${key}.qa.json`), JSON.stringify({ concept: key, title: content.packaging.title, hooks: content.hooks, qa }, null, 2));
step('QA:');
for (const c of qa.checks) console.log(`         ${c.status.toUpperCase().padEnd(4)} ${c.name}: ${c.detail}`);
console.log(`\n${qa.passed ? 'PASSED' : 'FAILED'}. Title: ${content.packaging.title}`);
console.log(`\nTo watch it on your phone, run these two lines on the server:\n  cd /opt/percapita && cp renders/test-${key}.mp4 public/\n  echo https://${config.mediaDomain}/test-${key}.mp4\nThen delete the copy with: rm public/test-${key}.mp4`);
await pool.end();
