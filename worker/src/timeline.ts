// Turns script beats plus voice clip lengths into frame timings for the video.
import type { Beat } from './validate.js';
import type { VoiceClip } from './voice.js';
import type { TimedBeat } from '../remotion/types.js';

export const FPS = 30;
const LEAD = 0.12; // silence before the first word
const GAP = 0.14; // between beats
const TWIST_HOLD = 0.3; // visual lands before the voice on the reveal
const GUESS_PAUSE = 1.8; // thinking time on the GUESS pause beat
const TAIL = 0.5;

export interface Placed { beat: Beat; clip: VoiceClip; visualAt: number; voiceAt: number; endAt: number }

export function place(beats: Beat[], clips: VoiceClip[]): { placed: Placed[]; seconds: number } {
  const placed: Placed[] = [];
  let t = LEAD;
  beats.forEach((beat, i) => {
    const clip = clips[i];
    const visualAt = i === 0 ? 0 : t;
    let voiceAt = t;
    if (beat.visual?.startsWith('reveal_answer')) voiceAt += TWIST_HOLD;
    let endAt = voiceAt + clip.seconds;
    if (beat.visual?.startsWith('pause')) endAt += GUESS_PAUSE;
    placed.push({ beat, clip, visualAt, voiceAt, endAt });
    t = endAt + GAP;
  });
  return { placed, seconds: t - GAP + TAIL };
}

// Spread each beat's words over its clip, weighted by length, for karaoke captions.
export function captionWords(text: string, startSec: number, seconds: number): { text: string; start: number; end: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length + (/[.,!?]$/.test(w) ? 2 : 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return words.map((w, i) => {
    const s = startSec + (acc / total) * seconds;
    acc += weights[i];
    const e = startSec + (acc / total) * seconds;
    return { text: w, start: Math.round(s * FPS), end: Math.round(e * FPS) };
  });
}

export function timedBeats(placed: Placed[], totalSec: number): TimedBeat[] {
  return placed.map((p, i) => ({
    start: Math.round(p.visualAt * FPS),
    voStart: Math.round(p.voiceAt * FPS),
    end: Math.round((placed[i + 1]?.visualAt ?? totalSec) * FPS),
    vo: p.beat.vo,
    on_screen: p.beat.on_screen ?? '',
    visual: p.beat.visual ?? '',
    words: captionWords(p.beat.vo, p.voiceAt, p.clip.seconds),
  }));
}
