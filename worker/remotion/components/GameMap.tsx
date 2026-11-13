// The world map for the game-style long-form video. Same projection, box and colour language as
// LandMap.tsx (blue = the measure, amber = the answer, white outline = the country being talked
// about), but the caller decides every country's colour on every frame, so a round can run through
// the years or light up a group of countries.
import React from 'react';
import { geoEqualEarth, geoPath, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import world from 'world-atlas/countries-50m.json';
import { numericToIso3 } from '../iso';
import { C } from '../theme';

type Feat = { type: 'Feature'; id: string; iso3?: string; geometry: any; properties: any };

const FEATURES: Feat[] = (feature(world as any, (world as any).objects.countries) as any).features
  .filter((f: any) => f.id !== '010') // Antarctica
  .map((f: any) => ({ ...f, iso3: numericToIso3(String(f.id).padStart(3, '0')) }));

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

function camFor(iso: string | undefined, zoom = 1): Camera {
  const f = iso ? FEATURES.find((x) => x.iso3 === iso) : undefined;
  if (!f) return HOME;
  const m = mainland(f);
  const [[x0, y0], [x1, y1]] = path.bounds(m as any);
  const [cx, cy] = projection(geoCentroid(m as any)) ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  const k = Math.max(1.4, Math.min(5, Math.min((LM.w * 0.45) / Math.max(1, x1 - x0), (LM.h * 0.45) / Math.max(1, y1 - y0)))) * zoom;
  return { k, cx, cy };
}

// The camera flies to `iso` at frame `at` (no iso: back to the whole world).
export interface CamCue { at: number; iso?: string; zoom?: number }

export const GameMap: React.FC<{
  fills: Record<string, string>; // colour per country this frame; a country without one is plain land
  cam: CamCue[]; // sorted by `at`
  outlines?: string[]; // thin white outlines (the viewer's own countries)
  active?: { iso: string; at: number; amber?: boolean }; // the country being named: glowing outline, ring if small
  dim?: number; // 0 to 1: darken the whole map (behind a full-screen card)
}> = ({ fills, cam, outlines = [], active, dim = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  let from = HOME;
  let to = HOME;
  let camStart = -1000;
  for (const c of cam) {
    if (c.at > frame) break;
    from = to; to = camFor(c.iso, c.zoom); camStart = c.at;
  }
  const t = spring({ frame: frame - camStart, fps, config: { damping: 200 }, durationInFrames: 30 });
  const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * t);
  const cx = from.cx + (to.cx - from.cx) * t;
  const cy = from.cy + (to.cy - from.cy) * t;
  const sway = -12 + (24 * frame) / durationInFrames;
  const transform = `translate(${LM.w / 2 + sway}, ${LM.h / 2}) scale(${k}) translate(${-cx}, ${-cy})`;

  const act = active && frame >= active.at ? FEATURES.find((f) => f.iso3 === active.iso) : undefined;
  const pulse = act ? spring({ frame: frame - active!.at, fps, config: { damping: 12 } }) : 0;
  let ring: { x: number; y: number } | undefined;
  if (act) {
    const [[x0, y0], [x1, y1]] = path.bounds(act as any);
    const p = projection(geoCentroid(mainland(act) as any));
    if (p && Math.max(x1 - x0, y1 - y0) * k < 40) ring = { x: p[0], y: p[1] };
  }
  const lineColor = active?.amber ? C.amber : '#ffffff';

  return (
    <svg width={LM.w} height={LM.h} style={{ position: 'absolute', left: LM.x, top: LM.y, overflow: 'hidden', borderRadius: 24 }}>
      <defs>
        <filter id="gmlift" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx={0} dy={5 / k} stdDeviation={4 / k} floodColor="#000" floodOpacity={0.45} />
        </filter>
        <filter id="gmglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={6 / k} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <g transform={transform}>
        <g filter="url(#gmlift)">
          {PATHS.map(({ f, d }) => (d ? <path key={f.id} d={d} fill={fills[f.iso3 ?? ''] ?? C.land} stroke={C.bgDeep} strokeWidth={0.6 / k} /> : null))}
        </g>
        {outlines.map((iso) => {
          const f = FEATURES.find((x) => x.iso3 === iso);
          return f ? <path key={iso} d={path(f as any) ?? ''} fill="none" stroke="#ffffff" strokeWidth={1.6 / k} opacity={0.9} /> : null;
        })}
        {act && <path d={path(act as any) ?? ''} fill="none" stroke={lineColor} strokeWidth={(2.5 + pulse * 1.5) / k} filter="url(#gmglow)" />}
        {ring && <circle cx={ring.x} cy={ring.y} r={18 / k} fill="none" stroke={lineColor} strokeWidth={4 / k} opacity={pulse} />}
      </g>
      {dim > 0 && <rect x={0} y={0} width={LM.w} height={LM.h} fill={C.bgDeep} opacity={dim} />}
    </svg>
  );
};
