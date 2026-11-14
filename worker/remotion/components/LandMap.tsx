// The world map for the 16:9 long-form video. Same colour language as the Shorts: blue shades are
// the measure, amber is only the answer (#1, or the countries over a threshold), and a white
// outline marks the country being talked about.
import React, { useMemo } from 'react';
import { geoEqualEarth, geoPath, geoCentroid } from 'd3-geo';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { worldFeatures } from '../world';
import { numericToIso3 } from '../iso';
import { C } from '../theme';

type Feat = { type: 'Feature'; id: string; iso3?: string; geometry: any; properties: any };

const FEATURES: Feat[] = worldFeatures()
  .filter((f: any) => f.id !== '010') // Antarctica
  .map((f: any) => ({ ...f, iso3: numericToIso3(String(f.id).padStart(3, '0')) }));

// The map's own box on screen (left part of the frame; the ladder is on the right).
export const LM = { x: 40, y: 120, w: 1240, h: 820 };
const projection = geoEqualEarth().fitExtent([[10, 30], [LM.w - 10, LM.h - 20]], { type: 'FeatureCollection', features: FEATURES } as any);
const path = geoPath(projection);
const PATHS = FEATURES.map((f) => ({ f, d: path(f as any) ?? '' }));

function mainland(f: Feat): Feat {
  if (f.geometry.type !== 'MultiPolygon') return f;
  const polys = (f.geometry.coordinates as any[]).map((c) => ({ ...f, geometry: { type: 'Polygon', coordinates: c } }));
  return polys.reduce((a, b) => (path.area(b as any) > path.area(a as any) ? b : a));
}

interface Camera { k: number; cx: number; cy: number }
const HOME: Camera = { k: 1, cx: LM.w / 2, cy: LM.h / 2 };

function camFor(iso: string | undefined): Camera | undefined {
  const f = iso ? FEATURES.find((x) => x.iso3 === iso) : undefined;
  if (!f) return undefined;
  const m = mainland(f);
  const [[x0, y0], [x1, y1]] = path.bounds(m as any);
  const [cx, cy] = projection(geoCentroid(m as any)) ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  // A big country gets a gentle zoom, a small one a closer look, but the region stays readable.
  const k = Math.max(1.4, Math.min(5, Math.min((LM.w * 0.45) / Math.max(1, x1 - x0), (LM.h * 0.45) / Math.max(1, y1 - y0))));
  return { k, cx, cy };
}

export interface LandCue { kind: 'fill' | 'focus' | 'reveal' | 'threshold'; iso?: string; start: number }

function quantiles(map: Record<string, number>): { colors: Map<string, string>; order: Map<string, number> } {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  const colors = new Map<string, string>();
  const order = new Map<string, number>();
  entries.forEach(([iso], i) => {
    colors.set(iso, C.blues[Math.min(C.blues.length - 1, Math.floor((i / entries.length) * C.blues.length))]);
    order.set(iso, i / entries.length);
  });
  return { colors, order };
}

export const LandMap: React.FC<{
  map: Record<string, number>;
  cues: LandCue[]; // sorted by start, frames relative to the segment
  answerIso?: string;
  threshold?: number;
  fillFrom: number;
  drift?: boolean;
}> = ({ map, cues, answerIso, threshold, fillFrom, drift = true }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { colors, order } = useMemo(() => quantiles(map), [map]);

  // Camera: each focus or reveal cue flies to its country; a fill or threshold cue goes home.
  let from = HOME;
  let to = HOME;
  let camStart = 0;
  for (const c of cues) {
    if (c.start > frame) break;
    const next = c.kind === 'focus' || c.kind === 'reveal' ? camFor(c.iso) : HOME;
    if (next) { from = to; to = next; camStart = c.start; }
  }
  const t = spring({ frame: frame - camStart, fps, config: { damping: 200 }, durationInFrames: 30 });
  const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * t);
  const cx = from.cx + (to.cx - from.cx) * t;
  const cy = from.cy + (to.cy - from.cy) * t;
  const sway = drift ? interpolate(frame, [0, durationInFrames], [-12, 12]) : 0;
  const transform = `translate(${LM.w / 2 + sway}, ${LM.h / 2}) scale(${k}) translate(${-cx}, ${-cy})`;

  const fill = interpolate(frame, [fillFrom, fillFrom + 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const revealAt = cues.find((c) => c.kind === 'reveal')?.start ?? Infinity;
  const thr = cues.find((c) => c.kind === 'threshold');
  const thrOn = thr && threshold !== undefined && frame >= thr.start
    && frame < (cues.find((c) => c.start > thr.start)?.start ?? Infinity);
  const last = [...cues].reverse().find((c) => c.start <= frame);
  const activeIso = last && (last.kind === 'focus' || last.kind === 'reveal') ? last.iso : undefined;
  const active = activeIso ? FEATURES.find((f) => f.iso3 === activeIso) : undefined;
  const pulse = last ? spring({ frame: frame - last.start, fps, config: { damping: 12 } }) : 0;

  // Small countries get a ring, or they'd be invisible.
  let ring: { x: number; y: number } | undefined;
  if (active) {
    const [[x0, y0], [x1, y1]] = path.bounds(active as any);
    const p = projection(geoCentroid(mainland(active) as any));
    if (p && Math.max(x1 - x0, y1 - y0) * k < 40) ring = { x: p[0], y: p[1] };
  }

  return (
    <svg width={LM.w} height={LM.h} style={{ position: 'absolute', left: LM.x, top: LM.y, overflow: 'hidden', borderRadius: 24 }}>
      <defs>
        <filter id="lmlift" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx={0} dy={5 / k} stdDeviation={4 / k} floodColor="#000" floodOpacity={0.45} />
        </filter>
        <filter id="lmglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={6 / k} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <g transform={transform}>
        <g filter="url(#lmlift)">
          {PATHS.map(({ f, d }) => {
            if (!d) return null;
            const iso = f.iso3 ?? '';
            const has = iso in map;
            const shown = has && fill >= (order.get(iso) ?? 0) * 0.9;
            const amber = has && ((iso === answerIso && frame >= revealAt) || (thrOn && map[iso] > threshold!));
            return <path key={f.id} d={d} fill={shown ? (amber ? C.amber : colors.get(iso)!) : C.land} stroke={C.bgDeep} strokeWidth={0.6 / k} />;
          })}
        </g>
        {active && <path d={path(active as any) ?? ''} fill="none" stroke="#ffffff" strokeWidth={(2.5 + pulse * 1.5) / k} filter="url(#lmglow)" />}
        {ring && <circle cx={ring.x} cy={ring.y} r={18 / k} fill="none" stroke={last?.kind === 'reveal' ? C.amber : '#ffffff'} strokeWidth={4 / k} opacity={pulse} />}
      </g>
    </svg>
  );
};
