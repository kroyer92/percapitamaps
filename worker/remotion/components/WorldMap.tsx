import React, { useMemo } from 'react';
import { geoEqualEarth, geoPath, geoBounds, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import { interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import world from 'world-atlas/countries-50m.json';
import { numericToIso3 } from '../iso';
import { C, FONT, W, ZONE } from '../theme';
import type { TimedBeat } from '../types';

type Feat = { type: 'Feature'; id: string; iso3?: string; geometry: any; properties: any };

const FEATURES: Feat[] = (feature(world as any, (world as any).objects.countries) as any).features
  .filter((f: any) => f.id !== '010') // Antarctica
  .map((f: any) => ({ ...f, iso3: numericToIso3(String(f.id).padStart(3, '0')) }));

const MAP_TOP = ZONE.visualTop + 40;
const MAP_H = ZONE.visualBottom - ZONE.visualTop - 80;

interface Camera { k: number; cx: number; cy: number } // zoom factor and the projected point at the centre

function quantileColors(map: Record<string, number>, ramp: string[]): Map<string, string> {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  const out = new Map<string, string>();
  entries.forEach(([iso], i) => {
    const bin = Math.min(ramp.length - 1, Math.floor((i / entries.length) * ramp.length));
    out.set(iso, ramp[bin]);
  });
  return out;
}

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
}> = ({ map, cues, labelFor, threshold, thresholdLabel, unit, answerIso }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { projection, early, order } = useMemo(() => {
    const projection = geoEqualEarth().fitExtent([[20, MAP_TOP], [W - 20, MAP_TOP + MAP_H]], { type: 'FeatureCollection', features: FEATURES } as any);
    // Only the blue end of the ramp: amber is kept for the answer.
    const early = quantileColors(map, C.ramp.slice(0, 3));
    const order = new Map(Object.entries(map).sort((a, b) => a[1] - b[1]).map(([iso], i, arr) => [iso, i / arr.length]));
    return { projection, early, order };
  }, [map]);
  const path = geoPath(projection);

  // Camera: zoom cues move it; a later highlight/reveal of a country off-screen pulls it back out.
  const camFor = (iso?: string): Camera => {
    const base = { k: 1, cx: W / 2, cy: MAP_TOP + MAP_H / 2 };
    if (!iso) return base;
    const f = FEATURES.find((x) => x.iso3 === iso);
    if (!f) return base;
    const [[x0, y0], [x1, y1]] = path.bounds(f as any);
    const [cx, cy] = projection(geoCentroid(f as any)) ?? [(x0 + x1) / 2, (y0 + y1) / 2];
    const k = Math.max(1.6, Math.min(5, Math.min((W * 0.55) / Math.max(1, x1 - x0), (MAP_H * 0.55) / Math.max(1, y1 - y0))));
    return { k, cx, cy };
  };
  let from: Camera = { k: 1, cx: W / 2, cy: MAP_TOP + MAP_H / 2 };
  let to = from;
  let camStart = 0;
  for (const c of cues) {
    if (c.start > frame) break;
    if (c.kind === 'zoom') { from = to; to = camFor(c.iso); camStart = c.start; }
    if ((c.kind === 'fill' || c.kind === 'reveal') && to.k !== 1) { from = to; to = { k: 1, cx: W / 2, cy: MAP_TOP + MAP_H / 2 }; camStart = c.start; }
  }
  const t = spring({ frame: frame - camStart, fps, config: { damping: 200 }, durationInFrames: 24 });
  const cam = { k: from.k + (to.k - from.k) * t, cx: from.cx + (to.cx - from.cx) * t, cy: from.cy + (to.cy - from.cy) * t };
  const transform = `translate(${W / 2}, ${MAP_TOP + MAP_H / 2}) scale(${cam.k}) translate(${-cam.cx}, ${-cam.cy})`;

  const fill = cues.find((c) => c.kind === 'fill')!;
  const fillProgress = interpolate(frame, [fill.start, fill.start + 45], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });

  // Countries over the threshold stay blue until the reveal, so the answer isn't on screen
  // from the first seconds; then they turn amber one by one, biggest value last.
  const reveal = cues.find((c) => c.kind === 'reveal');
  const revealStart = reveal?.start ?? Infinity;
  const over = threshold !== undefined
    ? Object.entries(map).filter(([, v]) => v > threshold).sort((a, b) => a[1] - b[1]).map(([iso]) => iso)
    : [];
  const amberAt = (iso: string) => revealStart + Math.max(0, over.indexOf(iso)) * 4;

  const active = [...cues].reverse().find((c) => c.start <= frame && (c.kind === 'highlight' || c.kind === 'reveal' || c.kind === 'zoom'));
  const activeIso = active?.iso;
  const pulse = active ? spring({ frame: frame - active.start, fps, config: { damping: 12 } }) : 0;

  const activeFeature = activeIso ? FEATURES.find((f) => f.iso3 === activeIso) : undefined;
  const label = activeIso ? labelFor(activeIso) : undefined;
  let labelPos: [number, number] | null = null;
  if (activeFeature) {
    const p = projection(geoCentroid(activeFeature as any));
    if (p) labelPos = [(p[0] - cam.cx) * cam.k + W / 2, (p[1] - cam.cy) * cam.k + MAP_TOP + MAP_H / 2];
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
          <clipPath id="mapclip"><rect x={0} y={ZONE.visualTop} width={W} height={ZONE.visualBottom - ZONE.visualTop} /></clipPath>
          <filter id="glow"><feGaussianBlur stdDeviation={6} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <g clipPath="url(#mapclip)">
          <g transform={transform}>
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
              const color = shown ? (isAnswer ? C.amber : early.get(iso)!) : C.land;
              const isActive = iso === activeIso;
              return (
                <path key={f.id} d={d} fill={color} stroke={isActive ? C.pale : C.border}
                  strokeWidth={(isActive ? 3 + pulse * 2 : 0.6) / cam.k} filter={isActive ? 'url(#glow)' : undefined} />
              );
            })}
            {/* Small countries get a ring, or they'd be invisible on a phone. */}
            {markers.map(({ iso, x, y, at }) => {
              const pop = spring({ frame: frame - at, fps, config: { damping: 12 } });
              return <circle key={iso} cx={x} cy={y} r={(22 + 6 * (1 - pop)) / cam.k} fill="none" stroke={C.amber}
                strokeWidth={4 / cam.k} opacity={pop} />;
            })}
          </g>
        </g>
      </svg>
      {/* Blue key from the fill until the amber key replaces it. */}
      {fillProgress > 0 && !(over.length > 0 && thresholdLabel && frame >= revealStart) && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: ZONE.visualBottom - 70, display: 'flex', justifyContent: 'center', opacity: fillProgress }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'rgba(10,29,43,0.88)', borderRadius: 14, padding: '10px 22px',
            fontFamily: FONT, color: C.pale, fontSize: 28, fontWeight: 700 }}>
            <span>Less</span>
            <span style={{ width: 150, height: 20, borderRadius: 6, display: 'inline-block',
              background: `linear-gradient(90deg, ${C.ramp[0]}, ${C.ramp[1]}, ${C.ramp[2]})` }} />
            <span>More</span>
            {unit && <span style={{ opacity: 0.7, fontWeight: 500 }}>{unit}</span>}
          </div>
        </div>
      )}
      {/* Key for the amber colour, shown once the countries turn amber. */}
      {over.length > 0 && thresholdLabel && frame >= revealStart && (() => {
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
          top: labelPos ? Math.min(ZONE.visualBottom - 150, Math.max(ZONE.visualTop + 10, labelPos[1] - 140)) : ZONE.visualTop + 20,
          transform: `translateX(-50%) scale(${0.85 + pulse * 0.15})`, whiteSpace: 'nowrap' }}>
          <div style={{ background: 'rgba(10,29,43,0.88)', border: `2px solid ${C.amber}`, borderRadius: 18, padding: '14px 26px',
            fontFamily: FONT, color: C.pale, fontSize: 36, fontWeight: 800, textAlign: 'center', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
            {label}
          </div>
        </div>
      )}
    </>
  );
};
