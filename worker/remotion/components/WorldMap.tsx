import React, { useMemo } from 'react';
import { geoEqualEarth, geoPath, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import { interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import world from 'world-atlas/countries-50m.json';
import { numericToIso3 } from '../iso';
import { C, FONT, MAP, W, ZONE } from '../theme';
import type { TimedBeat } from '../types';

type Feat = { type: 'Feature'; id: string; iso3?: string; geometry: any; properties: any };

const FEATURES: Feat[] = (feature(world as any, (world as any).objects.countries) as any).features
  .filter((f: any) => f.id !== '010') // Antarctica
  .map((f: any) => ({ ...f, iso3: numericToIso3(String(f.id).padStart(3, '0')) }));

// At zoom 1 the whole world fits the screen width; the home view is zoomed past that, so the map
// fills the phone and runs off both sides.
const WORLD_H = 520;
const projection = geoEqualEarth().fitExtent([[20, MAP.centreY - WORLD_H / 2], [W - 20, MAP.centreY + WORLD_H / 2]], { type: 'FeatureCollection', features: FEATURES } as any);
const path = geoPath(projection);

export interface Camera { k: number; cx: number; cy: number } // zoom factor and the projected point at the centre

function quantileColors(map: Record<string, number>, ramp: string[]): Map<string, string> {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  const out = new Map<string, string>();
  entries.forEach(([iso], i) => {
    const bin = Math.min(ramp.length - 1, Math.floor((i / entries.length) * ramp.length));
    out.set(iso, ramp[bin]);
  });
  return out;
}

// The main landmass of a country: overseas islands and territories (Alaska and Hawaii, French
// Guiana, New Zealand's outlying islands) would otherwise make the zoom far too wide.
function mainland(f: Feat): Feat {
  if (f.geometry.type !== 'MultiPolygon') return f;
  const polys = (f.geometry.coordinates as any[]).map((c) => ({ ...f, geometry: { type: 'Polygon', coordinates: c } }));
  return polys.reduce((a, b) => (path.area(b as any) > path.area(a as any) ? b : a));
}

// Room above the answer country for its number (see AnswerNumber).
export const ANSWER_DROP = 150;

// Where on screen the map is drawn. The default fills the phone; a band keeps the map in one
// strip of the screen (Countdown puts its ladder below it).
export interface MapView {
  centreY: number; // screen y of the camera's centre
  bottom: number; // the map is cut off (with a fade) below this y
  box: { w: number; h: number }; // a zoomed-in country fits in this box
  revealBox?: { w: number; h: number }; // the answer, which shares the band with its number
  revealDrop?: number; // how far below the centre the answer sits, under its number
  shiftX?: number; // zoomed-in countries sit this far left of centre, to leave room for a number
  homeK?: number;
  homeDy?: number; // the world view looks this far north (projected units)
}
export const FULL_VIEW: MapView = { centreY: MAP.centreY, bottom: 1920, box: { w: W * 0.62, h: 560 }, revealDrop: ANSWER_DROP };

// A country fills most of the space between the headline and the captions.
// `drop` moves it lower on screen, to make room for the answer's number above it.
export function camFor(iso: string | undefined, drop: number, box: { w: number; h: number }, shiftX = 0): Camera | undefined {
  const f = iso ? FEATURES.find((x) => x.iso3 === iso) : undefined;
  if (!f) return undefined;
  const m = mainland(f);
  const [[x0, y0], [x1, y1]] = path.bounds(m as any);
  const [cx, cy] = projection(geoCentroid(m as any)) ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  const k = Math.max(1.8, Math.min(14, Math.min(box.w / Math.max(1, x1 - x0), box.h / Math.max(1, y1 - y0))));
  return { k, cx: cx + shiftX / k, cy: cy - drop / k };
}

// One country's main landmass on its own, scaled to fit a w x h box (the Guess options). For
// island countries, where the biggest island is less than half the land, all of it is drawn.
export const CountryShape: React.FC<{ iso: string; w: number; h: number; color: string; stroke?: string }> = ({ iso, w, h, color, stroke }) => {
  const f = FEATURES.find((x) => x.iso3 === iso);
  if (!f) return <div style={{ width: w, height: h }} />;
  const m = mainland(f);
  const shape = path.area(m as any) >= 0.5 * path.area(f as any) ? m : f;
  const [[x0, y0], [x1, y1]] = path.bounds(shape as any);
  const k = Math.min((w * 0.86) / Math.max(1e-6, x1 - x0), (h * 0.86) / Math.max(1e-6, y1 - y0));
  const tx = w / 2 - ((x0 + x1) / 2) * k;
  const ty = h / 2 - ((y0 + y1) / 2) * k;
  return (
    <svg width={w} height={h} style={{ overflow: 'visible' }}>
      <g transform={`translate(${tx},${ty}) scale(${k})`}>
        <path d={path(shape as any) ?? ''} fill={color} stroke={stroke ?? 'none'} strokeWidth={3 / k} strokeLinejoin="round" />
      </g>
    </svg>
  );
};

export interface MapCue { kind: 'fill' | 'zoom' | 'highlight' | 'reveal'; iso?: string; start: number }

export function mapCues(beats: TimedBeat[], highlightIso?: string): MapCue[] {
  const cues: MapCue[] = [];
  for (const b of beats) {
    const [kind, arg] = b.visual.split(':');
    if (kind === 'map_fill') cues.push({ kind: 'fill', start: b.start });
    else if (kind === 'zoom_to' && arg) cues.push({ kind: 'zoom', iso: arg.toUpperCase(), start: b.start });
    else if (kind === 'highlight' && arg) cues.push({ kind: 'highlight', iso: arg.toUpperCase(), start: b.start });
    else if (kind === 'reveal_answer') cues.push({ kind: 'reveal', iso: highlightIso, start: b.start });
  }
  if (!cues.some((c) => c.kind === 'fill')) cues.unshift({ kind: 'fill', start: beats[1]?.start ?? 0 });
  if (!cues.some((c) => c.kind === 'reveal') && beats.length) cues.push({ kind: 'reveal', iso: highlightIso, start: beats[beats.length - 1].start });
  return cues.sort((a, b) => a.start - b.start);
}

export const WorldMap: React.FC<{
  map: Record<string, number>;
  cues: MapCue[];
  labelFor: (iso: string) => string | undefined;
  threshold?: number;
  thresholdLabel?: string;
  unit?: string;
  answerIso?: string;
  view?: MapView;
  // An opening of its own (the rank strip): its own camera until `until`, with one country
  // outlined and no label; the cues take over from where it ends. The key waits until `keyFrom`.
  intro?: { until: number; cam: (frame: number) => Camera; outlineIso?: string };
  keyFrom?: number;
}> = ({ map, cues, labelFor, threshold, thresholdLabel, unit, answerIso, view = FULL_VIEW, intro, keyFrom = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const { colors, order } = useMemo(() => {
    // Blue shades only: amber is kept for the answer.
    const colors = quantileColors(map, C.blues);
    const order = new Map(Object.entries(map).sort((a, b) => a[1] - b[1]).map(([iso], i, arr) => [iso, i / arr.length]));
    return { colors, order };
  }, [map]);

  // The home view drifts slowly west to east, so the map is moving from the first frame.
  const home = (): Camera => ({
    k: (view.homeK ?? MAP.home) + interpolate(frame, [0, durationInFrames], [0.08, 0]),
    cx: W / 2 + interpolate(frame, [0, durationInFrames], [-150, 150]),
    cy: MAP.centreY - (view.homeDy ?? 0),
  });
  const full = view.bottom >= 1920;

  // Camera: zoom and highlight cues fly to the country, the reveal flies to the answer, and a
  // fill cue goes back to the home view.
  const introEnd = intro?.cam(intro.until);
  let from: () => Camera = introEnd ? () => introEnd : home;
  let to: () => Camera = from;
  let camStart = 0;
  for (const c of cues) {
    if (c.start > frame) break;
    let next: (() => Camera) | undefined;
    if (c.kind === 'zoom' || c.kind === 'highlight') { const cam = camFor(c.iso, 0, view.box, view.shiftX); if (cam) next = () => cam; }
    if (c.kind === 'reveal') { const cam = camFor(c.iso, view.revealDrop ?? ANSWER_DROP, view.revealBox ?? view.box); if (cam) next = () => cam; }
    if (c.kind === 'fill' && c.start > 0) next = home;
    if (next) { from = to; to = next; camStart = c.start; }
  }
  const t = spring({ frame: frame - camStart, fps, config: { damping: 200 }, durationInFrames: 24 });
  const a = from();
  const b = to();
  // Zoom on a log scale so a big zoom doesn't rush at the end.
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * t);
  const cam = intro && frame < intro.until ? intro.cam(frame) : { k, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
  const transform = `translate(${W / 2}, ${view.centreY}) scale(${cam.k}) translate(${-cam.cx}, ${-cam.cy})`;

  // When the map fills on the hook, it is already coloured on frame 0: the first frame is what
  // a viewer sees before deciding to swipe.
  const fill = cues.find((c) => c.kind === 'fill')!;
  const fillProgress = fill.start === 0 ? 1 : interpolate(frame, [fill.start, fill.start + 45], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });

  // Countries over the threshold stay blue until the reveal, so the answer isn't on screen
  // from the first seconds; then they turn amber one by one, biggest value last.
  const reveal = cues.find((c) => c.kind === 'reveal');
  const revealStart = reveal?.start ?? Infinity;
  const over = threshold !== undefined
    ? Object.entries(map).filter(([, v]) => v > threshold).sort((a, b) => a[1] - b[1]).map(([iso]) => iso)
    : [];
  const amberAt = (iso: string) => revealStart + Math.max(0, over.indexOf(iso)) * 4;

  const active = [...cues].reverse().find((c) => c.start <= frame && (c.kind === 'highlight' || c.kind === 'reveal' || c.kind === 'zoom'));
  // A fill cue after a zoom returns to the world view, so nothing stays outlined.
  const lastCue = [...cues].reverse().find((c) => c.start <= frame);
  const introIso = intro?.outlineIso && frame < intro.until ? intro.outlineIso : undefined;
  const activeIso = introIso ?? (lastCue && lastCue.kind !== 'fill' ? active?.iso : undefined);
  const pulse = introIso ? spring({ frame: frame + 6, fps, config: { damping: 12 } }) : active ? spring({ frame: frame - active.start, fps, config: { damping: 12 } }) : 0;

  const activeFeature = activeIso ? FEATURES.find((f) => f.iso3 === activeIso) : undefined;
  // At the reveal, the answer's big number replaces the small label.
  const label = activeIso && !introIso && lastCue?.kind !== 'reveal' ? labelFor(activeIso) : undefined;
  let labelPos: [number, number] | null = null;
  if (activeFeature) {
    const p = projection(geoCentroid(mainland(activeFeature) as any));
    if (p) labelPos = [(p[0] - cam.cx) * cam.k + W / 2, (p[1] - cam.cy) * cam.k + view.centreY];
  }

  const ringed = [...over.filter((iso) => frame >= amberAt(iso)), ...(activeIso && !over.includes(activeIso) ? [activeIso] : [])];
  const markers = ringed.flatMap((iso) => {
    const f = FEATURES.find((x) => x.iso3 === iso);
    if (!f) return [];
    const [[x0, y0], [x1, y1]] = path.bounds(f as any);
    if (Math.max(x1 - x0, y1 - y0) * cam.k > 45) return [];
    const p = projection(geoCentroid(f as any));
    return p ? [{ iso, x: p[0], y: p[1], at: iso === activeIso && active ? active.start : amberAt(iso) }] : [];
  });

  return (
    <>
      <svg width={W} height={1920} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          {/* A soft shadow under the land, so the map reads as an object rather than flat shapes. */}
          <filter id="lift" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx={0} dy={6 / cam.k} stdDeviation={5 / cam.k} floodColor="#000" floodOpacity={0.5} />
          </filter>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={7 / cam.k} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          {/* Dark bands behind the headline and the captions, so text stays readable over the map. */}
          <linearGradient id="topshade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.bgDeep} stopOpacity={0.96} /><stop offset="0.7" stopColor={C.bgDeep} stopOpacity={0.82} /><stop offset="1" stopColor={C.bgDeep} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="bottomshade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.bgDeep} stopOpacity={0} /><stop offset="0.35" stopColor={C.bgDeep} stopOpacity={0.7} /><stop offset="1" stopColor={C.bgDeep} stopOpacity={0.95} />
          </linearGradient>
          <linearGradient id="bandfade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.bgDeep} stopOpacity={0} /><stop offset="1" stopColor={C.bgDeep} stopOpacity={0.95} />
          </linearGradient>
          <clipPath id="band"><rect x={0} y={0} width={W} height={view.bottom} /></clipPath>
        </defs>
        <g clipPath={full ? undefined : 'url(#band)'}>
        <g transform={transform}>
          <g filter="url(#lift)">
            {FEATURES.map((f) => {
              const d = path(f as any);
              if (!d) return null;
              const iso = f.iso3 ?? '';
              const has = iso in map;
              const rel = order.get(iso) ?? 0;
              const shown = has && fillProgress >= rel * 0.9;
              // Blue shades show the measure the whole video; amber is only ever the answer.
              const isAnswer = has && (threshold !== undefined
                ? map[iso] > threshold && frame >= amberAt(iso)
                : iso === answerIso && frame >= revealStart);
              const color = shown ? (isAnswer ? C.amber : colors.get(iso)!) : C.land;
              return <path key={f.id} d={d} fill={color} stroke={C.bgDeep} strokeWidth={0.7 / cam.k} />;
            })}
          </g>
          {activeFeature && (
            <path d={path(activeFeature as any) ?? ''} fill="none" stroke="#ffffff" strokeWidth={(3 + pulse * 2) / cam.k} filter="url(#glow)" />
          )}
          {/* Small countries get a ring, or they'd be invisible on a phone. */}
          {markers.map(({ iso, x, y, at }) => {
            const pop = spring({ frame: frame - at, fps, config: { damping: 12 } });
            return <circle key={iso} cx={x} cy={y} r={(22 + 6 * (1 - pop)) / cam.k} fill="none" stroke={C.amber}
              strokeWidth={4 / cam.k} opacity={pop} />;
          })}
        </g>
        </g>
        <rect x={0} y={0} width={W} height={700} fill="url(#topshade)" />
        {full
          ? <rect x={0} y={1360} width={W} height={560} fill="url(#bottomshade)" />
          : <rect x={0} y={view.bottom - 110} width={W} height={111} fill="url(#bandfade)" />}
      </svg>
      {/* Blue key from the fill until the amber key replaces it. */}
      {full && fillProgress > 0 && frame >= keyFrom && !(over.length > 0 && thresholdLabel && frame >= revealStart) && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: ZONE.visualBottom - 70, display: 'flex', justifyContent: 'center',
          opacity: fillProgress * (keyFrom > 0 ? interpolate(frame, [keyFrom, keyFrom + 10], [0, 1], { extrapolateRight: 'clamp' }) : 1) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'rgba(10,29,43,0.88)', borderRadius: 14, padding: '10px 22px',
            fontFamily: FONT, color: C.pale, fontSize: 28, fontWeight: 700 }}>
            <span>Less</span>
            <span style={{ width: 150, height: 20, borderRadius: 6, display: 'inline-block',
              background: `linear-gradient(90deg, ${C.blues[0]}, ${C.blues[2]}, ${C.blues[5]})` }} />
            <span>More</span>
            {unit && <span style={{ opacity: 0.7, fontWeight: 500 }}>{unit}</span>}
          </div>
        </div>
      )}
      {/* Key for the amber colour, shown once the countries turn amber. */}
      {full && over.length > 0 && thresholdLabel && frame >= revealStart && (() => {
        const k = spring({ frame: frame - revealStart, fps, config: { damping: 200 }, durationInFrames: 15 });
        return (
          <div style={{ position: 'absolute', left: 0, right: 0, top: ZONE.visualBottom - 70, display: 'flex', justifyContent: 'center', opacity: k }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'rgba(10,29,43,0.88)', borderRadius: 14, padding: '10px 22px',
              fontFamily: FONT, color: C.pale, fontSize: 32, fontWeight: 700 }}>
              <span style={{ width: 28, height: 28, borderRadius: 6, background: C.amber, display: 'inline-block' }} />
              {`${over.length} ${over.length === 1 ? 'country' : 'countries'} with ${thresholdLabel}`}
            </div>
          </div>
        );
      })()}
      {label && (
        <div style={{ position: 'absolute', left: labelPos ? Math.min(W - 380, Math.max(380, labelPos[0])) : W / 2,
          top: labelPos ? Math.min(ZONE.visualBottom - 150, Math.max(ZONE.visualTop + 60, labelPos[1] - 150)) : ZONE.visualTop + 60,
          transform: `translateX(-50%) scale(${0.85 + pulse * 0.15})`, whiteSpace: 'nowrap' }}>
          <div style={{ background: 'rgba(10,29,43,0.88)', border: `2px solid ${C.pale}`, borderRadius: 18, padding: '14px 26px',
            fontFamily: FONT, color: C.pale, fontSize: 40, fontWeight: 800, textAlign: 'center', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
            {label}
          </div>
        </div>
      )}
    </>
  );
};

