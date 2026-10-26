// Turns script beats plus voice clip lengths into frame timings for the video.
import type { Beat } from './validate.js';
import type { VoiceClip, Word } from './voice.js';
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

type CaptionWord = { text: string; start: number; end: number };

const weight = (w: string) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length + (/[.,!?]$/.test(w) ? 2 : 0));

// Spread words over a span of seconds, weighted by length.
function spread(words: string[], from: number, to: number): CaptionWord[] {
  const weights = words.map(weight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return words.map((w, i) => {
    const s = from + (acc / total) * (to - from);
    acc += weights[i];
    return { text: w, start: s, end: from + (acc / total) * (to - from) };
  });
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '');

// Karaoke captions for one beat, in frames. With Whisper's word timings of the real voice track,
// each script word that Whisper heard takes its spoken time; words it wrote differently (numbers,
// "$436" said as "436 dollars") are spread between the matched words around them. Without timings
// (Whisper failed) the words are spread over the clip by length, which drifts on pauses and numbers.
export function captionWords(text: string, startSec: number, seconds: number, heard: Word[] = []): CaptionWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  const endSec = startSec + seconds;
  const inBeat = heard.filter((h) => { const mid = (h.start + h.end) / 2; return mid >= startSec - 0.1 && mid <= endSec + 0.1; });
  const a = words.map(norm);
  const b = inBeat.map((h) => norm(h.word));
  // Longest common subsequence of the letter-only words: the anchors.
  const L: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const anchor: (Word | undefined)[] = Array(a.length);
  const at: number[] = Array(a.length).fill(-1); // index in inBeat of each anchor
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] && a[i] === b[j]) { at[i] = j; anchor[i++] = inBeat[j++]; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  const out: CaptionWord[] = [];
  for (let i = 0; i < words.length; ) {
    const h = anchor[i];
    if (h) { out.push({ text: words[i], start: Math.max(h.start, out.at(-1)?.end ?? startSec), end: h.end }); i++; continue; }
    let k = i;
    while (k < words.length && !anchor[k]) k++;
    // The unmatched words take the time of the unmatched heard words between the same anchors.
    const between = inBeat.slice(i > 0 ? at[i - 1] + 1 : 0, k < words.length ? at[k] : inBeat.length);
    const prevEnd = out.at(-1)?.end ?? startSec;
    const from = Math.max(prevEnd, between[0]?.start ?? prevEnd);
    const to = between.at(-1)?.end ?? anchor[k]?.start ?? endSec;
    out.push(...spread(words.slice(i, k), from, Math.max(to, from + 0.1 * (k - i))));
    i = k;
  }
  return out.map((w) => ({ text: w.text, start: Math.round(w.start * FPS), end: Math.max(Math.round(w.start * FPS) + 1, Math.round(w.end * FPS)) }));
}

export function timedBeats(placed: Placed[], totalSec: number, heard: Word[] = []): TimedBeat[] {
  return placed.map((p, i) => ({
    start: Math.round(p.visualAt * FPS),
    voStart: Math.round(p.voiceAt * FPS),
    end: Math.round((placed[i + 1]?.visualAt ?? totalSec) * FPS),
    vo: p.beat.vo,
    on_screen: p.beat.on_screen ?? '',
    visual: p.beat.visual ?? '',
    words: captionWords(p.beat.vo, p.voiceAt, p.clip.seconds, heard),
  }));
}
