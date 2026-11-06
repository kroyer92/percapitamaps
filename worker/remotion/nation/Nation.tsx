// Per Capita Nation: the daily census Short. A living island drawn in the channel's map style
// (navy sea with the grid, blue land, pale citizens, amber for what's new), one scene per beat of
// the script, and the same word-by-word captions as every Short, timed from the voice.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import { AbsoluteFill, Easing, continueRender, delayRender, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { geoEqualEarth, geoPath, geoContains, geoBounds } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import { numericToIso3 } from '../iso';
import { C, FONT } from '../theme';
import { Flag } from '../components/Flag';
import { Captions } from '../components/Chrome';
import type { TimedBeat } from '../types';
import type { NationProps } from './types';

const U = 3.3; // world units -> screen px (the island world is 270 x 480)
const ISLAND = { cx: 135, cy: 300, rx: 112, ry: 140 };
const HOME_Y = 285;
const MAX_DOTS = 400; // above this, one figure stands for several citizens
const fmt = (n: number) => n.toLocaleString('en-US');
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

function rng(seed: number) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
function edge(a: number) { return 1 + 0.07 * Math.sin(a * 3 + 1.7) + 0.05 * Math.sin(a * 7 + 3.4) + 0.03 * Math.sin(a * 13 + 5.1); }
function inIsland(x: number, y: number, k = 1) {
  const dx = (x - ISLAND.cx) / (ISLAND.rx * k), dy = (y - ISLAND.cy) / (ISLAND.ry * k);
  return Math.hypot(dx, dy) < edge(Math.atan2(dy, dx));
}
function islandPath(ctx: CanvasRenderingContext2D, k: number) {
  ctx.beginPath();
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * Math.PI * 2, e = edge(a) * k;
    const x = ISLAND.cx + Math.cos(a) * ISLAND.rx * e, y = ISLAND.cy + Math.sin(a) * ISLAND.ry * e;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

type Person = { x: number; y: number; iso: string; col: string; ph: number; ph2: number; sp: number; idx: number };

// Trees, house plots and one walking figure per citizen (or per few, on a big day).
function useWorld(citizens: Record<string, number>, n: number) {
  return useMemo(() => {
    const r = rng(7);
    const houses: { x: number; y: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.3, rad = i % 2 ? 56 : 42;
      houses.push({ x: ISLAND.cx + Math.cos(a) * rad * 1.15, y: ISLAND.cy + Math.sin(a) * rad });
    }
    const trees: { x: number; y: number; s: number }[] = [];
    for (let i = 0; i < 3000 && trees.length < 120; i++) {
      const x = 20 + r() * 230, y = 140 + r() * 320;
      if (inIsland(x, y, 0.9) && Math.hypot((x - ISLAND.cx) / 1.15, y - ISLAND.cy) > 84) trees.push({ x, y, s: r() });
    }
    trees.sort((a, b) => a.y - b.y);
    const per = Math.max(1, n / MAX_DOTS);
    const flat: string[] = [];
    Object.entries(citizens).sort((a, b) => a[0].localeCompare(b[0])).forEach(([iso, c]) => { for (let i = 0; i < Math.max(1, Math.round(c / per)); i++) flat.push(iso); });
    for (let i = flat.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [flat[i], flat[j]] = [flat[j], flat[i]]; }
    const cols = [C.pale, C.pale, C.blue, '#b5daf2'];
    const people: Person[] = flat.map((iso, idx) => {
      const a = r() * Math.PI * 2, d = 12 + Math.sqrt(r()) * 66;
      return { x: ISLAND.cx + Math.cos(a) * d * 1.15, y: ISLAND.cy + Math.sin(a) * d, iso, col: cols[Math.floor(r() * cols.length)], ph: r() * 6.28, ph2: r() * 6.28, sp: 0.5 + r() * 0.7, idx };
    });
    return { houses, trees, people, per };
  }, [citizens, n]);
}

const walk = (p: Person, t: number) => [p.x + Math.sin(t * p.sp + p.ph) * 7, p.y + Math.cos(t * p.sp * 0.8 + p.ph2) * 5];

type World = ReturnType<typeof useWorld>;

const IslandCanvas: React.FC<{
  p: NationProps; w: World; shown: number; cam: { k: number; x: number; y: number }; group: number; focus: number; fresh: number;
}> = ({ p, w, shown, cam, group, focus, fresh }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const f = useCurrentFrame();
  const top3 = p.census.top.slice(0, 3).map((t) => t.iso3);
  useLayoutEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    const t = f / 30;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // The sea: the channel background with its grid.
    ctx.fillStyle = C.bgDeep; ctx.fillRect(0, 0, 1080, 1920);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 2;
    for (let x = 0; x <= 1080; x += 90) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1920); ctx.stroke(); }
    for (let y = 0; y <= 1920; y += 90) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1080, y); ctx.stroke(); }
    ctx.setTransform(U * cam.k, 0, 0, U * cam.k, 540 - cam.x * U * cam.k, 960 - cam.y * U * cam.k);
    // Coastline rings like a depth map, then the land in the map's blues.
    [1.16, 1.09, 1.03].forEach((k, i) => { islandPath(ctx, k); ctx.strokeStyle = `rgba(111,179,224,${0.12 + i * 0.08})`; ctx.lineWidth = 0.8; ctx.stroke(); });
    islandPath(ctx, 1); ctx.fillStyle = C.blues[1]; ctx.fill();
    ctx.strokeStyle = C.pale; ctx.lineWidth = 1.1; ctx.stroke();
    islandPath(ctx, 0.9); ctx.fillStyle = C.blues[2]; ctx.fill();
    islandPath(ctx, 0.7); ctx.fillStyle = '#3a88b6'; ctx.fill();
    ctx.fillStyle = C.blues[3]; ctx.beginPath(); ctx.ellipse(ISLAND.cx, ISLAND.cy, 30, 25, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.blues[3]; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath();
    ctx.moveTo(ISLAND.cx, ISLAND.cy + 24); ctx.bezierCurveTo(ISLAND.cx - 10, ISLAND.cy + 70, ISLAND.cx + 12, ISLAND.cy + 100, ISLAND.cx, ISLAND.cy + 135); ctx.stroke();
    for (const tr of w.trees) {
      ctx.fillStyle = 'rgba(10,29,43,0.35)'; ctx.beginPath(); ctx.ellipse(tr.x + 1.2, tr.y + 2.2, 3.6, 1.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = tr.s > 0.5 ? '#17405c' : '#1a4a6a'; ctx.beginPath(); ctx.arc(tr.x, tr.y, 3.6 + tr.s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(181,218,242,0.18)'; ctx.beginPath(); ctx.arc(tr.x - 1, tr.y - 1, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    // A house per 30 citizens, pale with amber windows.
    const houses = Math.min(12, Math.floor((shown * w.per) / 30) + 1);
    w.houses.slice(0, houses).forEach((h, i) => {
      ctx.save(); ctx.translate(h.x, h.y);
      ctx.fillStyle = 'rgba(10,29,43,0.45)'; ctx.fillRect(-4.5, 1.5, 11, 6);
      ctx.fillStyle = C.pale; ctx.fillRect(-5.5, -2.5, 11, 7.5);
      ctx.fillStyle = C.bg; ctx.beginPath(); ctx.moveTo(-7, -2.5); ctx.lineTo(0, -8); ctx.lineTo(7, -2.5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(240,176,74,${0.7 + 0.3 * Math.sin(t * 3 + i)})`; ctx.fillRect(-3.5, -0.5, 2.2, 2.2); ctx.fillRect(1.3, -0.5, 2.2, 2.2);
      ctx.restore();
    });
    // The campfire on the square.
    const fl = 0.8 + 0.2 * Math.sin(t * 14);
    const g = ctx.createRadialGradient(ISLAND.cx, ISLAND.cy, 0, ISLAND.cx, ISLAND.cy, 18 * fl);
    g.addColorStop(0, 'rgba(240,176,74,0.55)'); g.addColorStop(1, 'rgba(240,176,74,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ISLAND.cx, ISLAND.cy, 18 * fl, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.amber; ctx.beginPath(); ctx.moveTo(ISLAND.cx - 2.5, ISLAND.cy + 2); ctx.quadraticCurveTo(ISLAND.cx, ISLAND.cy - 6 * fl, ISLAND.cx + 2.5, ISLAND.cy + 2); ctx.fill();
    // The flag pole: blank with a "?" until the viewers vote its colours.
    const fx = ISLAND.cx + 16, fy = ISLAND.cy - 26, wave = Math.sin(t * 6);
    ctx.strokeStyle = C.pale; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy + 18); ctx.stroke();
    const cloth = () => { ctx.beginPath(); ctx.moveTo(fx, fy); ctx.quadraticCurveTo(fx + 5, fy - 1 + wave, fx + 10, fy + 1); ctx.lineTo(fx + 10, fy + 6); ctx.quadraticCurveTo(fx + 5, fy + 5 + wave, fx, fy + 6); ctx.closePath(); };
    if (p.flag) {
      ctx.save(); cloth(); ctx.clip();
      ctx.fillStyle = p.flag[0]; ctx.fillRect(fx, fy - 2, 11, 5);
      ctx.fillStyle = p.flag[1]; ctx.fillRect(fx, fy + 3, 11, 5);
      ctx.restore();
    } else {
      ctx.fillStyle = '#ffffff'; cloth(); ctx.fill();
      ctx.fillStyle = C.bg; ctx.font = '700 5px Inter'; ctx.fillText('?', fx + 3.6, fy + 5);
    }
    // The citizens. On the homelands beat the three biggest groups gather in front of the square.
    const spots: Record<string, [number, number]> = {};
    [[-52, 40], [0, 60], [52, 40]].forEach(([dx, dy], i) => { if (top3[i]) spots[top3[i]] = [ISLAND.cx + dx, ISLAND.cy + dy]; });
    const freshFrom = w.people.length - Math.min(12, Math.ceil(fresh / w.per));
    const list = w.people.slice(0, shown).map((pp) => {
      const [wx, wy] = walk(pp, t);
      const s = spots[pp.iso];
      const ox = s ? s[0] + ((pp.idx * 37) % 26) - 13 : wx, oy = s ? s[1] + ((pp.idx * 53) % 14) - 7 : wy;
      return { pp, x: wx + (ox - wx) * (s ? group : 0), y: wy + (oy - wy) * (s ? group : 0) };
    }).sort((a, b) => a.y - b.y);
    for (const { pp, x, y } of list) {
      const inGroup = !!spots[pp.iso];
      ctx.globalAlpha = group > 0.5 && !inGroup ? 0.35 : 1;
      ctx.fillStyle = (group > 0.3 && inGroup) || (fresh > 0 && pp.idx >= freshFrom) ? C.amber : pp.col;
      const bob = Math.abs(Math.sin(t * 6 + pp.ph)) * 0.5;
      ctx.beginPath(); ctx.arc(x, y - 2.4 - bob, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.roundRect(x - 1.1, y - 1.2 - bob, 2.2, 3.4, 1); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // The ring around one citizen when the video explains "every viewer = 1 citizen".
    if (focus > 0 && w.people.length) {
      const [x, y] = walk(w.people[w.people.length - 1], t);
      ctx.strokeStyle = C.amber; ctx.lineWidth = 0.5; ctx.globalAlpha = focus;
      ctx.beginPath(); ctx.arc(x, y - 0.5, 4.5, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });
  return <canvas ref={ref} width={1080} height={1920} style={{ position: 'absolute', inset: 0 }} />;
};

// A small world map: where the citizens live.
type Feat = { id: string; iso3?: string; geometry: unknown };
const FEATS: Feat[] = (feature(world as any, (world as any).objects.countries) as any).features
  .filter((f: any) => f.id !== '010').map((f: any) => ({ ...f, iso3: numericToIso3(String(f.id).padStart(3, '0')) }));
const proj = geoEqualEarth().fitExtent([[0, 0], [880, 430]], { type: 'FeatureCollection', features: FEATS } as any);
const gpath = geoPath(proj);
const Inset: React.FC<{ citizens: Record<string, number>; top: string[]; s: number }> = ({ citizens, top, s }) => {
  const dots = useMemo(() => {
    const r = rng(3); const out: [number, number, string][] = [];
    for (const [iso, c] of Object.entries(citizens)) {
      const f = FEATS.find((x) => x.iso3 === iso); if (!f) continue;
      const [[x0, y0], [x1, y1]] = geoBounds(f as any);
      for (let i = 0; i < Math.min(c, 30); i++) for (let k = 0; k < 80; k++) {
        const pt: [number, number] = [x0 + r() * (x1 - x0), y0 + r() * (y1 - y0)];
        if (geoContains(f as any, pt)) { const xy = proj(pt); if (xy) out.push([xy[0], xy[1], iso]); break; }
      }
    }
    return out;
  }, [citizens]);
  return (
    <div style={{ position: 'absolute', top: 560, left: 100, width: 880, height: 430, opacity: s, transform: `scale(${0.9 + 0.1 * s})`, background: 'rgba(10,29,43,0.82)', borderRadius: 20, boxShadow: `0 0 0 3px ${C.blue}` }}>
      <svg width={880} height={430}>
        {FEATS.map((f) => <path key={f.id} d={gpath(f as any) || ''} fill={f.iso3 && citizens[f.iso3] ? C.blues[2] : C.land} stroke={top.includes(f.iso3!) ? '#fff' : C.bgDeep} strokeWidth={top.includes(f.iso3!) ? 2 : 0.5} />)}
        {dots.map(([x, y, iso], i) => <circle key={i} cx={x} cy={y} r={3.2} fill={top.includes(iso) ? C.amber : C.pale} />)}
      </svg>
    </div>
  );
};

const OurFlag: React.FC<{ flag: [string, string] | null; h: number }> = ({ flag, h }) => flag
  ? <div style={{ width: h * 1.5, height: h, borderRadius: 4, overflow: 'hidden', display: 'grid', gridTemplateRows: '1fr 1fr', boxShadow: '0 0 0 1px rgba(255,255,255,0.25)' }}><div style={{ background: flag[0] }} /><div style={{ background: flag[1] }} /></div>
  : <div style={{ width: h * 1.5, height: h, borderRadius: 4, background: '#fff', color: C.bg, display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: h * 0.68 }}>?</div>;

export const Nation: React.FC<NationProps> = (p) => {
  const [fontHandle] = useState(() => delayRender('fonts'));
  useEffect(() => { document.fonts.ready.then(() => continueRender(fontHandle)); }, [fontHandle]);
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const c = p.census;
  const w = useWorld(c.citizens, c.n);
  const tag = (b: TimedBeat) => b.visual.split(':')[1] ?? '';
  const beat = (name: string) => p.beats.find((b) => tag(b) === name);
  const current = [...p.beats].reverse().find((b) => f >= b.start - 4) ?? p.beats[0];
  const scene = tag(current);
  const st = current.start - 4;
  const sp = (from: number, damping = 14) => spring({ frame: f - from, fps, config: { damping, mass: 0.6 } });

  // The island: the counter fills it on the hook, then everyone is there.
  const hook = p.beats[0];
  const people = w.people.length;
  const countT = interpolate(f, [2, Math.max(3, hook.end - 6)], [0, 1], { ...clamp, easing: Easing.out(Easing.quad) });
  const shownCount = Math.round(countT * c.n);
  const shownDots = Math.round(countT * people);
  const span = (b: TimedBeat | undefined, a: number, z: number) => (b ? interpolate(f, [b.start - 4, b.start - 4 + a, b.end - z, b.end + 8], [0, 1, 1, 0], { ...clamp, easing: Easing.inOut(Easing.cubic) }) : 0);
  const zHow = span(beat('how'), 18, 6);
  const zTarget = span(beat('target'), 22, 0);
  const intro = interpolate(f, [0, 40], [2, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  let cam = { k: intro, x: 135, y: HOME_Y };
  if (zHow > 0 && w.people.length) {
    const [px, py] = walk(w.people[w.people.length - 1], f / 30);
    cam = { k: 1 + 2.4 * zHow, x: 135 + (px - 135) * zHow, y: HOME_Y + (py - HOME_Y) * zHow };
  }
  if (zTarget > 0) cam = { k: 1 + 0.1 * zTarget, x: 135 + 40 * zTarget, y: HOME_Y - 115 * zTarget };
  const homes = beat('homes');
  const group = homes ? interpolate(f, [homes.start + 26, homes.start + 51, homes.end - 2, homes.end + 12], [0, 1, 1, 0], { ...clamp, easing: Easing.inOut(Easing.quad) }) : 0;
  const inset = homes ? interpolate(f, [homes.start - 2, homes.start + 6, homes.start + 26, homes.start + 34], [0, 1, 1, 0], clamp) : 0;
  const dim = ['census', 'rank', 'cta', 'voted', 'new'].includes(scene) ? 0.45 : 1;
  const top3 = c.top.slice(0, 3);
  const iso2 = (iso: string) => p.iso2[iso];
  const pad = (n: number) => String(n).padStart(4, '0');

  const H: React.FC<{ k?: string; t: React.ReactNode; size?: number; color?: string; from: number }> = ({ k, t, size = 92, color = C.pale, from }) => {
    const s = sp(from);
    return (
      <div style={{ position: 'absolute', top: 300, left: 60, right: 60, textAlign: 'center', opacity: s, transform: `scale(${0.85 + 0.15 * s})` }}>
        {k && <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 6, color: C.blue, marginBottom: 12 }}>{k}</div>}
        <div style={{ fontSize: size, fontWeight: 900, lineHeight: 1, color, textTransform: 'uppercase', textShadow: '0 6px 24px rgba(0,0,0,0.6)' }}>{t}</div>
      </div>
    );
  };
  const row = (us?: boolean): React.CSSProperties => ({ display: 'grid', alignItems: 'center', gap: 18, padding: '22px 26px', borderRadius: 14, background: us ? C.amber : 'rgba(15,42,61,0.92)', color: us ? '#1c1300' : C.pale, boxShadow: us ? 'none' : 'inset 0 0 0 2px rgba(111,179,224,0.25)' });

  return (
    <AbsoluteFill style={{ background: C.bgDeep, fontFamily: FONT, color: C.pale }}>
      <AbsoluteFill style={{ opacity: dim }}>
        <IslandCanvas p={p} w={w} shown={shownDots} cam={cam} group={group} focus={zHow} fresh={scene === 'new' || scene === 'hook' ? c.newSince : 0} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(10,29,43,0.9) 0%, rgba(10,29,43,0) 32%, rgba(10,29,43,0) 64%, rgba(10,29,43,0.85) 100%)' }} />

      <div style={{ position: 'absolute', top: 210, left: 0, right: 0, textAlign: 'center', fontSize: 30, fontWeight: 800, letterSpacing: 4, color: C.muted }}>
        PER CAPITA NATION · DAY {c.day} · CENSUS {p.stamp.toUpperCase()}
      </div>
      {scene !== 'hook' && <div style={{ position: 'absolute', top: 252, left: 0, right: 0, textAlign: 'center', fontSize: 30, fontWeight: 800, letterSpacing: 3, color: C.amber }}>POP. {fmt(c.n)}</div>}

      {scene === 'hook' && (
        <div style={{ position: 'absolute', top: 290, left: 0, right: 0, textAlign: 'center' }}>
          <div style={{ fontSize: 64, fontWeight: 900, letterSpacing: 2 }}>THIS COUNTRY HAS</div>
          <div style={{ fontSize: shownCount >= 10000 ? 170 : 210, fontWeight: 900, color: C.amber, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{fmt(shownCount)}</div>
          <div style={{ fontSize: 64, fontWeight: 900, letterSpacing: 2 }}>{c.n === 1 ? 'CITIZEN' : 'CITIZENS'}</div>
        </div>
      )}

      {scene === 'how' && (
        <>
          <H k="EVERY VIEWER WHO JOINS" t="= 1 citizen" from={st} />
          <div style={{ position: 'absolute', top: 800, left: 560, display: 'flex', gap: 14, alignItems: 'center', background: C.bg, borderRadius: 12, padding: '12px 18px', boxShadow: `0 0 0 3px ${C.amber}`, fontSize: 34, fontWeight: 800, opacity: interpolate(f, [st + 16, st + 22, current.end - 6, current.end], [0, 1, 1, 0], clamp) }}>
            {c.newest[0] ? <><Flag iso2={iso2(c.newest[0].iso3)} height={30} /> Citizen #{pad(c.newest[0].no)}</> : <>Citizen #0001</>}
          </div>
        </>
      )}

      {scene === 'new' && (
        <>
          <H k="SINCE YESTERDAY" t={`+${fmt(c.newSince)} new`} color={C.amber} from={st} />
          <div style={{ position: 'absolute', top: 640, left: 110, right: 110, display: 'grid', gap: 22 }}>
            {c.newest.map((x, i) => {
              const s = sp(st + 10 + i * 7, 13);
              return (
                <div key={x.no} style={{ display: 'flex', alignItems: 'center', gap: 22, background: C.bg, borderRadius: 16, padding: '22px 26px', boxShadow: `0 0 0 3px ${i === 0 ? C.amber : 'rgba(111,179,224,0.35)'}`, transform: `translateX(${(1 - s) * 900}px)` }}>
                  <Flag iso2={iso2(x.iso3)} height={52} />
                  <div style={{ flex: 1, fontSize: 44, fontWeight: 900, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{x.name}</div>
                  <div style={{ fontSize: 40, fontWeight: 900, color: C.amber, fontVariantNumeric: 'tabular-nums' }}>#{pad(x.no)}</div>
                </div>
              );
            })}
            {c.newSince > c.newest.length && <div style={{ textAlign: 'center', fontSize: 34, fontWeight: 800, color: C.muted, opacity: sp(st + 32) }}>and {fmt(c.newSince - c.newest.length)} more</div>}
          </div>
        </>
      )}

      {scene === 'homes' && (
        <>
          <H k="WHERE YOU LIVE" t={top3.length >= 3 ? 'Top homelands' : 'Homelands'} from={st} />
          <Inset citizens={c.citizens} top={top3.map((t) => t.iso3)} s={inset} />
          {top3.map((t, i) => {
            const pos = [[-52, 40], [0, 60], [52, 40]][i];
            const s = sp(current.start + 44 + i * 5);
            return (
              <div key={t.iso3} style={{ position: 'absolute', left: 540 + pos[0] * U - 85, top: 960 + (pos[1] + ISLAND.cy - HOME_Y) * U - 170, width: 170, display: 'grid', justifyItems: 'center', gap: 6, transform: `scale(${s})` }}>
                <Flag iso2={iso2(t.iso3)} height={50} />
                <div style={{ fontSize: t.count >= 1000 ? 36 : 44, fontWeight: 900, color: C.amber, background: 'rgba(10,29,43,0.85)', borderRadius: 10, padding: '0 10px', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.count)}</div>
              </div>
            );
          })}
        </>
      )}

      {scene === 'census' && c.display && (() => {
        const s = sp(st + 6, 12);
        return (
          <>
            <H k={`AVERAGE ${p.metricLabel.toUpperCase()}`} t="of your home countries" size={60} from={st} />
            <div style={{ position: 'absolute', top: 620, left: 60, right: 60, textAlign: 'center', transform: `scale(${0.6 + 0.4 * s})`, opacity: s }}>
              <div style={{ fontSize: c.display.length > 9 ? 170 : 200, fontWeight: 900, color: C.amber, lineHeight: 1, fontVariantNumeric: 'tabular-nums', textShadow: '0 8px 30px rgba(0,0,0,0.6)' }}>{c.display}</div>
              <div style={{ marginTop: 26, fontSize: 34, fontWeight: 700, color: C.muted }}>{fmt(c.covered)} citizens counted · World Bank {c.year}</div>
            </div>
          </>
        );
      })()}

      {scene === 'rank' && c.rank !== null && (
        <>
          <H k={`NATION ${p.metricLabel.toUpperCase()}`} t={`#${c.rank} in the world`} color={C.amber} size={96} from={st} />
          <div style={{ position: 'absolute', top: 640, left: 70, right: 70, display: 'grid', gap: 18 }}>
            {c.ladder.map((r, i) => {
              const s = sp(st + 8 + (r.us ? 30 : i * 5), 13);
              return (
                <div key={`${r.rank}-${r.iso3}`} style={{ ...row(r.us), gridTemplateColumns: '110px 70px 1fr auto', transform: r.us ? `translateX(${(1 - s) * 900}px)` : `translateY(${(1 - s) * 40}px)`, opacity: r.us ? 1 : s }}>
                  <div style={{ fontSize: 44, fontWeight: 900 }}>#{r.rank}</div>
                  {r.us ? <OurFlag flag={p.flag} h={44} /> : <Flag iso2={iso2(r.iso3)} height={44} />}
                  <div style={{ fontSize: r.name.length > 16 ? 34 : 42, fontWeight: 800, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.name}</div>
                  <div style={{ fontSize: 42, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{r.display}</div>
                </div>
              );
            })}
            <div style={{ fontSize: 28, color: C.muted, textAlign: 'center', marginTop: 6 }}>Average of our citizens' home countries · World Bank {c.year} · of {c.of + 1}</div>
          </div>
        </>
      )}

      {scene === 'target' && c.target && (() => {
        const s = sp(st + 30, 16);
        const card = sp(st + 8, 14);
        const sh = p.shape;
        return (
          <>
            <H k={c.passed ? `WE JUST PASSED ${c.passed.name.toUpperCase()}` : 'SMALLEST COUNTRIES BY POPULATION'} t={`Next: ${c.target.name}`} size={c.target.name.length > 14 ? 72 : 92} from={st} />
            <div style={{ position: 'absolute', top: 530, left: 90, right: 90, height: 520, background: 'rgba(10,29,43,0.9)', borderRadius: 22, boxShadow: `0 0 0 3px ${C.blue}`, opacity: card, transform: `translateY(${(1 - card) * 60}px)` }}>
              <div style={{ position: 'absolute', top: 26, left: 30, display: 'flex', gap: 18, alignItems: 'center' }}>
                <Flag iso2={iso2(c.target.iso3)} height={70} />
                <div>
                  <div style={{ fontSize: 46, fontWeight: 900 }}>{c.target.name}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: C.muted }}>{fmt(c.target.pop)} people</div>
                </div>
              </div>
              {sh && (
                <svg width={720} height={340} style={{ position: 'absolute', left: 90, top: 150 }} viewBox={`0 0 ${sh.w} ${sh.h}`}>
                  {sh.rings.map(([x, y, r], i) => {
                    const pop = spring({ frame: f - st - 16 - i * 3, fps, config: { damping: 10 } });
                    return <circle key={`r${i}`} cx={x} cy={y} r={r * pop} fill="none" stroke={C.amber} strokeWidth={2.5} strokeDasharray="5 5" opacity={pop} />;
                  })}
                  {sh.paths.map((d, i) => <path key={i} d={d} fill={C.blues[3]} stroke={C.pale} strokeWidth={2} opacity={sp(st + 12)} />)}
                </svg>
              )}
            </div>
            <div style={{ position: 'absolute', top: 1110, left: 70, right: 70, display: 'grid', gap: 14, opacity: s, background: 'rgba(10,29,43,0.85)', borderRadius: 18, padding: '18px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 36, fontWeight: 900 }}><span style={{ color: C.amber }}>Us {fmt(c.n)}</span><span>{c.target.name} {fmt(c.target.pop)}</span></div>
              <div style={{ height: 40, borderRadius: 20, background: 'rgba(111,179,224,0.18)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.max(3, Math.min(100, (c.n / c.target.pop) * 100) * s)}%`, background: C.amber, borderRadius: 20 }} /></div>
              <div style={{ fontSize: 24, color: C.muted, textAlign: 'center' }}>Population: World Bank {c.target.year} · map: Natural Earth</div>
            </div>
          </>
        );
      })()}

      {scene === 'voted' && c.result && (() => {
        const s = sp(st + 8, 11);
        return (
          <>
            <H k="YOU VOTED" t={c.result.key === 'flag' ? 'Our flag' : c.result.key === 'capital' ? 'Our capital' : `Our ${c.result.key === 'animal' ? 'national animal' : c.result.key === 'dish' ? 'national dish' : c.result.key === 'sport' ? 'national sport' : c.result.key}`} from={st} />
            <div style={{ position: 'absolute', top: 620, left: 80, right: 80, display: 'grid', justifyItems: 'center', gap: 34, transform: `scale(${0.6 + 0.4 * s})`, opacity: s }}>
              {c.result.key === 'flag' && <OurFlag flag={p.flag} h={220} />}
              <div style={{ fontSize: c.result.answer.length > 16 ? 76 : 100, fontWeight: 900, color: C.amber, textAlign: 'center', lineHeight: 1.05, textShadow: '0 8px 30px rgba(0,0,0,0.6)' }}>{c.result.answer}</div>
              <div style={{ fontSize: 34, fontWeight: 700, color: C.muted }}>{fmt(c.result.votes)} of {fmt(c.result.total)} votes</div>
            </div>
          </>
        );
      })()}

      {scene === 'cta' && (() => {
        const s = sp(st, 12);
        return (
          <>
            <H k="JOIN THE NATION" t="Get your passport" size={84} from={st} />
            <div style={{ position: 'absolute', top: 560, left: 150, right: 150, perspective: 1400 }}>
              <div style={{ transform: `rotateY(${(1 - s) * 90}deg)`, transformOrigin: 'left center', background: C.bg, borderRadius: 26, padding: '34px 42px', display: 'grid', gap: 16, boxShadow: `0 0 0 4px ${C.amber}, 0 30px 80px rgba(0,0,0,0.5)` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 6, color: C.blue }}>PASSPORT</div>
                  <OurFlag flag={p.flag} h={40} />
                </div>
                <div style={{ fontSize: 46, fontWeight: 900 }}>Per Capita Nation</div>
                <div style={{ fontSize: 64, fontWeight: 900, color: C.amber }}>#{pad(c.n + 1)}</div>
                {[['Name', 'You?'], ['Home', 'Your country'], ['Joins on', `Day ${c.day + 1}`]].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 34, borderTop: '2px solid rgba(111,179,224,0.2)', paddingTop: 12 }}><span style={{ color: C.muted }}>{k}</span><b>{v}</b></div>
                ))}
              </div>
              <div style={{ marginTop: 34, textAlign: 'center', opacity: sp(st + 20), display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 34, fontWeight: 900, color: C.amber }}>Link in our profile</div>
                {c.vote && <div style={{ fontSize: 30, fontWeight: 700, color: C.pale }}>{c.vote.open ? `Vote now: ${c.vote.question}` : `At ${fmt(c.vote.from)} citizens: vote on ${c.vote.topic}`}</div>}
              </div>
            </div>
          </>
        );
      })()}

      <Captions beats={p.beats} />
      <div style={{ position: 'absolute', top: 1470, left: 0, right: 0, textAlign: 'center', fontSize: 30, fontWeight: 700, color: C.muted }}>{p.handle}</div>
    </AbsoluteFill>
  );
};
