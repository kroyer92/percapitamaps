import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Flag } from '../components/Flag';
import { C, FONT, SAFE, W, ZONE } from '../theme';
import type { ShortProps } from '../types';

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

// Frame where the voice first says this country's name (first two words of it), or -1.
function spokenAt(p: ShortProps, name: string, before: number): number {
  const want = tokens(name).filter((t) => t !== 'the').slice(0, 2);
  if (!want.length) return -1;
  const words = p.beats.flatMap((b) => b.words.flatMap((w) => tokens(w.text).map((t) => ({ t, start: w.start }))));
  for (let i = 0; i + want.length <= words.length; i++) {
    if (words[i].start >= before) break;
    if (want.every((t, j) => words[i + j].t === t)) return words[i].start;
  }
  return -1;
}

// Ranks 10 to 1 appear as the voice names them; #1 lands on the reveal beat.
// A rank that is never named falls back to even spacing.
export function countdownSchedule(p: ShortProps): number[] {
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'))?.start ?? Math.round(p.durationInFrames * 0.7);
  const first = p.beats[1]?.start ?? 30;
  const n = Math.min(10, p.ranking.length);
  const byRank = [...p.ranking.slice(0, n)].sort((a, b) => b.rank - a.rank); // #n ... #1
  const times: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const even = Math.round(first + ((reveal - 15 - first) * i) / Math.max(1, n - 2));
    const said = spokenAt(p, byRank[i].name, reveal);
    times.push(said >= 0 ? said : even);
  }
  times.push(reveal);
  return times; // times[0] reveals #10 (or #n), last reveals #1
}

export const Countdown: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rows = p.ranking.slice(0, 10);
  const times = countdownSchedule(p);
  const max = Math.max(...rows.map((r) => r.value));
  const top = ZONE.visualTop + 10;
  const rowH = (ZONE.visualBottom - top - 10) / rows.length;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {rows.map((r, i) => {
        const appear = times[rows.length - 1 - i];
        const s = spring({ frame: frame - appear, fps, config: { damping: 18 } });
        const shown = frame >= appear;
        const isOne = r.rank === 1;
        const barW = 360 * (r.value / max) * interpolate(s, [0, 1], [0, 1]);
        return (
          <div key={r.iso3} style={{ position: 'absolute', top: top + i * rowH, left: SAFE.left, width: W - SAFE.left * 2, height: rowH - 8,
            display: 'flex', alignItems: 'center', gap: 16, padding: '0 18px', borderRadius: 14,
            background: isOne && shown ? 'rgba(240,176,74,0.16)' : 'rgba(255,255,255,0.04)',
            border: isOne && shown ? `2px solid ${C.amber}` : '2px solid transparent',
            transform: `translateX(${shown ? (1 - s) * 60 : 0}px)`, opacity: shown ? 1 : 0.35 }}>
            <div style={{ width: 70, fontFamily: FONT, fontWeight: 800, fontSize: 40, color: isOne ? C.amber : C.blue }}>#{r.rank}</div>
            {shown ? <Flag iso2={r.iso2} height={40} /> : <div style={{ width: 60, height: 40, borderRadius: 4, background: 'rgba(255,255,255,0.1)' }} />}
            <div style={{ flex: 1, fontFamily: FONT, fontWeight: 700, fontSize: 36, color: C.pale, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {shown ? r.name : '?'}
            </div>
            {shown && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: barW, height: 18, borderRadius: 9, background: isOne ? C.amber : C.blue, opacity: 0.85 }} />
                <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 32, color: isOne ? C.amber : C.pale, minWidth: 120, textAlign: 'right' }}>{r.display}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
