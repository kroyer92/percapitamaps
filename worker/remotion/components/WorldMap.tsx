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

function quantileColors(map: Record<string, number>): Map<string, string> {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  const out = new Map<string, string>();
  entries.forEach(([iso], i) => {
    const bin = Math.min(C.ramp.length - 1, Math.floor((i / entries.length) * C.ramp.length));
    out.set(iso, C.ramp[bin]);
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
  return cues.sort((a, b) => a.start - b.start);
}

export const WorldMap: React.FC<{
  map: Record<string, number>;
  cues: MapCue[];
  labelFor: (iso: string) => string | undefined;
  threshold?: number;
}> = ({ map, cues, labelFor, threshold }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { projection, colors, order } = useMemo(() => {
    const projection = geoEqualEarth().fitExtent([[20, MAP_TOP], [W - 20, MAP_TOP + MAP_H]], { type: 'FeatureCollection', features: FEATURES } as any);
    const colors = quantileColors(map);
    const order = new Map(Object.entries(map).sort((a, b) => a[1] - b[1]).map(([iso], i, arr) => [iso, i / arr.length]));
    return { projection, colors, order };
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
              const isThreshold = threshold !== undefined && has && map[iso] > threshold;
              const color = shown ? (threshold !== undefined ? (isThreshold ? C.amber : C.ramp[1]) : colors.get(iso)!) : C.land;
              const isActive = iso === activeIso;
              return (
                <path key={f.id} d={d} fill={color} stroke={isActive ? C.pale : C.border}
                  strokeWidth={(isActive ? 3 + pulse * 2 : 0.6) / cam.k} filter={isActive ? 'url(#glow)' : undefined} />
              );
            })}
          </g>
        </g>
      </svg>
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