// "$64,000" at 0.5 -> "$32,000": counts the first number in a display string up from zero,
// keeping its decimals, thousands separators, prefix and suffix.
export function countUp(display: string, progress: number): string {
  const m = display.match(/\d[\d,]*(\.\d+)?/);
  if (!m) return display;
  const value = Number(m[0].replace(/,/g, ''));
  const decimals = m[1] ? m[1].length - 1 : 0;
  const shown = (value * progress).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: m[0].includes(',') });
  return display.slice(0, m.index) + shown + display.slice((m.index ?? 0) + m[0].length);
}

// The payoff is the biggest thing on screen: the answer's value counts up in large amber digits
// above the answer country, which the camera has zoomed in on.
export const AnswerNumber: React.FC<{ display: string; unit?: string; start: number; end?: number; top?: number; maxSize?: number }> = ({ display, unit, start, end, top = ZONE.visualTop + 20, maxSize = 230 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < start) return null;
  const out = end === undefined ? 1 : interpolate(frame, [end, end + 10], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (out <= 0) return null;
  const pop = spring({ frame: frame - start - 6, fps, config: { damping: 11, stiffness: 170 } });
  const count = interpolate(frame, [start + 6, start + 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const text = countUp(display, count);
  const size = Math.min(maxSize, display.length > 9 ? 150 : display.length > 6 ? 190 : 230);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top, textAlign: 'center', fontFamily: FONT,
      transform: `scale(${0.6 + 0.4 * pop})`, opacity: Math.min(1, pop * 1.5) * out }}>
      <div style={{ fontSize: size, fontWeight: 900, letterSpacing: -6, lineHeight: 1, color: C.amber, fontVariantNumeric: 'tabular-nums',
        textShadow: '0 10px 40px rgba(0,0,0,0.75)' }}>{text}</div>
      {unit && <div style={{ fontSize: 40, fontWeight: 800, color: C.pale, marginTop: 6, textShadow: '0 4px 18px rgba(0,0,0,0.7)' }}>{unit}</div>}
    </div>
  );
};
