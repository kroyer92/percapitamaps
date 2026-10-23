// The parts every format shares: background, kicker, headline, captions and source line.
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
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

export const Kicker: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ position: 'absolute', top: ZONE.kicker, left: SAFE.left, right: W - SAFE.right, textAlign: 'center',
    fontFamily: FONT, fontWeight: 700, fontSize: 30, letterSpacing: 4, color: C.amber, textTransform: 'uppercase' }}>
    {text}
  </div>
);

export const Headline: React.FC<{ beats: TimedBeat[] }> = ({ beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { beat } = currentBeat(beats, frame);
  const local = frame - beat.start;
  const s = spring({ frame: local, fps, config: { damping: 200 }, durationInFrames: 10 });
  const text = beat.on_screen || '';
  const size = text.length > 34 ? 64 : text.length > 22 ? 74 : 86;
  return (
    <div style={{ position: 'absolute', top: ZONE.headline, left: SAFE.left, right: W - SAFE.right, height: 220,
      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.08, color: C.pale,
        letterSpacing: -1, opacity: frame < 2 ? 1 : s, transform: `translateY(${(1 - s) * 18}px)`, textWrap: 'balance' as any }}>
        {text}
      </div>
    </div>
  );
};

// Word-by-word captions of the voiceover, a few words at a time, current word in amber.
export const Captions: React.FC<{ beats: TimedBeat[] }> = ({ beats }) => {
  const frame = useCurrentFrame();
  const { beat } = currentBeat(beats, frame);
  const words = beat.words;
  if (!words.length || frame < words[0].start - 2) return null;
  let cur = words.findIndex((w) => frame >= w.start && frame < w.end);
  if (cur < 0) cur = frame >= words[words.length - 1].end ? words.length - 1 : 0;
  const chunkStart = Math.floor(cur / 4) * 4;
  const chunk = words.slice(chunkStart, chunkStart + 4);
  return (
    <div style={{ position: 'absolute', top: ZONE.captions, left: SAFE.left, right: W - SAFE.right, height: 120,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '0 18px' }}>
      {chunk.map((w, i) => (
        <span key={i} style={{ fontFamily: FONT, fontWeight: 800, fontSize: 58, color: chunkStart + i === cur ? C.amber : C.pale,
          textShadow: '0 4px 18px rgba(0,0,0,0.55)' }}>
          {w.text}
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
