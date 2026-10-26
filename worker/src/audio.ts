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

// Mix voice, music and sound effects, normalise to -14 LUFS (two-pass loudnorm), and mux onto the silent video.
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

  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await run('ffmpeg', ['-y', '-i', video, '-i', mix, '-filter_complex', `[1:a]${ln},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', seconds.toFixed(3), out]);
  await fs.rm(mix, { force: true });
}
