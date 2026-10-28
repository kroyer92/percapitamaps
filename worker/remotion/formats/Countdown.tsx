import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Flag } from '../components/Flag';
import { AnswerNumber, WorldMap, mapCues, type MapView } from '../components/WorldMap';
import { currentBeat } from '../components/Chrome';
import { C, FONT, W } from '../theme';
import type { RankItem, ShortProps, TimedBeat } from '../types';
import { countdownSchedule } from '../schedule';

// Split screen: the map in a band under the headline, the ladder below it, captions under that.
const BAND: MapView = { centreY: 752, bottom: 925, box: { w: W * 0.48, h: 290 }, revealBox: { w: W * 0.55, h: 150 }, revealDrop: 95, shiftX: 170, homeK: 1.6, homeDy: 30 };
const LADDER_TOP = 935;
const ROW_H = 46;
const ONE_H = 60;
const GAP = 6;
const SIDE = 40;

// Scripts written before the split layout used bar_add:ISO for each row; on the map that is a highlight.
const asMapBeats = (beats: TimedBeat[]) => beats.map((b) => (b.visual.startsWith('bar_add:') ? { ...b, visual: b.visual.replace('bar_add:', 'highlight:') } : b));

const Row: React.FC<{ r: RankItem; max: number; at: number; amber?: boolean; big?: boolean; outline?: boolean; hidden?: string }> = ({ r, max, at, amber, big, outline, hidden }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shown = frame >= at;
  const s = shown ? spring({ frame: frame - at, fps, config: { damping: 16 } }) : 0;
  const ink = amber ? '#1b1203' : C.pale;
  return (
    <div style={{ height: big ? ONE_H : ROW_H, display: 'flex', alignItems: 'center', gap: 14, padding: '0 18px', borderRadius: 14,
      background: amber ? C.amber : 'rgba(6,19,29,0.88)',
      border: `${outline ? 3 : 2}px solid ${amber ? C.amber : outline ? '#ffffff' : big ? 'rgba(217,236,247,0.6)' : 'rgba(111,179,224,0.25)'}`,
      fontFamily: FONT, fontWeight: 800, fontSize: big ? 40 : 30, color: ink, transform: `scale(${amber ? 1 + 0.04 * Math.sin(Math.min(1, s) * Math.PI) : 1})` }}>
      <span style={{ width: 76, opacity: 0.85 }}>#{r.rank}</span>
      {shown ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, opacity: s, transform: `translateX(${(1 - s) * 40}px)` }}>
          <Flag iso2={r.iso2} height={big ? 36 : 28} />
          <span style={{ width: 330, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
          <span style={{ flex: 1, display: 'flex' }}>
            <span style={{ width: `${Math.max(3, 100 * (r.value / max)) * s}%`, height: 16, borderRadius: 8, background: amber ? '#1b1203' : C.blue, opacity: 0.85 }} />
          </span>
          <span style={{ minWidth: 110, textAlign: 'right', whiteSpace: 'nowrap' }}>{r.display}</span>
        </div>
      ) : (
        <span style={{ letterSpacing: 8, opacity: 0.85 }}>{hidden}</span>
      )}
    </div>
  );
};

export const Countdown: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beats = asMapBeats(p.beats);
  const rows = p.ranking.filter((r) => r.rank <= 10).sort((a, b) => a.rank - b.rank);
  const n = rows.length;
  const times = countdownSchedule(p); // times[0] is #n, the last is #1
  const at = (rank: number) => times[n - rank] ?? Infinity;
  const max = Math.max(...rows.map((r) => r.value));
  const cues = mapCues(beats, p.highlightIso);
  const reveal = cues.find((c) => c.kind === 'reveal');
  const afterReveal = reveal ? beats.find((b) => b.start > reveal.start)?.start : undefined;
  const top = rows[0];
  const byIso = new Map(p.ranking.map((r) => [r.iso3, r]));

  // The viewer's likely guess (a big country far down the list) gets a pinned row of its own.
  const guessBeat = beats.find((b) => b.visual.startsWith('zoom_to:'));
  const guess = guessBeat ? byIso.get(guessBeat.visual.split(':')[1].toUpperCase()) : undefined;
  const youRow = guess && guess.rank > 5 ? guess : undefined;

  // While the camera is on a country, its number stands next to it (its rank, for the guess).
  const { beat } = currentBeat(beats, frame);
  const [kind, arg] = beat.visual.split(':');
  const focus = (kind === 'zoom_to' || kind === 'highlight') && arg ? byIso.get(arg.toUpperCase()) : undefined;
  const pop = spring({ frame: frame - beat.start - 8, fps, config: { damping: 12 } });

  // #10 to #6 fold into one line; each name joins it as the voice says it.
  const low = rows.filter((r) => r.rank > 5).sort((a, b) => b.rank - a.rank);
  const lowNames = low.filter((r) => frame >= at(r.rank));
  const ladder = rows.filter((r) => r.rank <= 5);

  return (
    <>
      <WorldMap map={p.map} cues={cues} labelFor={() => undefined} unit={p.unit} answerIso={p.highlightIso} view={BAND} />
      {focus && frame < (reveal?.start ?? Infinity) && (
        <div style={{ position: 'absolute', right: 60, top: 600, textAlign: 'right', fontFamily: FONT, opacity: Math.min(1, pop * 1.5),
          transform: `scale(${0.8 + 0.2 * pop})`, transformOrigin: 'right top' }}>
          <div style={{ fontSize: 140, fontWeight: 900, letterSpacing: -5, lineHeight: 1, color: C.pale, textShadow: '0 10px 40px rgba(0,0,0,0.8)' }}>
            {focus === youRow ? `#${focus.rank}` : focus.display}
          </div>
          <div style={{ fontSize: 34, fontWeight: 800, color: C.pale, textShadow: '0 4px 20px rgba(0,0,0,0.9)', marginTop: 4 }}>
            {focus === youRow ? focus.display : `#${focus.rank}`}
          </div>
        </div>
      )}
      {reveal && top && <AnswerNumber display={top.display} start={reveal.start} end={afterReveal} top={585} maxSize={160} />}
      <div style={{ position: 'absolute', left: SIDE, right: SIDE, top: LADDER_TOP, display: 'flex', flexDirection: 'column', gap: GAP }}>
        {ladder.map((r) => (
          <Row key={r.iso3} r={r} max={max} at={at(r.rank)} big={r.rank === 1} amber={r.rank === 1 && frame >= at(1)} hidden={r.rank === 1 ? '? ? ?' : '· · ·'} />
        ))}
        {low.length > 0 && (
          <div style={{ height: 30, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', fontFamily: FONT, fontSize: 25, fontWeight: 700, color: C.muted,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span>#{low.at(-1)!.rank}–{low[0].rank}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {lowNames.length ? lowNames.map((r, i) => (
                <span key={r.iso3} style={{ color: i === lowNames.length - 1 && frame - at(r.rank) < 20 ? C.pale : C.muted }}>{i ? ' · ' : ''}{r.name}</span>
              )) : '· · ·'}
            </span>
          </div>
        )}
        {youRow && guessBeat && frame >= guessBeat.start && (
          <div style={{ opacity: interpolate(frame, [guessBeat.start, guessBeat.start + 8], [0, 1], { extrapolateRight: 'clamp' }) }}>
            <Row r={youRow} max={max} at={guessBeat.start} outline />
          </div>
        )}
      </div>
    </>
  );
};
