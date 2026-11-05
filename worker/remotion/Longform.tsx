// The weekly long-form video (1920x1080): an intro, 8 to 10 maps, and a recap of every #1.
// Each map: title card, the world in blue, ranks 10 to 6, then 5 to 2 one by one, the #1 in
// amber, then the extra facts (an anchor country, ten years earlier, the bottom).
import React, { useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, Sequence, continueRender, delayRender, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import { C, FONT } from './theme';
import { Flag } from './components/Flag';
import { LandMap, LM, type LandCue } from './components/LandMap';
import type { LongBeat, LongformProps, LongSegment } from './longform-types';
import type { RankItem } from './types';

const LW = 1920;
const LH = 1080;
const LADDER = { x: 1320, y: 120, w: 560, row: 70 };

const Bg: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(110% 90% at 40% 45%, ${C.bg} 0%, ${C.bgDeep} 100%)` }}>
    <svg width={LW} height={LH} style={{ position: 'absolute', inset: 0 }}>
      {Array.from({ length: 22 }, (_, i) => <line key={`v${i}`} x1={i * 90 + 45} y1={0} x2={i * 90 + 45} y2={LH} stroke={C.grid} />)}
      {Array.from({ length: 12 }, (_, i) => <line key={`h${i}`} x1={0} y1={i * 90 + 30} x2={LW} y2={i * 90 + 30} stroke={C.grid} />)}
    </svg>
  </AbsoluteFill>
);

const fadeIn = (frame: number, at: number, d = 10) => interpolate(frame, [at, at + d], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

// Karaoke captions along the bottom: the current beat's words, a page of up to 9 at a time.
const Captions: React.FC<{ beats: LongBeat[]; offset: number }> = ({ beats, offset }) => {
  const frame = useCurrentFrame() + offset;
  const beat = [...beats].reverse().find((b) => b.start <= frame);
  if (!beat || !beat.words.length || frame > beat.end) return null;
  const pages: (typeof beat.words)[] = [];
  // A page ends at a full stop or question mark, or after 9 words, so a new sentence starts a new page.
  let cur: typeof beat.words = [];
  for (const w of beat.words) {
    cur.push(w);
    if (cur.length >= 9 || /[.?!]$/.test(w.text)) { pages.push(cur); cur = []; }
  }
  if (cur.length) pages.push(cur);
  const page = [...pages].reverse().find((p) => p[0].start <= frame) ?? pages[0];
  if (frame < page[0].start - 6) return null;
  // Exactly one word is lit: the last one the voice has started, until the next one starts (or a
  // moment after it ends, so a pause leaves nothing lit). Lighting every word whose time span
  // covered the frame, with a few frames of slack, lit two or three at once.
  let lit = -1;
  page.forEach((w, i) => { if (w.start <= frame) lit = i; });
  if (lit >= 0 && frame > page[lit].end + 6) lit = -1;
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: 958, height: 72, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ background: 'rgba(10,29,43,0.78)', borderRadius: 14, padding: '8px 22px', fontFamily: FONT, fontSize: 38, fontWeight: 800, color: C.pale, whiteSpace: 'nowrap' }}>
        {page.map((w, i) => (
          <span key={i} style={{ color: i === lit ? C.blue : C.pale }}>{w.text}{i < page.length - 1 ? ' ' : ''}</span>
        ))}
      </div>
    </div>
  );
};

const Footer: React.FC<{ source?: string; handle: string }> = ({ source, handle }) => (
  <>
    {source && <div style={{ position: 'absolute', left: 60, bottom: 14, fontFamily: FONT, fontSize: 20, fontWeight: 500, color: C.muted }}>{source}</div>}
    <div style={{ position: 'absolute', right: 60, bottom: 14, fontFamily: FONT, fontSize: 22, fontWeight: 700, color: C.blue }}>{handle}</div>
  </>
);

function cuesOf(beats: LongBeat[], start: number, answerIso?: string): LandCue[] {
  const cues: LandCue[] = [];
  for (const b of beats) {
    const [kind, arg] = b.visual.split(':');
    const s = b.start - start;
    if (kind === 'map_fill' || kind === 'ladder' || kind === 'title') cues.push({ kind: 'fill', start: s });
    else if (kind === 'highlight' || kind === 'fact' || kind === 'then') cues.push({ kind: 'focus', iso: arg, start: s });
    else if (kind === 'reveal_answer') cues.push({ kind: 'reveal', iso: answerIso, start: s });
    else if (kind === 'threshold') cues.push({ kind: 'threshold', start: s });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// When each ladder row appears (frames relative to the segment): 10 to 6 across the ladder beat,
// 5 to 2 when the voice names them, #1 at the reveal. The #1 row shows "?" until then.
function rowTimes(seg: LongSegment, beats: LongBeat[], start: number): Map<number, number> {
  const out = new Map<number, number>();
  const ladder = beats.find((b) => b.visual === 'ladder');
  const fill = beats.find((b) => b.visual === 'map_fill');
  const from = (ladder ?? fill)?.start ?? start;
  const to = ladder ? ladder.end : from + 30;
  const low = seg.top.filter((r) => r.rank >= 6).sort((a, b) => b.rank - a.rank);
  low.forEach((r, i) => {
    // Rows land when the voice says each name, else evenly through the beat.
    const word = ladder?.words.find((w) => r.name.toLowerCase().startsWith(w.text.toLowerCase().replace(/[^a-z]/g, '')) && w.text.length > 2);
    out.set(r.rank, (word ? word.start : from + ((to - from) * i) / Math.max(1, low.length)) - start);
  });
  for (const r of seg.top.filter((x) => x.rank >= 2 && x.rank <= 5)) {
    const b = beats.find((x) => x.visual === `highlight:${r.iso3}` && x.start >= from);
    out.set(r.rank, (b?.start ?? to) - start);
  }
  const reveal = beats.find((b) => b.visual === 'reveal_answer');
  out.set(1, (reveal?.start ?? to) - start);
  return out;
}

const Ladder: React.FC<{ seg: LongSegment; times: Map<number, number>; activeIso?: string; ladderFrom: number }> = ({ seg, times, activeIso, ladderFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = fadeIn(frame, ladderFrom, 12);
  return (
    <div style={{ position: 'absolute', left: LADDER.x, top: LADDER.y, width: LADDER.w, opacity: o }}>
      <div style={{ fontFamily: FONT, fontSize: 24, fontWeight: 800, letterSpacing: 3, color: C.blue, marginBottom: 12 }}>TOP 10</div>
      {seg.top.slice(0, 10).map((r) => {
        const at = times.get(r.rank) ?? Infinity;
        const shown = frame >= at;
        const s = spring({ frame: frame - at, fps, config: { damping: 18 } });
        const one = r.rank === 1;
        const active = shown && r.iso3 === activeIso;
        return (
          <div key={r.rank} style={{ height: LADDER.row - 8, marginBottom: 8, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px',
            background: one && shown ? C.amber : active ? 'rgba(217,236,247,0.18)' : 'rgba(10,29,43,0.72)',
            border: `2px solid ${active ? C.pale : one ? C.amber : 'rgba(111,179,224,0.25)'}`,
            fontFamily: FONT, color: one && shown ? C.bgDeep : C.pale }}>
            <div style={{ width: 54, fontSize: 28, fontWeight: 900, opacity: 0.9 }}>#{r.rank}</div>
            {shown ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, opacity: s, transform: `translateX(${(1 - s) * 30}px)` }}>
                <Flag iso2={r.iso2} height={30} />
                <div style={{ flex: 1, fontSize: 28, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                <div style={{ fontSize: 26, fontWeight: 700, whiteSpace: 'nowrap' }}>{r.display}</div>
              </div>
            ) : (
              <div style={{ fontSize: 28, fontWeight: 800, color: one ? C.amber : C.muted }}>{one ? '?' : ''}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const Segment: React.FC<{ seg: LongSegment; beats: LongBeat[]; start: number; count: number }> = ({ seg, beats, start, count }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cues = useMemo(() => cuesOf(beats, start, seg.top[0]?.iso3), [beats, start, seg]);
  const times = useMemo(() => rowTimes(seg, beats, start), [seg, beats, start]);
  const title = beats.find((b) => b.visual === 'title');
  const titleEnd = (title?.end ?? start) - start;
  const fillFrom = Math.max(0, titleEnd - 8);
  const ladderFrom = (beats.find((b) => b.visual === 'ladder' || b.visual === 'map_fill')?.start ?? start) - start;
  const abs = frame + start;
  const beat = [...beats].reverse().find((b) => b.start <= abs);
  const [kind, arg] = (beat?.visual ?? '').split(':');
  const activeIso = kind === 'highlight' || kind === 'fact' ? arg : kind === 'reveal_answer' ? seg.top[0]?.iso3 : undefined;
  const all: RankItem[] = [...seg.top, ...seg.extra];
  const factRow = kind === 'fact' ? all.find((r) => r.iso3 === arg) : undefined;
  const card = beat && ['fact', 'then', 'threshold', 'reveal_answer'].includes(kind) ? beat : undefined;
  const cardIn = card ? spring({ frame: abs - card.start, fps, config: { damping: 16 } }) : 0;
  const titleOut = interpolate(frame, [titleEnd - 10, titleEnd + 4], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const titleIn = spring({ frame, fps, config: { damping: 14 } });

  return (
    <AbsoluteFill>
      <LandMap map={seg.map} cues={cues} answerIso={seg.top[0]?.iso3} threshold={seg.threshold?.value} fillFrom={fillFrom} />
      {/* Header: which map, what it measures, which year. */}
      <div style={{ position: 'absolute', left: 60, top: 34, right: 640, fontFamily: FONT, display: 'flex', alignItems: 'baseline', gap: 18, opacity: 1 - titleOut }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.blue, letterSpacing: 3, whiteSpace: 'nowrap' }}>MAP {seg.n}/{count}</div>
        <div style={{ fontSize: 40, fontWeight: 900, color: C.pale, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{seg.title}</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap' }}>{seg.yearText}</div>
      </div>
      {/* Key under the map. */}
      <div style={{ position: 'absolute', left: LM.x + 24, top: LM.y + LM.h - 64, opacity: fadeIn(frame, fillFrom + 20), display: 'flex', alignItems: 'center', gap: 12,
        background: 'rgba(10,29,43,0.85)', borderRadius: 12, padding: '8px 18px', fontFamily: FONT, fontSize: 22, fontWeight: 700, color: C.pale }}>
        <span>Less</span>
        <span style={{ width: 120, height: 16, borderRadius: 5, background: `linear-gradient(90deg, ${C.blues[0]}, ${C.blues[2]}, ${C.blues[5]})` }} />
        <span>More</span>
        <span style={{ opacity: 0.7, fontWeight: 500 }}>{seg.unit}</span>
      </div>
      <Ladder seg={seg} times={times} activeIso={activeIso} ladderFrom={ladderFrom} />
      {/* The card over the map: the #1's number, a threshold count, or the country being named. */}
      {card && (
        <div style={{ position: 'absolute', left: LM.x + 24, top: LM.y + 24, maxWidth: LM.w - 48, opacity: cardIn, transform: `translateY(${(1 - cardIn) * 20}px)`,
          background: 'rgba(10,29,43,0.9)', border: `2px solid ${kind === 'fact' || kind === 'then' ? C.pale : C.amber}`, borderRadius: 18, padding: '16px 26px',
          fontFamily: FONT, color: C.pale, display: 'flex', alignItems: 'center', gap: 18, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
          {kind === 'reveal_answer' && <Flag iso2={seg.top[0]?.iso2} height={52} />}
          {kind === 'fact' && factRow && <Flag iso2={factRow.iso2} height={44} />}
          <div>
            <div style={{ fontSize: kind === 'reveal_answer' ? 48 : 38, fontWeight: 900, color: kind === 'fact' || kind === 'then' ? C.pale : C.amber }}>{card.on_screen}</div>
            {kind === 'reveal_answer' && <div style={{ fontSize: 34, fontWeight: 800 }}>{seg.top[0]?.display}</div>}
            {kind === 'fact' && factRow && <div style={{ fontSize: 30, fontWeight: 700, color: C.muted }}>{factRow.display}</div>}
          </div>
        </div>
      )}
      {/* Title card at the start of each map. */}
      {titleOut > 0 && (
        <AbsoluteFill style={{ background: `rgba(10,29,43,${0.94 * titleOut})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', opacity: titleOut }}>
          <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 800, color: C.blue, letterSpacing: 8 }}>MAP {seg.n} OF {count}</div>
          <div style={{ fontFamily: FONT, fontSize: 92, fontWeight: 900, color: C.pale, textAlign: 'center', maxWidth: 1600, lineHeight: 1.05, marginTop: 18,
            transform: `scale(${1.08 - 0.08 * titleIn})`, textWrap: 'balance' as any }}>{seg.title}</div>
          <div style={{ fontFamily: FONT, fontSize: 34, fontWeight: 700, color: C.muted, marginTop: 22 }}>{seg.yearText}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

