import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Flag } from '../components/Flag';
import { C, FONT, SAFE, W, ZONE } from '../theme';
import type { ShortProps } from '../types';

export const Guess: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const g = p.guess!;
  const pause = p.beats.find((b) => b.visual.startsWith('pause'));
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'))?.start ?? Math.round(p.durationInFrames * 0.65);
  const showFrom = p.beats.find((b) => b.visual.startsWith('flag_row'))?.start ?? p.beats[1]?.start ?? 20;
  const revealed = frame >= reveal;
  const cardH = 170;
  const top = ZONE.visualTop + 30;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {g.options.map((o, i) => {
        const s = spring({ frame: frame - showFrom - i * 6, fps, config: { damping: 16 } });
        const isAnswer = o.letter === g.answer;
        const rs = revealed ? spring({ frame: frame - reveal, fps, config: { damping: 12 } }) : 0;
        return (
          <div key={o.letter} style={{ position: 'absolute', top: top + i * (cardH + 26), left: SAFE.left + 20, width: W - (SAFE.left + 20) * 2, height: cardH,
            display: 'flex', alignItems: 'center', gap: 26, padding: '0 30px', borderRadius: 24,
            background: revealed && isAnswer ? 'rgba(240,176,74,0.2)' : 'rgba(255,255,255,0.06)',
            border: `3px solid ${revealed && isAnswer ? C.amber : 'rgba(111,179,224,0.35)'}`,
            opacity: frame < showFrom ? 0 : (revealed && !isAnswer ? 0.45 : 1) * s,
            transform: `scale(${revealed && isAnswer ? 1 + rs * 0.04 : 0.96 + s * 0.04})` }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 64, color: C.amber, width: 60 }}>{o.letter}</div>
            <Flag iso2={o.iso2} height={70} />
            <div style={{ flex: 1, fontFamily: FONT, fontWeight: 800, fontSize: 52, color: C.pale }}>{o.name}</div>
            {revealed && <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 40, color: isAnswer ? C.amber : C.muted }}>{o.display}</div>}
          </div>
        );
      })}
      {pause && frame >= pause.start && frame < reveal && (
        <div style={{ position: 'absolute', top: top + 3 * (cardH + 26) + 10, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <svg width={150} height={150}>
            <circle cx={75} cy={75} r={60} stroke="rgba(111,179,224,0.25)" strokeWidth={12} fill="none" />
            <circle cx={75} cy={75} r={60} stroke={C.amber} strokeWidth={12} fill="none" strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 60}
              strokeDashoffset={2 * Math.PI * 60 * interpolate(frame, [pause.start, reveal], [0, 1], { extrapolateRight: 'clamp' })}
              transform="rotate(-90 75 75)" />
            <text x={75} y={92} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={48} fill={C.pale}>
              {Math.max(1, Math.ceil((reveal - frame) / fps))}
            </text>
          </svg>
        </div>
      )}
    </div>
  );
};
