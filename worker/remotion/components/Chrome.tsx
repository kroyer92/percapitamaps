// The parts every format shares: background, kicker, headline, captions and source line.
import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { createTikTokStyleCaptions } from '@remotion/captions';
import { C, FONT, SAFE, W, ZONE } from '../theme';
import type { ShortProps, TimedBeat } from '../types';

export function currentBeat(beats: TimedBeat[], frame: number): { beat: TimedBeat; index: number } {
  let index = 0;
  for (let i = 0; i < beats.length; i++) if (frame >= beats[i].start) index = i;
  return { beat: beats[index], index };
}

export const Background: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(120% 80% at 50% 40%, ${C.bg} 0%, ${C.bgDeep} 100%)` }}>
    <svg width={W} height={1920} style={{ position: 'absolute', inset: 0 }}>
      {Array.from({ length: 12 }, (_, i) => (
        <line key={`v${i}`} x1={i * 90 + 45} y1={0} x2={i * 90 + 45} y2={1920} stroke={C.grid} strokeWidth={1} />
      ))}
      {Array.from({ length: 22 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={i * 90 + 30} x2={W} y2={i * 90 + 30} stroke={C.grid} strokeWidth={1} />
      ))}
    </svg>
  </AbsoluteFill>
);

// `from`: the kicker fades in then instead of being there from frame 0 (the rank strip opening).
export const Kicker: React.FC<{ text: string; top?: number; from?: number }> = ({ text, top = ZONE.kicker, from = 0 }) => {
  const frame = useCurrentFrame();
  const o = from > 0 ? interpolate(frame, [from, from + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  return (
    <div style={{ position: 'absolute', top, left: SAFE.left, right: W - SAFE.right, textAlign: 'center', opacity: o,
      fontFamily: FONT, fontWeight: 800, fontSize: 30, letterSpacing: 4, color: C.blue, textTransform: 'uppercase' }}>
      {text}
    </div>
  );
};

// `low`: under the rank strip, a little lower and smaller, so it clears the strip and the kicker
// above it and the answer's big number below it.
const STRIP_HEADLINE = { top: 470, height: 146 };
export const Headline: React.FC<{ beats: TimedBeat[]; low?: boolean }> = ({ beats, low }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { beat, index } = currentBeat(beats, frame);
  const local = frame - beat.start;
  const text = beat.on_screen || '';
  // The hook is the first thing a viewer sees, before deciding to swipe: big, heavy and fully
  // visible on frame 0, settling from slightly larger instead of fading in.
  if (index === 0) {
    const s = spring({ frame: local, fps, config: { damping: 16, stiffness: 260 } });
    const size = text.length > 40 ? 78 : text.length > 26 ? 88 : 100;
    return (
      <div style={{ position: 'absolute', top: ZONE.headline - 10, left: 40, right: 40, height: 250,
        display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: 1.02, color: C.pale, letterSpacing: -2,
          transform: `scale(${1.1 - 0.1 * s})`, textWrap: 'balance' as any, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>
          {text}
        </div>
      </div>
    );
  }
  const s = spring({ frame: local, fps, config: { damping: 200 }, durationInFrames: 10 });
  const size = low ? (text.length > 34 ? 56 : text.length > 22 ? 64 : 76) : text.length > 34 ? 64 : text.length > 22 ? 74 : 86;
  return (
    <div style={{ position: 'absolute', top: low ? STRIP_HEADLINE.top : ZONE.headline, left: SAFE.left, right: W - SAFE.right, height: low ? STRIP_HEADLINE.height : 220,
      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.08, color: C.pale,
        letterSpacing: -1, opacity: s, transform: `translateY(${(1 - s) * 18}px)`, textWrap: 'balance' as any, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>
        {text}
      </div>
    </div>
  );
};

// Punchy captions of the voiceover: one to three words at a time, large, each group popping in.
// The word being spoken is blue; amber stays reserved for the answer.
export const Captions: React.FC<{ beats: TimedBeat[] }> = ({ beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Grouped beat by beat, so a page never joins the end of one line to the start of the next
  // (on the Guess pause, "about it. The" would show the next line's first word too early).
  const pages = useMemo(() => beats.flatMap((b) => createTikTokStyleCaptions({
    captions: b.words.map((w, i) => ({
      text: i === 0 ? w.text : ` ${w.text}`,
      startMs: (w.start / fps) * 1000,
      endMs: (w.end / fps) * 1000,
      timestampMs: null,
      confidence: null,
    })),
    combineTokensWithinMilliseconds: 650,
  }).pages), [beats, fps]);
  const ms = (frame / fps) * 1000;
  const page = pages.find((p) => ms >= p.startMs && ms < p.startMs + p.durationMs);
  if (!page) return null;
  const pop = spring({ frame: frame - Math.round((page.startMs / 1000) * fps), fps, config: { damping: 14, stiffness: 240 } });
  const size = page.text.trim().length > 18 ? 70 : 84;
  return (
    <div style={{ position: 'absolute', top: ZONE.captions, left: SAFE.left, right: W - SAFE.right, height: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '0 20px',
      transform: `scale(${0.75 + 0.25 * pop})` }}>
      {page.tokens.map((t, i) => (
        <span key={i} style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, letterSpacing: -1,
          color: ms >= t.fromMs && ms < t.toMs ? C.blue : C.pale,
          textShadow: '0 5px 0 rgba(0,0,0,0.55), 0 0 28px rgba(0,0,0,0.6)' }}>
          {t.text.trim()}
        </span>
      ))}
    </div>
  );
};

export const SourceLine: React.FC<{ text: string; from: number; handle: string }> = ({ text, from, handle }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [from, from + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', top: ZONE.source, left: SAFE.left, right: W - SAFE.right, textAlign: 'center',
      fontFamily: FONT, fontWeight: 500, fontSize: 26, color: C.muted, opacity: o, lineHeight: 1.35 }}>
      {text}
      <div style={{ color: C.blue, fontWeight: 700, marginTop: 4 }}>{handle} · follow for a new map every day</div>
    </div>
  );
};

export function sourceFrom(props: ShortProps): number {
  const n = props.beats.length;
  return props.beats[Math.max(0, n - 2)].start;
}
