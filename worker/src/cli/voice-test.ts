// `npm run voice-test`: the same ~30-second script in four voices, as MP3s in renders/.
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { synthesize } from '../voice.js';
import { run } from '../lib/proc.js';

const SCRIPT = [
  "New Zealand isn't the only country outnumbered by sheep.",
  'Most people guess Australia next.',
  'They would be right, but the list keeps going.',
  'In some countries, sheep outnumber people more than two to one.',
  'And one of them is nowhere near the ocean.',
  'Every number here comes from public data, with the source on screen.',
  'Which country would you have guessed?',
].join(' ');
const voices = ['am_michael', 'af_heart', 'am_fenrir', 'bm_george'];
const dir = path.join(config.rendersDir, 'voice-test');
await fs.mkdir(dir, { recursive: true });
for (const v of voices) {
  const [clip] = await synthesize([{ id: v, text: SCRIPT }], v, dir);
  const out = path.join(config.rendersDir, `voice-test-${v}.mp3`);
  await run('ffmpeg', ['-y', '-i', clip.path, '-af', 'loudnorm=I=-16:TP=-1.5', '-b:a', '160k', out]);
  console.log(`${v}: ${clip.seconds.toFixed(1)} s -> ${out}`);
}
console.log(`\nListen on your phone after copying them: cp /opt/percapita/renders/voice-test-*.mp3 /opt/percapita/public/\nhttps://${config.mediaDomain}/voice-test-am_michael.mp3 (swap in each voice name)`);
