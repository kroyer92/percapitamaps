import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Flag } from '../components/Flag';
import { C, FONT, SAFE, W, ZONE } from '../theme';
import type { ShortProps } from '../types';

const GROUP_COLORS = [C.amber, C.blue, '#8fd0a8', '#e58f7a', '#b9a2e8', '#3d6a86'];

export const Scale: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const groups = p.scale!.groups;
  // Each scale_grid beat (after the first) lights up the next group; the rest stay grey until the end.
  const lightBeats = p.beats.filter((b) => b.visual.startsWith('scale_grid') || b.visual.startsWith('highlight'));
  // A group lights on the beat that names it on screen (two countries with the same count share
  // one beat); otherwise on the next scale_grid beat in order.
  const starts = groups.map((g, i) => p.beats.find((b) => b.on_screen.split(/[:+]/).some((x) => x.trim() === g.name))?.start
    ?? lightBeats[i + 1]?.start ?? lightBeats[lightBeats.length - 1]?.start ?? 0);
  const people: { g: number }[] = [];
  groups.forEach((g, gi) => { for (let k = 0; k < g.people; k++) people.push({ g: gi }); });
  const cell = 56;
  const gridLeft = (W - cell * 10) / 2;
  const gridTop = ZONE.visualTop + 10;
  const lit = (gi: number) => frame >= starts[gi];
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <svg width={W} height={1920} style={{ position: 'absolute', inset: 0 }}>
        {people.map((pp, i) => {
          const x = gridLeft + (i % 10) * cell + cell / 2;
          const y = gridTop + Math.floor(i / 10) * cell + cell / 2;
          const on = lit(pp.g);
          const s = on ? spring({ frame: frame - starts[pp.g] - (i % 10), fps, config: { damping: 14 } }) : 0;
          const color = on ? GROUP_COLORS[pp.g % GROUP_COLORS.length] : '#2a4a60';
          return (
            <g key={i} transform={`translate(${x},${y}) scale(${(0.85 + s * 0.15) * 0.85})`}>
              <circle cx={0} cy={-13} r={9} fill={color} />
              <path d="M-14 22 Q-14 -2 0 -2 Q14 -2 14 22 Z" fill={color} />
            </g>
          );
        })}
      </svg>
      <div style={{ position: 'absolute', top: gridTop + cell * 10 + 10, left: SAFE.left, right: W - SAFE.right, display: 'flex', flexWrap: 'wrap', gap: '6px 22px', justifyContent: 'center' }}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: lit(gi) ? 1 : 0.35, fontFamily: FONT, fontSize: 28, fontWeight: 700, color: C.pale }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, background: GROUP_COLORS[gi % GROUP_COLORS.length] }} />
            {g.iso2 && <Flag iso2={g.iso2} height={22} />}
            {g.name} {lit(gi) ? g.people : ''}
          </div>
        ))}
      </div>
    </div>
  );
};
