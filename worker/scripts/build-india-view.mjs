// Builds remotion/data/india-view-50m.json: India, Pakistan and China redrawn the way India's
// official map draws them (all of Jammu & Kashmir and Ladakh inside India, including the areas
// Pakistan and China administer). Only the Kashmir pieces move; every other border stays the
// world-atlas 50m line, so neighbours still meet India, Pakistan and China exactly.
//
// Source of the claim line: Natural Earth's India point-of-view countries file (public domain),
// https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries_ind.geojson
//
// Run once (output is committed):
//   npm i --no-save polygon-clipping@0.15.7
//   node scripts/build-india-view.mjs /path/to/ne_10m_admin_0_countries_ind.geojson
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import { geoArea } from 'd3-geo';
import pc from 'polygon-clipping';

const require = createRequire(import.meta.url);
const world = require('world-atlas/countries-50m.json');
const pov = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const feats = feature(world, world.objects.countries).features;
const wa = (pred) => feats.find(pred);
const IND = wa((f) => f.id === '356');
const PAK = wa((f) => f.id === '586');
const CHN = wa((f) => f.id === '156');
const SIA = wa((f) => f.properties.name === 'Siachen Glacier');
if (!IND || !PAK || !CHN || !SIA) throw new Error('missing a feature');

const mp = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
// polygon-clipping returns counter-clockwise outer rings (planar convention); d3-geo works on the
// sphere and reads that as "everything except this shape", so rings are flipped to clockwise.
const d3wind = (polys) => polys.map((poly) => poly.map((ring) => [...ring].reverse()));
const km2 = (poly) => geoArea({ type: 'MultiPolygon', coordinates: d3wind([poly]) }) * 6371 ** 2;

// The parts of Pakistan and China that India's map puts inside India: what each has on the
// standard 50m map but not on Natural Earth's India-view map, inside a box around Kashmir. The 10m
// lines and the 50m borders differ by a few hundred metres along every shared border, which leaves
// hairline slivers; only real pieces (over 300 km²) move.
const KASHMIR_BOX = [[[72, 30], [81, 30], [81, 37.5], [72, 37.5], [72, 30]]];
function claimed(other) {
  const povOther = pov.features.find((f) => f.properties.ADM0_A3 === other.a3);
  const pieces = pc.intersection(pc.difference(mp(other.f.geometry), mp(povOther.geometry)), [KASHMIR_BOX]);
  const keep = pieces.filter((p) => km2(p) > 300);
  for (const p of keep) console.log(`  from ${other.f.properties.name}: ${Math.round(km2(p)).toLocaleString()} km²`);
  return keep;
}
console.log('Pieces that move to India:');
const fromPak = claimed({ f: PAK, a3: 'PAK' });
const fromChn = claimed({ f: CHN, a3: 'CHN' });

const round = (g) => JSON.parse(JSON.stringify(g, (k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)));
const asGeom = (polys) => { const coords = d3wind(polys); return round(coords.length === 1 ? { type: 'Polygon', coordinates: coords[0] } : { type: 'MultiPolygon', coordinates: coords }); };

const out = {
  note: 'India, Pakistan and China as drawn on India\'s official map. Built by scripts/build-india-view.mjs from world-atlas 50m + Natural Earth India point-of-view (public domain).',
  replace: {
    '356': asGeom(pc.union(mp(IND.geometry), mp(SIA.geometry), ...fromPak.map((p) => [p]), ...fromChn.map((p) => [p]))),
    '586': asGeom(pc.difference(mp(PAK.geometry), ...fromPak.map((p) => [p]))),
    '156': asGeom(pc.difference(mp(CHN.geometry), ...fromChn.map((p) => [p]))),
  },
  drop: ['Siachen Glacier'],
};
for (const [id, g] of Object.entries(out.replace)) {
  const before = feats.find((f) => f.id === id);
  console.log(id, before.properties.name, `${Math.round(geoArea(before) * 6371 ** 2).toLocaleString()} -> ${Math.round(geoArea({ type: 'Feature', geometry: g }) * 6371 ** 2).toLocaleString()} km²`);
}
const file = new URL('../remotion/data/india-view-50m.json', import.meta.url);
fs.writeFileSync(file, JSON.stringify(out));
console.log('wrote', file.pathname, fs.statSync(file).size, 'bytes');
