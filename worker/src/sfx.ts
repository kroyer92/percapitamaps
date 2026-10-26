// Sound effects: a whoosh when the picture moves, a tick when a row or option appears, a riser
// into the reveal and a hit on it. The sounds are synthesised with ffmpeg, so there is nothing to
// download and no licence to track. Set SFX=off to leave them out, SFX_GAIN to make them louder
// or quieter (1 = default).
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './lib/proc.js';
import { readWav, writeWav } from './audio.js';
import { countdownSchedule } from '../remotion/schedule.js';
import type { ShortProps } from '../remotion/types.js';

const RATE = 48000;
const FPS = 30;
export const RISER_SECONDS = 1.1;

type Sound = 'whoosh' | 'tick' | 'riser' | 'hit';

// ffmpeg aevalsrc expressions; t is seconds. Each starts at full level and fades by itself.
const SOUNDS: Record<Sound, { seconds: number; expr: string; filter?: string }> = {
  // Filtered noise that swells and falls: air moving past.
  whoosh: { seconds: 0.5, expr: '(random(0)*2-1)*sin(PI*t/0.5)^2', filter: 'highpass=f=500,lowpass=f=4000' },
  // A short, bright click.
  tick: { seconds: 0.09, expr: '0.8*sin(2*PI*1700*t)*exp(-t*70)' },
  // A rising tone with rising noise, ending at the reveal.
  riser: { seconds: RISER_SECONDS, expr: `(0.45*sin(2*PI*(180*t+260*t*t))+0.25*(random(0)*2-1))*(t/${RISER_SECONDS})^2`, filter: 'lowpass=f=6000' },
  // A low boom with a crack on top.
  hit: { seconds: 1.2, expr: '0.65*sin(2*PI*(48*t+60*(1-exp(-t*18))/18))*exp(-t*4)+0.3*(random(0)*2-1)*exp(-t*35)', filter: 'lowpass=f=5000' },
};

const GAIN: Record<Sound, number> = { whoosh: 0.32, tick: 0.35, riser: 0.3, hit: 0.6 };

export interface SfxCue { sound: Sound; at: number } // seconds

async function makeSounds(dir: string): Promise<Record<Sound, string>> {
  await fs.mkdir(dir, { recursive: true });
  const out = {} as Record<Sound, string>;
  for (const [name, s] of Object.entries(SOUNDS) as [Sound, (typeof SOUNDS)[Sound]][]) {
    const file = path.join(dir, `${name}.wav`);
    const af = ['aformat=channel_layouts=mono', s.filter].filter(Boolean).join(',');
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='${s.expr}':s=${RATE}:d=${s.seconds}`,
      '-af', af, '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', file]);
    out[name] = file;
  }
  return out;
}

// Where the sounds go, from the same timings the video uses.
export function sfxCues(p: ShortProps): SfxCue[] {
  const cues: SfxCue[] = [{ sound: 'whoosh', at: 0 }];
  const sec = (frame: number) => frame / FPS;
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'));
  if (p.format === 'COUNTDOWN') {
    const times = countdownSchedule(p);
    for (const t of times.slice(0, -1)) cues.push({ sound: 'tick', at: sec(t) });
  } else if (p.format === 'GUESS') {
    const showFrom = p.beats.find((b) => b.visual.startsWith('flag_row'))?.start ?? p.beats[1]?.start ?? 20;
    (p.guess?.options ?? []).forEach((_, i) => cues.push({ sound: 'tick', at: sec(showFrom + i * 6) }));
  } else if (p.format === 'SCALE') {
    p.beats.slice(1).filter((b) => b.visual.startsWith('scale_grid')).forEach((b) => cues.push({ sound: 'tick', at: sec(b.start) }));
  } else {
    // Map and race videos: the picture moves on every beat.
    p.beats.slice(1).filter((b) => b !== reveal).forEach((b) => cues.push({ sound: 'whoosh', at: sec(b.start) }));
  }
  if (reveal) {
    cues.push({ sound: 'riser', at: Math.max(0, sec(reveal.start) - RISER_SECONDS) });
    cues.push({ sound: 'hit', at: sec(reveal.start) });
  }
  return cues.sort((a, b) => a.at - b.at);
}

// Mixes every cue into one mono track the length of the video. Returns undefined when SFX=off.
export async function buildSfxTrack(p: ShortProps, seconds: number, workDir: string): Promise<string | undefined> {
  if ((process.env.SFX ?? 'on').toLowerCase() === 'off') return undefined;
  const gain = Number(process.env.SFX_GAIN ?? 1) || 1;
  const files = await makeSounds(path.join(workDir, 'sfx'));
  const pcm = Object.fromEntries(await Promise.all((Object.keys(files) as Sound[]).map(async (k) => [k, (await readWav(files[k])).data]))) as Record<Sound, Int16Array>;
  // Every sound peaks at the same level before its own gain, whatever the filters did to it.
  const peak = (d: Int16Array) => d.reduce((m, x) => Math.max(m, Math.abs(x)), 1);
  const norm = Object.fromEntries((Object.keys(pcm) as Sound[]).map((k) => [k, 29000 / peak(pcm[k])])) as Record<Sound, number>;
  const mix = new Float32Array(Math.ceil(seconds * RATE));
  for (const c of sfxCues(p)) {
    const src = pcm[c.sound];
    const at = Math.round(c.at * RATE);
    const g = GAIN[c.sound] * norm[c.sound] * gain;
    for (let i = 0; i < src.length && at + i < mix.length; i++) mix[at + i] += src[i] * g;
  }
  const data = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) data[i] = Math.max(-32768, Math.min(32767, Math.round(mix[i])));
  const out = path.join(workDir, 'sfx.wav');
  await writeWav(out, { rate: RATE, data });
  return out;
}