const Intro: React.FC<{ p: LongformProps; beats: LongBeat[] }> = ({ p, beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14 } });
  const first = p.segments[0];
  const second = beats[1]?.start ?? Infinity;
  return (
    <AbsoluteFill>
      <div style={{ opacity: 0.55 }}>
        <LandMap map={first?.map ?? {}} cues={[{ kind: 'fill', start: 0 }]} fillFrom={0} />
      </div>
      <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(10,29,43,0.2), rgba(10,29,43,0.75))' }} />
      <div style={{ position: 'absolute', right: 90, top: 250, width: 900, fontFamily: FONT, textAlign: 'right' }}>
        <div style={{ fontSize: 150, fontWeight: 900, color: C.pale, lineHeight: 0.95, transform: `scale(${1.1 - 0.1 * s})`, transformOrigin: 'right center' }}>{p.count} MAPS</div>
        <div style={{ fontSize: 96, fontWeight: 900, color: C.blue, lineHeight: 1.1 }}>OF {p.themeName.toUpperCase()}</div>
        <div style={{ fontSize: 36, fontWeight: 700, color: C.muted, marginTop: 30, opacity: fadeIn(frame, second) }}>{beats[1]?.on_screen}</div>
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ p: LongformProps; beats: LongBeat[]; start: number }> = ({ p, beats, start }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ask = (beats[1]?.start ?? Infinity) - start;
  const cols = 2;
  return (
    <AbsoluteFill style={{ padding: '60px 90px' }}>
      <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 800, color: C.blue, letterSpacing: 6 }}>EVERY #1</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '14px 40px', marginTop: 24 }}>
        {p.segments.map((seg, i) => {
          const s = spring({ frame: frame - i * 5, fps, config: { damping: 16 } });
          const one = seg.top[0];
          return (
            <div key={seg.n} style={{ opacity: s, transform: `translateY(${(1 - s) * 20}px)`, display: 'flex', alignItems: 'center', gap: 18, height: 116,
              background: 'rgba(10,29,43,0.75)', border: '2px solid rgba(111,179,224,0.25)', borderRadius: 16, padding: '0 22px', fontFamily: FONT }}>
              <div style={{ width: 44, fontSize: 26, fontWeight: 900, color: C.blue }}>{seg.n}</div>
              <Flag iso2={one?.iso2} height={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{seg.title}</div>
                <div style={{ fontSize: 34, fontWeight: 900, color: C.amber, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{one?.name}</div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: C.pale, whiteSpace: 'nowrap' }}>{one?.display}</div>
            </div>
          );
        })}
      </div>
      {frame >= ask && (
        <AbsoluteFill style={{ background: `rgba(10,29,43,${0.9 * fadeIn(frame, ask, 12)})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontFamily: FONT, fontSize: 84, fontWeight: 900, color: C.pale, textAlign: 'center', maxWidth: 1500, opacity: fadeIn(frame, ask, 12), textWrap: 'balance' as any }}>
            {beats[1]?.on_screen}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

export const Longform: React.FC<LongformProps> = (p) => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => { document.fonts.ready.then(() => continueRender(handle)); }, [handle]);
  const intro = p.beats.filter((b) => b.visual === 'intro');
  const outro = p.beats.filter((b) => b.visual === 'outro');
  const segs = p.segments.map((seg, i) => {
    const beats = p.beats.filter((b) => b.seg === i);
    const start = beats[0]?.start ?? 0;
    const end = p.segments[i + 1] ? (p.beats.find((b) => b.seg === i + 1)?.start ?? p.durationInFrames) : (outro[0]?.start ?? p.durationInFrames);
    return { seg, beats, start, end };
  });
  const introEnd = segs[0]?.start ?? p.durationInFrames;
  const outroStart = outro[0]?.start ?? p.durationInFrames;
  return (
    <AbsoluteFill style={{ background: C.bgDeep }}>
      <Bg />
      <Sequence from={0} durationInFrames={Math.max(1, introEnd)}><Intro p={p} beats={intro} /></Sequence>
      {segs.map(({ seg, beats, start, end }) => (
        <Sequence key={seg.n} from={start} durationInFrames={Math.max(1, end - start)}>
          <Segment seg={seg} beats={beats} start={start} count={p.count} />
          <Footer source={seg.sourceLine} handle={p.handle} />
        </Sequence>
      ))}
      {outroStart < p.durationInFrames && (
        <Sequence from={outroStart} durationInFrames={p.durationInFrames - outroStart}>
          <Outro p={p} beats={outro} start={outroStart} />
        </Sequence>
      )}
      <Captions beats={p.beats} offset={0} />
      {introEnd > 0 && <Sequence from={0} durationInFrames={introEnd}><Footer handle={p.handle} /></Sequence>}
    </AbsoluteFill>
  );
};
