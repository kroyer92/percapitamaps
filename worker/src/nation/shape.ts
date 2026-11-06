// The real outline of the country the nation is racing (Natural Earth, 1:10m), fitted into the
// card in the video. Tiny islands get a dashed ring so they can be seen at all (Tuvalu is nine
// atolls of a few square kilometres).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { geoMercator, geoPath, geoArea } from 'd3-geo';
import { feature } from 'topojson-client';
import { numericToIso3 } from '../data/countries.js';

export interface Shape { w: number; h: number; paths: string[]; rings: [number, number, number][] }

let feats: any[] | undefined;
function features(): any[] {
  if (!feats) {
    const file = createRequire(import.meta.url).resolve('world-atlas/countries-10m.json');
    const topo = JSON.parse(fs.readFileSync(file, 'utf8'));
    feats = (feature(topo, topo.objects.countries) as any).features;
  }
  return feats!;
}

export function countryShape(iso3: string, w = 720, h = 360): Shape | null {
  const f = features().find((x) => numericToIso3(String(x.id).padStart(3, '0')) === iso3);
  if (!f) return null;
  // The largest 40 parts; a country with hundreds of islets keeps its outline without a huge file.
  const polys: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const parts = polys.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }) as any)
    .sort((a, b) => geoArea(b) - geoArea(a)).slice(0, 40);
  const fc = { type: 'FeatureCollection', features: parts } as any;
  const proj = geoMercator().fitExtent([[30, 30], [w - 30, h - 30]], fc);
  const path = geoPath(proj);
  const paths: string[] = [];
  const rings: [number, number, number][] = [];
  for (const p of parts) {
    const d = path(p);
    if (!d) continue;
    paths.push(d.replace(/(\d+\.\d{1})\d+/g, '$1'));
    const [[x0, y0], [x1, y1]] = path.bounds(p);
    if (Math.max(x1 - x0, y1 - y0) < 24) rings.push([Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), 18]);
  }
  return { w, h, paths, rings: rings.length <= 15 ? rings : [] };
}
