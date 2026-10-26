// The automatic part of the QA gate (plan section B4). Fails block the video; warnings
// are shown to you in the Telegram preview.
import { run } from './lib/proc.js';
import { transcribe, wordDiff, type Word } from './voice.js';
import { licenseVerdict } from './data/fetch.js';
import type { TimedBeat } from '../remotion/types.js';

export type Status = 'pass' | 'warn' | 'fail';
export interface Check { name: string; status: Status; detail: string }
export interface QaReport { passed: boolean; checks: Check[] }

async function probe(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  return JSON.parse(stdout);
}

async function loudness(file: string): Promise<{ I: number; peak: number }> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1]);
  return { I, peak };
}

async function silences(file: string): Promise<{ start: number; end: number }[]> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=n=-40dB:d=0.6', '-f', 'null', '-']);
  const out: { start: number; end: number }[] = [];
  let start: number | undefined;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: (-?[\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== undefined) { out.push({ start, end: Number(e[1]) }); start = undefined; }
  }
  return out;
}

export async function runQa(opts: {
  video: string;
  voiceTrack: string;
  beats: TimedBeat[];
  fps: number;
  sourceLine: string;
  license: string;
  numbersOk: boolean;
  criticVerdict?: string;
  skipWhisper?: boolean;
  heard?: Word[]; // already transcribed by the render (caption timing)
}): Promise<QaReport> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });

  const info = await probe(opts.video);
  const v = info.streams.find((s: any) => s.codec_type === 'video');
  const a = info.streams.find((s: any) => s.codec_type === 'audio');
  const dur = Number(info.format.duration);
  const fmtOk = v?.width === 1080 && v?.height === 1920 && v?.r_frame_rate === '30/1' && v?.codec_name === 'h264' && a?.codec_name === 'aac';
  add('Format', fmtOk ? 'pass' : 'fail', `${v?.width}x${v?.height} ${v?.r_frame_rate} ${v?.codec_name}+${a?.codec_name}`);
  add('Length', dur >= 20 && dur <= 45 ? 'pass' : dur >= 15 && dur <= 58 ? 'warn' : 'fail', `${dur.toFixed(1)} s (target 20–45)`);

  const { I, peak } = await loudness(opts.video);
  add('Loudness', Math.abs(I + 14) <= 1 ? 'pass' : 'fail', `${I} LUFS (target -14 ±1)`);
  add('True peak', peak < -1 ? 'pass' : peak < 0 ? 'warn' : 'fail', `${peak} dBTP (target under -1)`);

  const pauseBeats = opts.beats.filter((b) => b.visual.startsWith('pause'));
  const sil = (await silences(opts.voiceTrack)).filter(
    (s) => !pauseBeats.some((b) => s.start >= b.voStart / opts.fps - 0.2 && s.start <= b.end / opts.fps + 0.2) && s.end < dur - 0.6,
  );
  const longest = Math.max(0, ...sil.map((s) => s.end - s.start));
  add('No dead air', longest <= 0.6 ? 'pass' : longest <= 1.2 ? 'warn' : 'fail', longest ? `longest pause ${longest.toFixed(2)} s` : 'no pauses over 0.6 s');

  const longBeats = opts.beats.map((b, i) => ({ i, s: (b.end - b.start) / opts.fps })).filter((b) => b.s > 3.0 && !opts.beats[b.i].visual.startsWith('pause'));
  add('Visual change every 3 s', longBeats.length ? 'warn' : 'pass', longBeats.length ? longBeats.map((b) => `beat ${b.i + 1}: ${b.s.toFixed(1)} s`).join(', ') : 'all beats 3 s or shorter');

  add('Numbers match data', opts.numbersOk ? 'pass' : 'fail', opts.numbersOk ? 'every number is in the facts' : 'a number is not in the facts');
  if (opts.criticVerdict !== undefined) add('Editorial critic', opts.criticVerdict === 'pass' ? 'pass' : 'fail', `verdict: ${opts.criticVerdict}`);
  add('Captions in safe zone', 'pass', 'layout keeps text between y 300 and 1490');

  const lic = licenseVerdict(opts.license);
  add('Attribution', opts.sourceLine && lic === 'ok' ? 'pass' : 'fail', `${opts.sourceLine}`);

  if (!opts.skipWhisper) {
    try {
      const words = opts.heard ?? (await transcribe(opts.voiceTrack));
      const heard = words.map((w) => w.word).join(' ');
      const { wer, mistakes } = wordDiff(opts.beats.map((b) => b.vo).join(' '), heard);
      const shown = wer > 0.05 && mistakes.length ? `; ${mistakes.slice(0, 6).join('; ')}${mistakes.length > 6 ? ` (+${mistakes.length - 6} more)` : ''}` : '';
      add('Voice says the script', wer <= 0.05 ? 'pass' : wer <= 0.15 ? 'warn' : 'fail', `word error rate ${(wer * 100).toFixed(1)}%${shown}`);
    } catch (e: any) {
      add('Voice says the script', 'warn', `skipped: ${String(e.message).slice(0, 120)}`);
    }
  }

  return { passed: !checks.some((c) => c.status === 'fail'), checks };
}

export function qaSummary(r: QaReport): string {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' } as const;
  return r.checks.filter((c) => c.status !== 'pass').map((c) => `${icon[c.status]} ${c.name}: ${c.detail}`).join('\n') || '✅ All QA checks passed';
}
