import React from 'react';
import { interpolate, useCurrentFrame, Easing } from 'remotion';
import { Flag } from '../components/Flag';
import { C, FONT, SAFE, W, ZONE } from '../theme';
import type { ShortProps } from '../types';

function fmt(v: number, s: NonNullable<ShortProps['series']>): string {
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1e9) body = `${(v / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) body = `${(v / 1e6).toFixed(1)}M`;
  else body = v.toLocaleString('en-US', { minimumFractionDigits: s.decimals, maximumFractionDigits: s.decimals });
  return `${s.prefix}${body}${s.suffix}`;
}

export const ThenNow: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const s = p.series!;
  const start = p.beats[1]?.start ?? 30;
  const end = (p.beats[p.beats.length - 2]?.start ?? p.durationInFrames - 60) + 20;
  const t = interpolate(frame, [start, end], [0, s.years.length - 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad) });
  const i0 = Math.floor(t);
  const i1 = Math.min(s.years.length - 1, i0 + 1);
  const f = t - i0;
  const year = Math.round(s.years[i0] + (s.years[i1] - s.years[i0]) * f);
  const vals = s.countries
    .map((c) => {
      const a = c.values[i0];
      const b = c.values[i1];
      const v = a === null ? b : b === null ? a : a + (b - a) * f;
      return { ...c, v };
    })
    .filter((c): c is typeof c & { v: number } => c.v !== null && c.v !== undefined)
    .sort((a, b) => b.v - a.v);
  const top = vals.slice(0, 8);
  const max = Math.max(...top.map((c) => c.v), 1e-9);
  const rowH = 70;
  const y0 = ZONE.visualTop + 120;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', top: ZONE.visualTop, left: 0, right: 0, textAlign: 'center', fontFamily: FONT, fontWeight: 800,
        fontSize: 110, color: 'rgba(240,176,74,0.9)', fontVariantNumeric: 'tabular-nums' }}>{year}</div>
      {top.map((c, i) => (
        <div key={c.iso3} style={{ position: 'absolute', top: y0 + i * (rowH + 6), left: SAFE.left, width: W - SAFE.left * 2, height: rowH,
          display: 'flex', alignItems: 'center', gap: 14 }}>
          <Flag iso2={c.iso2} height={40} />
          <div style={{ width: 250, fontFamily: FONT, fontWeight: 700, fontSize: 32, color: C.pale, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
          <div style={{ height: 40, width: Math.max(8, 440 * (c.v / max)), borderRadius: 8, background: i === 0 ? C.amber : C.blue }} />
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 30, color: i === 0 ? C.amber : C.pale }}>{fmt(c.v, s)}</div>
        </div>
      ))}
    </div>
  );
};
