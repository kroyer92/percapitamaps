import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { lastJsonLine, run } from './lib/proc.js';

// Spell out what the voice engine would otherwise misread.
export function speakable(text: string): string {
  return text
    .replace(/\$(\d[\d,.]*)\s*(trillion|billion|million)?/g, (_m, n, big) => `${n}${big ? ' ' + big : ''} dollars`)
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/(\d)\s*°C/g, '$1 degrees')
    .replace(/CO₂/g, 'C O 2')
    .replace(/(\d)\s*kWh\b/g, '$1 kilowatt hours')
    .replace(/(\d)\s*kg\b/g, '$1 kilograms')
    .replace(/(\d)\s*cm\b/g, '$1 centimetres')
    .replace(/(\d)\s*mm\b/g, '$1 millimetres')
    .replace(/(\d)\s*km\b/g, '$1 kilometres')
    .replace(/(\d(?:\.\d+)?)x\b/g, '$1 times')
    // "3.53" -> "3 point 5 3"; the voice drops the dot otherwise.
    .replace(/(\d)\.(\d+)/g, (_m, a, b) => `${a} point ${b.split('').join(' ')}`)
    .replace(/#(\d+)/g, 'number $1')
    .replace(/\bvs\.?\b/gi, 'versus')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface VoiceClip { id: string; path: string; seconds: number }

export async function synthesize(items: { id: string; text: string }[], voice: string, outdir: string): Promise<VoiceClip[]> {
  await fs.mkdir(outdir, { recursive: true });
  const job = {
    models_dir: path.join(config.modelsDir, 'kokoro'),
    voice,
    outdir,
    speed: Number(process.env.VOICE_SPEED ?? 1.05),
    items: items.map((i) => ({ id: i.id, text: speakable(i.text) })),
  };
  const { stdout } = await run(config.python, [path.resolve('py/tts.py')], { input: JSON.stringify(job), timeoutMs: 10 * 60_000 });
  return lastJsonLine<{ items: VoiceClip[] }>(stdout).items;
}

export interface Word { word: string; start: number; end: number }

export async function transcribe(audio: string): Promise<Word[]> {
  const job = { models_dir: config.modelsDir, model: config.whisperModel, audio };
  const { stdout } = await run(config.python, [path.resolve('py/transcribe.py')], { input: JSON.stringify(job), timeoutMs: 10 * 60_000 });
  return lastJsonLine<{ words: Word[] }>(stdout).words;
}

// Word error rate between what the script says and what Whisper heard.
export function wordErrorRate(expected: string, heard: string): number {
  const norm = (s: string) => speakable(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const a = norm(expected);
  const b = norm(heard);
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return a.length ? d[a.length][b.length] / a.length : 0;
}
