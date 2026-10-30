// The rank strip opening (Map Reveal test, see src/opening.ts). Frame 1 shows one famous country,
// zoomed in (MapReveal.tsx), with a badge of its rank and the hook's words as the voice says them.
// As the hook ends, slots #1 to #5 pop in at the top and the badge flies into its slot; #1 stays a
// glowing "?" until the reveal, so the open question is on screen the whole video.
import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, SAFE, W } from '../theme';
import { stripSlots, type StripSlot } from '../schedule';
import { Flag } from './Flag';
import type { ShortProps, TimedBeat } from '../types';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const STRIP = { top: 300, h: 118, gap: 12, kicker: 430 };
const BADGE_Y = 770; // where the badge sits during the hook, above the zoomed-in country

// Slot positions. An opening country further down than #6 gets a gap with "…" before its slot.
function boxes(p: ShortProps): (StripSlot & { x: number; w: number })[] {
  const slots = stripSlots(p);
  const jump = (p.opening?.rank ?? 0) > 6 ? 40 : 0;
  const w = (SAFE.right - SAFE.left - STRIP.gap * (slots.length - 1) - jump) / slots.length;
  return slots.map((s, i) => ({ ...s, x: SAFE.left + i * (w + STRIP.gap) + (i === 5 ? jump : 0), w }));
}

// The hook, word by word as the voice says it, big, where the headline would be. Words not yet said
// keep their place (invisible), so the line builds up without jumping.
const HookWords: React.FC<{ beat: TimedBeat; until: number }> = ({ beat, until }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [until - 4, until], [1, 0], clamp);
  if (out <= 0) return null;
  const chars = beat.vo.length;
  const size = chars > 34 ? 96 : chars > 24 ? 108 : 124;
  return (
    <div style={{ position: 'absolute', top: 330, left: 40, right: 40, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 26px', opacity: out }}>
      {beat.words.map((w, i) => {
        const at = Math.max(0, w.start - 4);
        const s = frame >= at ? spring({ frame: frame - at + (at === 0 ? 4 : 0), fps, config: { damping: 13, stiffness: 260 } }) : 0;
        const speaking = frame >= w.start && frame < w.end + 4;
        return (
          <span key={i} style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: 1.04, letterSpacing: -2,
            color: speaking ? '#ffffff' : C.pale, opacity: Math.min(1, s * 1.4), display: 'inline-block',
            transform: `scale(${1.25 - 0.25 * s}) translateY(${(1 - s) * 16}px)`, textShadow: '0 6px 30px rgba(0,0,0,0.7)' }}>
            {w.text}
          </span>
        );
      })}
    </div>
  );
};

const Strip: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = p.opening!;
  const slots = boxes(p);
  const byRank = new Map(p.ranking.map((r) => [r.rank, r]));
  const gap = slots.length > 5 && o.rank > 6 && frame >= slots[5].pop ? slots[4].x + slots[4].w : undefined;
  return (
    <>
      {gap !== undefined && (
        <div style={{ position: 'absolute', left: gap, width: slots[5].x - gap, top: STRIP.top, height: STRIP.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT, fontWeight: 900, fontSize: 34, color: C.muted }}>…</div>
      )}
      {slots.map((s) => {
        if (frame < s.pop) return null;
        const pop = spring({ frame: frame - s.pop, fps, config: { damping: 12, stiffness: 220 } });
        const r = byRank.get(s.rank);
        const filled = frame >= s.fill && r;
        const fs = filled ? spring({ frame: frame - s.fill, fps, config: { damping: 12 } }) : 0;
        const one = s.rank === 1;
        const amber = one && filled;
        const glow = one && !filled ? 0.35 + 0.25 * Math.sin(frame / 5) : 0;
        return (
          <div key={s.rank} style={{ position: 'absolute', left: s.x, top: STRIP.top, width: s.w, height: STRIP.h, borderRadius: 16, boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, fontFamily: FONT,
            background: amber ? C.amber : 'rgba(6,19,29,0.9)',
            border: `${one ? 3 : 2}px solid ${amber ? C.amber : one ? '#ffffff' : s.rank === o.rank ? C.pale : 'rgba(111,179,224,0.35)'}`,
            boxShadow: glow ? `0 0 ${18 + 14 * glow}px rgba(255,255,255,${glow})` : '0 8px 24px rgba(0,0,0,0.45)',
            transform: `scale(${0.6 + 0.4 * pop})`, opacity: Math.min(1, pop * 1.5) }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: amber ? '#1b1203' : C.muted }}>#{s.rank}</div>
            {filled ? (
              <div style={{ transform: `scale(${0.7 + 0.3 * fs})`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <Flag iso2={r!.iso2} height={44} />
                <div style={{ fontSize: 20, fontWeight: 800, color: amber ? '#1b1203' : C.pale }}>{r!.iso3}</div>
              </div>
            ) : (
              <div style={{ fontSize: one ? 58 : 46, fontWeight: 900, color: one ? '#ffffff' : C.pale, lineHeight: 1 }}>?</div>
            )}
          </div>
        );
      })}
    </>
  );
};

// The opening country's rank, big, while the camera is on it; then it flies into its slot.
const Badge: React.FC<{ p: ShortProps; hookEnd: number }> = ({ p, hookEnd }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = p.opening!;
  const r = p.ranking.find((x) => x.iso3 === o.iso);
  const slot = boxes(p).find((s) => s.rank === o.rank);
  if (!r || !slot || frame > hookEnd + 6) return null;
  const inn = spring({ frame: frame + 5, fps, config: { damping: 12, stiffness: 200 } });
  const fly = interpolate(frame, [hookEnd - 6, hookEnd + 6], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const x = interpolate(fly, [0, 1], [W / 2, slot.x + slot.w / 2]);
  const y = interpolate(fly, [0, 1], [BADGE_Y, STRIP.top + STRIP.h / 2]);
  const scale = interpolate(fly, [0, 1], [1, 0.24]) * (1.3 - 0.3 * inn);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 'max-content', transform: `translate(-50%, -50%) scale(${scale})`, display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '18px 40px 22px', borderRadius: 30, background: 'rgba(6,19,29,0.86)', boxShadow: '0 16px 50px rgba(0,0,0,0.55)', opacity: Math.min(1, inn * 1.4) * (1 - fly * 0.5) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
        <Flag iso2={r.iso2} height={96} style={{ boxShadow: '0 0 0 3px rgba(255,255,255,0.9), 0 12px 40px rgba(0,0,0,0.6)' }} />
        <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 220, lineHeight: 0.9, letterSpacing: -8, color: '#ffffff' }}>#{r.rank}</div>
      </div>
      <div style={{ marginTop: 8, maxWidth: 860, textAlign: 'center', fontFamily: FONT, fontWeight: 800, fontSize: 32, lineHeight: 1.15, letterSpacing: 3,
        textTransform: 'uppercase', color: C.blue }}>{o.label}</div>
    </div>
  );
};

export const RankStripOpening: React.FC<{ p: ShortProps }> = ({ p }) => {
  const hookEnd = p.beats[1]?.start ?? 60;
  return (
    <>
      <HookWords beat={p.beats[0]} until={hookEnd} />
      <Strip p={p} />
      <Badge p={p} hookEnd={hookEnd} />
    </>
  );
};
