import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import { Flag } from '../components/Flag';
import { CountryShape, FULL_VIEW, WorldMap, countUp, mapCues, type MapView } from '../components/WorldMap';
import { C, FONT, W, ZONE } from '../theme';
import type { ShortProps } from '../types';

const SIDE = 34;
const GAP = 18;
const CARD_W = (W - SIDE * 2 - GAP * 2) / 3;
const CARD_H = 540;
const CARD_TOP = ZONE.visualTop + 10;
const UNDER = CARD_TOP + CARD_H + 30; // timer, then the "off by" line
// On the map ending the camera stays wide enough to show #2 together with its neighbours.
const ENDING: MapView = { ...FULL_VIEW, box: { w: W * 0.3, h: 300 } };

export const Guess: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const g = p.guess!;
  const pause = p.beats.find((b) => b.visual.startsWith('pause'));
  const reveal = p.beats.find((b) => b.visual.startsWith('reveal_answer'))?.start ?? Math.round(p.durationInFrames * 0.65);
  // After the answer, the video moves to the map: where the answer is, and who came second.
  const mapFrom = p.beats.find((b) => b.start > reveal)?.start ?? Infinity;
  const mapIn = interpolate(frame, [mapFrom, mapFrom + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const byIso = new Map(p.ranking.map((r) => [r.iso3, r]));
  const answer = g.options.find((o) => o.letter === g.answer);
  const answerValue = answer ? byIso.get(answer.iso3)?.value : undefined;
  const revealed = frame >= reveal;
  const rs = revealed ? spring({ frame: frame - reveal, fps, config: { damping: 11 } }) : 0;
  const count = interpolate(frame, [reveal + 4, reveal + 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });

  // The wrong option furthest from the answer: "Picked B? Off by 2.03".
  const misses = g.options
    .filter((o) => o !== answer && byIso.has(o.iso3))
    .map((o) => ({ o, gap: Math.abs((answerValue ?? 0) - byIso.get(o.iso3)!.value) }))
    .sort((a, b) => b.gap - a.gap);
  const miss = answer && answerValue ? misses[0] : undefined;
  const offBy = miss ? countUp(answer!.display, miss.gap / answerValue!) : undefined;

  const inPause = pause && frame >= pause.start && frame < reveal;
  const left = pause ? interpolate(frame, [pause.start, reveal], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
  const digit = Math.max(1, Math.min(3, Math.ceil((reveal - frame) / fps)));
  const digitPop = spring({ frame: frame - (reveal - digit * fps), fps, config: { damping: 12 } });

  return (
    <>
      {mapIn > 0 && (
        <div style={{ position: 'absolute', inset: 0, opacity: mapIn }}>
          <WorldMap map={p.map} cues={mapCues(p.beats, p.highlightIso)} unit={p.unit} answerIso={p.highlightIso}
            labelFor={(iso) => { const r = byIso.get(iso); return r ? `#${r.rank} ${r.name} · ${r.display}` : undefined; }} view={ENDING} />
        </div>
      )}
      {mapIn < 1 && (
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - mapIn }}>
          <div style={{ position: 'absolute', top: CARD_TOP, left: SIDE, right: SIDE, display: 'flex', gap: GAP }}>
            {g.options.map((o, i) => {
              // On screen from the first frame, each popping in a beat after the other.
              const inn = spring({ frame: frame - i * 4, fps, config: { damping: 14, stiffness: 200 } });
              const isAnswer = o === answer;
              const won = isAnswer && revealed;
              const lost = !isAnswer && revealed;
              const wobble = inPause ? 0.025 * Math.sin((frame / fps) * Math.PI * 2 + i * 2) : 0;
              const scale = (0.9 + 0.1 * inn) * (won ? 1 + 0.06 * rs : 1 + wobble);
              const value = byIso.get(o.iso3)?.display ?? o.display;
              return (
                <div key={o.letter} style={{ width: CARD_W, height: CARD_H, borderRadius: 26, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '18px 10px', boxSizing: 'border-box', gap: 8, fontFamily: FONT,
                  background: won ? 'rgba(240,176,74,0.16)' : 'rgba(6,19,29,0.86)', border: `3px solid ${won ? C.amber : 'rgba(111,179,224,0.35)'}`,
                  transform: `scale(${scale})`, opacity: lost ? 1 - 0.5 * rs : 1, boxShadow: '0 14px 40px rgba(0,0,0,0.4)' }}>
                  <div style={{ fontSize: 60, fontWeight: 900, color: won ? C.amber : C.pale, lineHeight: 1.1 }}>{o.letter}</div>
                  <CountryShape iso={o.iso3} w={CARD_W - 40} h={250} color={won ? C.amber : lost ? C.muted : C.blues[4]} stroke={won ? '#ffffff' : undefined} />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap', textAlign: 'center', minHeight: 84 }}>
                    <Flag iso2={o.iso2} height={30} />
                    <span style={{ fontSize: o.name.length > 13 ? 26 : 32, fontWeight: 800, color: C.pale }}>{o.name}</span>
                  </div>
                  {revealed && (
                    <div style={{ fontSize: won ? 64 : 40, fontWeight: 900, color: won ? C.amber : C.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {won ? countUp(value, count) : value}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {inPause && (
            <>
              <div style={{ position: 'absolute', left: 120, right: 120, top: UNDER, height: 20, borderRadius: 10, background: 'rgba(111,179,224,0.2)' }}>
                <div style={{ width: `${left * 100}%`, height: '100%', borderRadius: 10, background: C.blue }} />
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, top: UNDER + 26, textAlign: 'center', fontFamily: FONT, fontSize: 90, lineHeight: 1,
                fontWeight: 900, color: C.pale, transform: `scale(${0.8 + 0.2 * digitPop})`, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>{digit}</div>
            </>
          )}
          {miss && revealed && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: UNDER + 10, textAlign: 'center', fontFamily: FONT, fontSize: 44, fontWeight: 800, color: C.pale,
              opacity: interpolate(frame, [reveal + 24, reveal + 34], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
              Picked {miss.o.letter}? Off by {offBy}
            </div>
          )}
        </div>
      )}
    </>
  );
};
