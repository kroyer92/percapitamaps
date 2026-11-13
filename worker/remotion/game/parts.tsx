// The small pieces of the game video: captions, cards, the timer, the point badge, the round
// markers. Layout: the map on the left (GameMap's box), one panel on the right, captions below.
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../theme';
import { Flag } from '../components/Flag';
import { LM } from '../components/GameMap';
import type { GameCaption } from '../game-types';
import type { CaptionWord } from '../types';

export const LW = 1920;
export const LH = 1080;
export const PX = 1320; // the right panel
export const PW = 560;
export const PY = 120;
export const CARD = 'rgba(10,29,43,0.78)';
export const LINE = 'rgba(111,179,224,0.28)';
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const fade = (frame: number, at: number, d = 8) => interpolate(frame, [at, at + d], [0, 1], clamp);

// The font size at which one line of text fits a width. Titles and country names come from the
// data, so no size can be fixed by hand. Inter's heavy capitals and digits are wider than its
// lower case; `spacing` is letter-spacing in pixels.
export function fit(text: string, size: number, width: number, spacing = 0): number {
  const wide = (text.match(/[A-Z0-9#$%×?]/g) ?? []).length;
  const narrow = (text.match(/[\s.,:;'’·|!ilI1-]/g) ?? []).length;
  const em = wide * 0.7 + narrow * 0.32 + (text.length - wide - narrow) * 0.58;
  return Math.max(12, Math.min(size, Math.floor((width - text.length * spacing) / Math.max(1, em))));
}

export const Bg: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(110% 90% at 40% 45%, ${C.bg} 0%, ${C.bgDeep} 100%)` }}>
    <svg width={LW} height={LH} style={{ position: 'absolute', inset: 0 }}>
      {Array.from({ length: 22 }, (_, i) => <line key={`v${i}`} x1={i * 90 + 45} y1={0} x2={i * 90 + 45} y2={LH} stroke={C.grid} />)}
      {Array.from({ length: 12 }, (_, i) => <line key={`h${i}`} x1={0} y1={i * 90 + 30} x2={LW} y2={i * 90 + 30} stroke={C.grid} />)}
    </svg>
  </AbsoluteFill>
);

// Karaoke captions along the bottom, as in the classic long-form: one page, one lit word.
export const Captions: React.FC<{ lines: GameCaption[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  let line: GameCaption | undefined;
  for (const l of lines) { if (l.start - 4 <= frame) line = l; else break; }
  if (!line || !line.words.length || frame > line.end + 8) return null;
  // A page ends at a full stop or question mark, or after 9 words.
  const pages: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  for (const w of line.words) {
    cur.push(w);
    if (cur.length >= 9 || /[.?!]$/.test(w.text)) { pages.push(cur); cur = []; }
  }
  if (cur.length) pages.push(cur);
  const page = [...pages].reverse().find((pg) => pg[0].start - 3 <= frame) ?? pages[0];
  let lit = -1;
  page.forEach((w, i) => { if (w.start <= frame) lit = i; });
  if (lit >= 0 && frame > page[lit].end + 6) lit = -1;
  const text = page.map((w) => w.text).join(' ');
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: 958, height: 72, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ background: 'rgba(10,29,43,0.82)', borderRadius: 14, padding: '8px 22px', fontFamily: FONT, fontSize: fit(text, 38, 1700), fontWeight: 800, color: C.pale, whiteSpace: 'nowrap' }}>
        {page.map((w, i) => <span key={i} style={{ color: i === lit ? C.blue : C.pale }}>{w.text}{i < page.length - 1 ? ' ' : ''}</span>)}
      </div>
    </div>
  );
};

export const Pop: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties; from?: 'right' | 'below' | 'scale' }> = ({ at, children, style, from = 'right' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!(frame >= at)) return null;
  const s = spring({ frame: frame - at, fps, config: { damping: 15 } });
  const transform = from === 'right' ? `translateX(${(1 - s) * 36}px)` : from === 'below' ? `translateY(${(1 - s) * 26}px)` : `scale(${0.7 + 0.3 * s})`;
  return <div style={{ opacity: Math.min(1, s * 1.4), transform, ...style }}>{children}</div>;
};

export const PanelTitle: React.FC<{ children: string }> = ({ children }) => (
  <div style={{ fontFamily: FONT, fontSize: fit(children, 24, PW, 3), fontWeight: 800, letterSpacing: 3, color: C.blue, marginBottom: 14, whiteSpace: 'nowrap', height: 30, lineHeight: '30px' }}>{children}</div>
);

// A panel on the right that shows between two frames and fades in.
export const Panel: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  return <div style={{ position: 'absolute', left: PX, top: PY, width: PW, opacity: fade(frame, from, 7), fontFamily: FONT, color: C.pale }}>{children}</div>;
};

export const Timer: React.FC<{ from: number; frames: number; label: string }> = ({ from, frames, label }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame >= from + frames) return null;
  const left = 1 - (frame - from) / frames;
  const n = Math.ceil((from + frames - frame) / fps - 1e-6);
  const kick = interpolate((frame - from) % fps, [0, 5], [1.14, 1], clamp); // a small kick on every second
  const R = 72;
  const len = 2 * Math.PI * R;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 28, opacity: fade(frame, from, 5) }}>
      <svg width={180} height={180} viewBox="-90 -90 180 180" style={{ flexShrink: 0 }}>
        <circle r={R} fill="rgba(10,29,43,0.8)" stroke="rgba(111,179,224,0.22)" strokeWidth={14} />
        <circle r={R} fill="none" stroke={C.amber} strokeWidth={14} strokeLinecap="round" strokeDasharray={`${len * left} ${len}`} transform="rotate(-90)" />
        <text y={30} textAnchor="middle" fontFamily={FONT} fontSize={86} fontWeight={900} fill={C.pale} transform={`scale(${kick})`}>{n}</text>
      </svg>
      <div>
        <div style={{ fontSize: 40, fontWeight: 900, color: C.amber, lineHeight: 1.05, whiteSpace: 'nowrap' }}>GUESS NOW</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.muted, marginTop: 6, whiteSpace: 'nowrap' }}>{label}</div>
      </div>
    </div>
  );
};

// The point for this round: pops when the voice says it and stays until the round ends.
export const PlusOne: React.FC<{ at: number; lines: [string, string] }> = ({ at, lines }) => {
  const size = Math.min(fit(lines[0], 32, 330), fit(lines[1], 32, 330));
  return (
    <Pop at={at} from="scale" style={{ position: 'absolute', left: PX, top: 776, transformOrigin: 'left center', display: 'flex', alignItems: 'center', gap: 22, fontFamily: FONT,
      background: 'rgba(10,29,43,0.9)', border: `3px solid ${C.amber}`, borderRadius: 20, padding: '10px 26px 10px 20px', boxShadow: '0 0 40px rgba(240,176,74,0.25)' }}>
      <div style={{ fontSize: 104, fontWeight: 900, color: C.amber, lineHeight: 1 }}>+1</div>
      <div style={{ fontSize: size, fontWeight: 800, color: C.pale, lineHeight: 1.18, whiteSpace: 'nowrap' }}>{lines[0]}<br />{lines[1]}</div>
    </Pop>
  );
};

// One marker per round across the top right: done (amber tick), now (bright ring), still to come.
export const Rounds: React.FC<{ total: number; current: number; doneAt: number[] }> = ({ total, current, doneAt }) => {
  const frame = useCurrentFrame();
  const d = total > 10 ? 36 : 40;
  return (
    <div style={{ position: 'absolute', right: 40, top: 44, display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT }}>
      {Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const done = frame >= doneAt[i];
        const on = n === current;
        return (
          <div key={n} style={{ width: d, height: d, borderRadius: d / 2, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 900,
            background: done ? C.amber : 'rgba(10,29,43,0.8)', color: done ? C.bgDeep : on ? C.pale : C.muted, border: `3px solid ${done ? C.amber : on ? C.pale : 'rgba(143,176,196,0.4)'}` }}>
            {done ? '✓' : n}
          </div>
        );
      })}
    </div>
  );
};

export const Header: React.FC<{ tag: string; title: string; year: string; from: number }> = ({ tag, title, year, from }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: 60, top: 18, width: 1200, fontFamily: FONT, opacity: fade(frame, from, 8) }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: C.blue, letterSpacing: 3, whiteSpace: 'nowrap', lineHeight: '30px' }}>{tag}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, height: 60 }}>
        <div style={{ fontSize: fit(title, 46, 1180 - year.length * 16), fontWeight: 900, color: C.pale, whiteSpace: 'nowrap', lineHeight: '60px' }}>{title}</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap' }}>{year}</div>
      </div>
    </div>
  );
};

// "ROUND 3" lands big over the map for under a second, instead of a title card that holds for three.
export const Stinger: React.FC<{ at: number; big: string; small: string }> = ({ at, big, small }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at || frame > at + 30) return null;
  const s = spring({ frame: frame - at, fps, config: { damping: 13 } });
  const out = interpolate(frame, [at + 20, at + 30], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: FONT, opacity: out, background: 'rgba(10,29,43,0.82)' }}>
      <div style={{ fontSize: 190, fontWeight: 900, color: C.pale, lineHeight: 1, transform: `scale(${1.35 - 0.35 * s})`, whiteSpace: 'nowrap' }}>{big}</div>
      <div style={{ fontSize: 54, fontWeight: 900, color: C.amber, letterSpacing: 6, marginTop: 14, whiteSpace: 'nowrap' }}>{small}</div>
    </AbsoluteFill>
  );
};

// The map's key, bottom left of the map.
export const Key: React.FC<{ from: number; children: React.ReactNode }> = ({ from, children }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: LM.x + 24, top: LM.y + LM.h - 64, opacity: fade(frame, from), display: 'flex', alignItems: 'center', gap: 12,
      background: 'rgba(10,29,43,0.85)', borderRadius: 12, padding: '8px 18px', fontFamily: FONT, fontSize: 22, fontWeight: 700, color: C.pale, whiteSpace: 'nowrap' }}>{children}</div>
  );
};
export const Ramp: React.FC = () => <span style={{ width: 120, height: 16, borderRadius: 5, background: `linear-gradient(90deg, ${C.blues[0]}, ${C.blues[2]}, ${C.blues[5]})` }} />;
export const Swatch: React.FC = () => <span style={{ width: 22, height: 16, borderRadius: 5, background: C.amber }} />;
export const LessMore: React.FC<{ unit: string }> = ({ unit }) => (
  <><span>Less</span><Ramp /><span>More</span><span style={{ opacity: 0.7, fontWeight: 500 }}>{unit}</span></>
);

// A choice: a row with a flag (pick the #1) or a big tile (a number, higher/lower). `room`: the
// width a big tile has for its text.
export const Option: React.FC<{ letter: string; label: string; iso2?: string; state: 'open' | 'right' | 'wrong'; big?: boolean; room?: number }> = ({ letter, label, iso2, state, big, room = 96 }) => {
  // A long country name takes two lines rather than shrinking until it is hard to read.
  const size = big ? fit(label, 62, room) : fit(label, 38, iso2 ? 350 : 420);
  const wrap = !big && size < 30;
  return (
  <div style={{ height: big ? 124 : 92, borderRadius: 16, display: 'flex', alignItems: 'center', gap: big ? 12 : 18, padding: big ? '0 14px' : '0 20px', flex: big ? 1 : undefined, minWidth: 0, boxSizing: 'border-box',
    background: state === 'right' ? C.amber : CARD, border: `3px solid ${state === 'right' ? C.amber : LINE}`, color: state === 'right' ? C.bgDeep : C.pale,
    opacity: state === 'wrong' ? 0.32 : 1, boxShadow: state === 'right' ? '0 0 46px rgba(240,176,74,0.5)' : 'none' }}>
    <div style={{ width: big ? 44 : 52, height: big ? 44 : 52, borderRadius: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: big ? 24 : 28, fontWeight: 900,
      background: state === 'right' ? C.bgDeep : 'rgba(111,179,224,0.16)', color: state === 'right' ? C.amber : C.blue }}>{letter}</div>
    {iso2 && <Flag iso2={iso2} height={40} style={{ flexShrink: 0 }} />}
    <div style={{ fontSize: wrap ? 30 : size, fontWeight: 900, whiteSpace: wrap ? 'normal' : 'nowrap', lineHeight: 1.05 }}>{label}</div>
  </div>
  );
};

// One of the viewer's own countries: a big value and a small line under it.
export const Chip: React.FC<{ iso2?: string; name: string; main: string; sub: string }> = ({ iso2, name, main, sub }) => (
  <div style={{ height: 164, borderRadius: 16, background: CARD, border: `2px solid ${LINE}`, padding: '14px 16px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Flag iso2={iso2} height={28} style={{ flexShrink: 0 }} />
      <div style={{ fontSize: fit(name, 22, 180), fontWeight: 800, color: C.pale, whiteSpace: 'nowrap' }}>{name}</div>
    </div>
    <div style={{ fontSize: fit(main, 54, 236), fontWeight: 900, color: C.pale, whiteSpace: 'nowrap', lineHeight: 1 }}>{main}</div>
    <div style={{ fontSize: fit(sub, 23, 236), fontWeight: 700, color: C.blue, whiteSpace: 'nowrap', lineHeight: 1 }}>{sub}</div>
  </div>
);

// A row of a ranking: "#2 [flag] Ireland ... $103,685". `hot`: the amber row (the #1).
export const RankRow: React.FC<{ rank: number; iso2?: string; name: string; display: string; at: number; hot?: boolean; height?: number }> = ({ rank, iso2, name, display, at, hot, height = 84 }) => {
  const frame = useCurrentFrame();
  const on = hot && frame >= at;
  const size = fit(name, 32, 290 - display.length * 14);
  const wrap = size < 24; // a long name takes two lines
  return (
    <div style={{ height, marginBottom: 10, borderRadius: 14, display: 'flex', alignItems: 'center', gap: 14, padding: '0 18px', boxSizing: 'border-box',
      background: on ? C.amber : CARD, border: `2px solid ${on ? C.amber : LINE}`, color: on ? C.bgDeep : C.pale }}>
      <div style={{ width: 56, fontSize: 30, fontWeight: 900, flexShrink: 0 }}>#{rank}</div>
      <Pop at={at} style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
        <Flag iso2={iso2} height={34} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, fontSize: wrap ? 24 : size, fontWeight: 900, whiteSpace: wrap ? 'normal' : 'nowrap', lineHeight: 1.05 }}>{name}</div>
        <div style={{ fontSize: 27, fontWeight: 700, whiteSpace: 'nowrap' }}>{display}</div>
      </Pop>
    </div>
  );
};

// A big card with a label, a flag and a value ("HIGHEST · Hong Kong / 85.2 years").
export const BigCard: React.FC<{ label: string; value: string; iso2?: string; hot?: boolean; mystery?: boolean }> = ({ label, value, iso2, hot, mystery }) => (
  <div style={{ height: 150, marginBottom: 16, borderRadius: 18, background: hot ? C.amber : CARD, border: `2px solid ${hot ? C.amber : LINE}`, color: hot ? C.bgDeep : C.pale,
    display: 'flex', alignItems: 'center', gap: 22, padding: '0 24px', boxSizing: 'border-box' }}>
    {mystery
      ? <div style={{ width: 92, height: 92, flexShrink: 0, borderRadius: 16, border: `3px dashed ${C.amber}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 62, fontWeight: 900, color: C.amber }}>?</div>
      : <Flag iso2={iso2} height={70} style={{ flexShrink: 0 }} />}
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: fit(label, 24, mystery ? 370 : 360, 3), fontWeight: 800, letterSpacing: 3, opacity: hot ? 0.75 : 1, color: hot ? C.bgDeep : C.muted, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: fit(value, 62, mystery ? 380 : 370), fontWeight: 900, lineHeight: 1.05, whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  </div>
);

// A number that runs up to its value over `frames`.
export function countUp(frame: number, at: number, to: number, frames: number): number {
  return Math.round(interpolate(frame, [at, at + frames], [0, to], clamp));
}
