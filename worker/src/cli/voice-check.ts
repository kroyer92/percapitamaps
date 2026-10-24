// `npm run voice-check -- --job 1`: what Whisper hears in a job's voice track, next to the script,
// to see why "Voice says the script" failed.
import path from 'node:path';
import { one, pool } from '../db.js';
import { jobDir } from '../produce.js';
import { transcribe, wordDiff } from '../voice.js';
import { arg } from './args.js';

const id = Number(arg('job'));
const job = await one<{ script: { beats: { vo: string }[] } }>('SELECT script FROM jobs WHERE id = $1', [id]);
if (!job) {
  console.error(`No job #${id}. Usage: npm run voice-check -- --job 1`);
  process.exit(1);
}
const expected = job.script.beats.map((b) => b.vo).join(' ');
const heard = (await transcribe(path.join(jobDir(id), 'voice.wav'))).map((w) => w.word).join(' ');
const { wer, mistakes } = wordDiff(expected, heard);
console.log(`SCRIPT:\n${job.script.beats.map((b, i) => `  ${i + 1}. ${b.vo}`).join('\n')}\n\nHEARD:\n  ${heard}\n`);
console.log(`Word error rate ${(wer * 100).toFixed(1)}%. Differences:\n${mistakes.map((m) => `  - ${m}`).join('\n') || '  (none)'}`);
await pool.end();
