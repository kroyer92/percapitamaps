// Builds the voiceover track and mixes it with a quiet music bed at -14 LUFS.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { run } from './lib/proc.js';
import type { Placed } from './timeline.js';

export interface Pcm { rate: number; data: Int16Array }

export async function readWav(file: string): Promise<Pcm> {
  const buf = await fs.readFile(file);
  let off = 12;
  let rate = 24000;
  let channels = 1;
  let bits = 16;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1) throw new Error(`Unexpected WAV format in ${file}: ${bits} bit, ${channels} ch`);
      const data = new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
      return { rate, data };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`No data chunk in ${file}`);
}

export async function writeWav(file: string, pcm: Pcm): Promise<void> {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.data.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(pcm.rate, 24);
  header.writeUInt32LE(pcm.rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.data.length * 2, 40);
  await fs.writeFile(file, Buffer.concat([header, Buffer.from(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength)]));
}

export async function buildVoiceTrack(placed: Placed[], seconds: number, out: string): Promise<void> {
  const clips = await Promise.all(placed.map((p) => readWav(p.clip.path)));
  const rate = clips[0].rate;
  const data = new Int16Array(Math.ceil(seconds * rate));
  placed.forEach((p, i) => {
    const at = Math.round(p.voiceAt * rate);
    data.set(clips[i].data.subarray(0, Math.max(0, data.length - at)), at);
  });
  await writeWav(out, { rate, data });
}

export interface MusicPick { file: string; credit: string }

export async function pickMusic(seed: number): Promise<MusicPick | undefined> {
  try {
    const credits = JSON.parse(await fs.readFile(path.join(config.musicDir, 'credits.json'), 'utf8')) as Record<string, string>;
    const files: string[] = [];
    for (const f of Object.keys(credits).sort()) {
      try { await fs.access(path.join(config.musicDir, f)); files.push(f); } catch { /* listed but missing */ }
    }
    if (!files.length) return undefined;
    const f = files[seed % files.length];
    return { file: path.join(config.musicDir, f), credit: credits[f] };
  } catch {
    return undefined;
  }
}

// Mix voice, music and sound effects, normalise to -14 LUFS with true peak under -1 dBTP, and mux onto the silent video.
export async function finalMix(video: string, voice: string, music: MusicPick | undefined, seconds: number, out: string, sfx?: string): Promise<void> {
  const dir = path.dirname(out);
  const mix = path.join(dir, `${path.basename(out, path.extname(out))}.mix.wav`);
  const inputs = ['-y', '-i', voice];
  const parts = ['[vo]'];
  let filter = '[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[vo]';
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music.file);
    filter += `;[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-33:TP=-8:LRA=11,afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, seconds - 1.2)}:d=1.2[m]`;
    parts.push('[m]');
  }
  if (sfx) {
    inputs.push('-i', sfx);
    filter += `;[${music ? 2 : 1}:a]aresample=48000,aformat=channel_layouts=stereo[fx]`;
    parts.push('[fx]');
  }
  filter += parts.length > 1 ? `;${parts.join('')}amix=inputs=${parts.length}:duration=first:normalize=0[a]` : ';[vo]anull[a]';
  await run('ffmpeg', [...inputs, '-filter_complex', filter, '-map', '[a]', '-t', seconds.toFixed(3), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', mix]);

  await master(video, mix, seconds, out);
  await fs.rm(mix, { force: true });
}

// Loudness and true peak exactly as the QA gate measures them (EBU R128, oversampled true peak).
export async function measureLoudness(file: string): Promise<{ I: number; peak: number }> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const raw = summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1];
  const peak = raw === '-inf' ? -Infinity : Number(raw);
  return { I, peak };
}

const TARGET_I = -14;
const PEAK_MAX = -1.2; // QA wants under -1 dBTP; 0.2 dB spare

// Gain to -14 LUFS, then a limiter run at 4x the sample rate so it catches the peaks between samples
// (true peak), then AAC. The finished file is measured the way QA measures it and made again with a
// lower ceiling or corrected gain until it is in range, so a loud sound effect or the AAC encoder can
// never push the true peak over -1 dBTP. Two-pass loudnorm did not guarantee that: when the gain it
// needs would clip, it silently switches to its dynamic mode, whose limiter let job #88 (19 Nov 2026)
// out at +1 dBTP and the QA gate stopped the video.
async function master(video: string, mix: string, seconds: number, out: string): Promise<void> {
  const src = await measureLoudness(mix);
  let gain = Number.isFinite(src.I) ? TARGET_I - src.I : 0;
  let ceiling = -2;
  const miss = (r: { I: number; peak: number }) => (r.peak >= PEAK_MAX ? 100 + r.peak : 0) + (Number.isFinite(r.I) ? Math.abs(r.I - TARGET_I) : 0);
  let best: { file: string; score: number } | undefined;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const file = `${out}.try${attempt}.mp4`;
    const limit = Math.max(0.0625, 10 ** (ceiling / 20)).toFixed(4);
    const chain = `[1:a]aformat=sample_fmts=fltp,volume=${gain.toFixed(2)}dB,aresample=192000,alimiter=limit=${limit}:attack=5:release=60:level=disabled,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`;
    await run('ffmpeg', ['-y', '-i', video, '-i', mix, '-filter_complex', chain,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', seconds.toFixed(3), file]);
    const got = await measureLoudness(file);
    const score = miss(got);
    if (!best || score < best.score) {
      if (best) await fs.rm(best.file, { force: true });
      best = { file, score };
    } else await fs.rm(file, { force: true });
    if (score <= 0.5) break; // true peak under -1.2 dBTP and within 0.5 LU of -14
    if (got.peak >= PEAK_MAX) ceiling -= got.peak - PEAK_MAX + 0.3;
    else if (Number.isFinite(got.I)) gain += TARGET_I - got.I;
  }
  await fs.rename(best!.file, out);
}
