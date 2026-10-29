// The office floor on the studio page: one robot per agent, walking between desks, the coffee
// machine and the sofa according to the live status from /studio/api/live. The motion is all
// code; the art is either drawn here or, when office/art/manifest.json exists, the PNGs made on
// the GPU with tools/office-art (robots, desk and props). Missing art falls back to the drawing.
'use strict';
(() => {
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const T = (x, y, s, attrs = {}, parent) => { const t = el('text', { x, y, ...attrs }, parent); t.textContent = s; return t; };
const FONT = 'Inter, system-ui, sans-serif';

// Desks snake through the room in pipeline order, so a video visibly travels along them.
const DESK = { scout: [130, 330], writer: [310, 330], narrator: [490, 330], editor: [670, 330], checker: [670, 560], publisher: [490, 560], analyst: [310, 560] };
const NEXT = { writer: 'narrator', narrator: 'editor', editor: 'checker', checker: 'publisher' };
const CARRY = { writer: 'paper', narrator: 'tape', editor: 'film', checker: 'film' };
const BULB = { idle: '#9aa8b5', working: '#2fd38a', done: '#4fb3ff', waiting: '#f0b354', failed: '#ff5a45' };
const FREE_SPOTS = ['coffee', 'coffee2', 'cooler', 'cooler2', 'sofa1', 'sofa2', 'window', 'shelf', 'poster', 'plant'];
const GEAR = { scout: 'dish', writer: 'pencil', narrator: 'phones', editor: 'visor', checker: 'glasses', publisher: 'plane', analyst: 'chart' };
// Where each piece of GPU art goes (x, y, width, height of its box; drawn bottom-centred).
const PROP_BOX = {
  coffee: [862, 196, 160, 104], cooler: [1080, 196, 44, 112], rack: [1128, 244, 64, 128],
  sofa: [912, 580, 196, 76], plant: [776, 600, 56, 84], inbox: [72, 500, 56, 82], desk: [-58, -50, 116, 56],
};

// ---------- the walkable floor: lanes between the desks, joined into a graph ----------
const AISLE_A = 440, AISLE_B = 640, WALL = 248;
const nodes = {}, edges = {};
const node = (id, x, y) => { nodes[id] = { id, x, y }; edges[id] = edges[id] || []; };
const link = (a, b) => { edges[a].push(b); edges[b].push(a); };
for (const id in DESK) {
  const [x, y] = DESK[id];
  const row2 = y > 450;
  node(`seat-${id}`, x - 20, y - 14); node(`side-${id}`, x - 74, y - 14); link(`seat-${id}`, `side-${id}`);
  node(`a-${id}`, x - 74, AISLE_A); link(`side-${id}`, `a-${id}`);
  if (row2) { node(`b-${id}`, x - 74, AISLE_B); link(`side-${id}`, `b-${id}`); }
  else { node(`w-${id}`, x - 74, WALL); link(`side-${id}`, `w-${id}`); }
  node(`give-${id}`, x + 70, y + 6); node(`ga-${id}`, x + 70, row2 ? AISLE_B : AISLE_A); link(`give-${id}`, `ga-${id}`);
}
node('inbox', 150, 566); node('a-inbox', 150, AISLE_A); node('b-inbox', 150, AISLE_B); link('inbox', 'a-inbox'); link('inbox', 'b-inbox');
node('window', 80, WALL + 4); node('shelf', 320, WALL + 4); node('poster', 640, WALL + 4);
node('coffee', 905, 312); node('a-coffee', 905, AISLE_A); link('coffee', 'a-coffee');
node('coffee2', 960, 318); node('a-coffee2', 960, AISLE_A); link('coffee2', 'a-coffee2');
node('cooler', 1078, 318); node('cooler2', 1040, 322); node('a-cooler', 1060, AISLE_A); link('cooler', 'a-cooler'); link('cooler2', 'a-cooler');
node('sofa1', 975, 618); node('sofa2', 1045, 618); node('a-sofa1', 975, AISLE_A); node('a-sofa2', 1045, AISLE_A); link('sofa1', 'a-sofa1'); link('sofa2', 'a-sofa2');
node('plant', 800, 662); node('b-plant', 800, AISLE_B); link('plant', 'b-plant');
node('c-w', 830, WALL); node('c-a', 830, AISLE_A); node('c-b', 830, AISLE_B); link('c-w', 'c-a'); link('c-a', 'c-b');
for (const lane of [AISLE_A, AISLE_B, WALL]) {
  const on = Object.values(nodes).filter((n) => Math.abs(n.y - lane) < 6).sort((p, q) => p.x - q.x);
  for (let i = 1; i < on.length; i++) link(on[i - 1].id, on[i].id);
}
function route(from, to) {
  let start = null, best = Infinity;
  for (const n of Object.values(nodes)) { const d = Math.hypot(n.x - from.x, n.y - from.y); if (d < best) { best = d; start = n.id; } }
  const dist = { [start]: 0 }, prev = {}, open = new Set([start]);
  while (open.size) {
    let u = null; for (const v of open) if (u == null || dist[v] < dist[u]) u = v;
    open.delete(u);
    if (u === to) break;
    for (const v of edges[u]) {
      const d = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
      if (dist[v] == null || d < dist[v]) { dist[v] = d; prev[v] = u; open.add(v); }
    }
  }
  const path = [];
  for (let v = to; v; v = prev[v]) { path.unshift(nodes[v]); if (v === start) break; }
  return path;
}

function create(svg, { crew, onSelect, tz = () => undefined, artBase = 'office/art/' }) {
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLOR = Object.fromEntries(crew.map((c) => [c.id, c.color]));
  const NAME = Object.fromEntries(crew.map((c) => [c.id, c.name]));
  svg.setAttribute('viewBox', '0 0 1200 700');
  let art = { robots: {}, props: {} };

  // ---------- the room ----------
  el('defs', {}, svg).innerHTML = `
    <pattern id="of-wood" width="320" height="44" patternUnits="userSpaceOnUse"><rect width="320" height="44" fill="#bd8c5e"/><rect y="22" width="320" height="22" fill="#b5835a"/><path d="M0 21.5H320M0 43.5H320M210 0V22M90 22V44" stroke="#a2714a" stroke-width="1.2"/></pattern>
    <pattern id="of-tiles" width="36" height="36" patternUnits="userSpaceOnUse"><rect width="36" height="36" fill="#d9d2c4"/><path d="M0 35.5H36M35.5 0V36" stroke="#c8bfae"/></pattern>
    <linearGradient id="of-wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe7ee"/><stop offset="1" stop-color="#cbd6e0"/></linearGradient>
    <radialGradient id="of-lamp" cx=".5" cy="0" r=".9"><stop offset="0" stop-color="#fff6d8" stop-opacity=".3"/><stop offset="1" stop-color="#fff6d8" stop-opacity="0"/></radialGradient>
    <clipPath id="of-win"><rect x="34" y="48" width="134" height="134"/></clipPath>`;
  el('rect', { width: 1200, height: 230, fill: 'url(#of-wall)' }, svg);
  el('rect', { y: 222, width: 1200, height: 10, fill: '#8a6a50' }, svg);
  el('rect', { y: 232, width: 850, height: 468, fill: 'url(#of-wood)' }, svg);
  el('rect', { x: 850, y: 232, width: 350, height: 468, fill: 'url(#of-tiles)' }, svg);
  el('rect', { x: 846, y: 232, width: 6, height: 468, fill: '#8a6a50', opacity: .5 }, svg);
  el('rect', { x: 230, y: 470, width: 540, height: 130, rx: 10, fill: '#3f6f8f', opacity: .22 }, svg);

  // window: the sky follows the clock in your time zone
  el('rect', { x: 26, y: 40, width: 150, height: 150, rx: 6, fill: '#8a6a50' }, svg);
  const sky = el('rect', { x: 34, y: 48, width: 134, height: 134, fill: '#9fd0f0' }, svg);
  const sun = el('circle', { cx: 130, cy: 90, r: 14, fill: '#ffe08a' }, svg);
  const hills = el('path', { d: 'M34 160 l30 -30 l26 18 l30 -34 l48 46 v22 h-134z', fill: '#6f9f80', opacity: .8 }, svg);
  const view = el('image', { x: 34, y: 48, width: 134, height: 134, preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#of-win)', visibility: 'hidden' }, svg);
  el('path', { d: 'M101 48v134M34 115h134', stroke: '#8a6a50', 'stroke-width': 5 }, svg);

  // Decor only: the real wall TV and whiteboard sit above the office on the page.
  // bookshelf
  el('rect', { x: 236, y: 60, width: 168, height: 150, rx: 4, fill: '#8a5a3c' }, svg);
  for (let r = 0; r < 3; r++) {
    el('rect', { x: 244, y: 68 + r * 47, width: 152, height: 39, fill: '#5b3d26' }, svg);
    let x = 248;
    for (let k = 0; x < 380; k++) {
      const w = 9 + ((r * 7 + k * 5) % 8), h = 26 + ((r * 3 + k * 11) % 12);
      el('rect', { x, y: 107 + r * 47 - h, width: w, height: h, rx: 1.5, fill: ['#4f98c6', '#e0a03c', '#6f9f80', '#c86b5a', '#7d6bb5', '#e9eef3'][(r + k) % 6] }, svg);
      x += w + 2;
    }
  }
  // framed world map poster, the channel's own subject
  el('rect', { x: 470, y: 46, width: 330, height: 156, rx: 4, fill: '#2a3b4c' }, svg);
  el('rect', { x: 480, y: 56, width: 310, height: 136, fill: '#d9ecf7' }, svg);
  el('path', { d: 'M512 92 q20-18 52-10 q14 10 4 26 q-8 14-26 12 q-6 22-18 26 q-8-20-18-30 q-6-14 6-24z M566 140 q14-4 20 10 q6 22-8 36 q-12-10-14-24 q-4-14 2-22z M618 84 q24-14 50-4 q26-2 50 10 q22 6 26 24 q-10 10-30 6 q-6 18-24 20 q-18-8-26 4 q-14-2-16-18 q-10-6-20 2 q-12-8-12-22 q-10-10 2-22z M650 132 q14-2 18 12 q2 16-10 24 q-12-6-12-20z M722 152 q16-6 30 2 q4 14-12 18 q-16-2-18-20z', fill: '#e0a03c', stroke: '#c48a2e', 'stroke-width': 1 }, svg);
  T(635, 216, 'PER CAPITA MAPS', { 'text-anchor': 'middle', 'font-size': 9, fill: '#5b6b7c', 'font-family': FONT, 'font-weight': 700, 'letter-spacing': 1.5 }, svg);

  // digital wall clock
  const clock = el('g', { transform: 'translate(960,70)' }, svg);
  el('rect', { x: -62, y: -30, width: 124, height: 68, rx: 10, fill: '#0e1822', stroke: '#2a3b4c', 'stroke-width': 3 }, clock);
  el('rect', { x: -54, y: -22, width: 108, height: 52, rx: 5, fill: '#08121a' }, clock);
  const clockHm = T(0, 14, '--:--', { 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 800, fill: '#7ef0d0', 'font-family': FONT, 'font-variant-numeric': 'tabular-nums', 'letter-spacing': 1 }, clock);
  const clockDay = T(0, 28, '', { 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#3fa58c', 'font-family': FONT, 'letter-spacing': 1.5 }, clock);
  T(0, 54, 'YOUR TIME', { 'text-anchor': 'middle', 'font-size': 9, fill: '#5b6b7c', 'font-family': FONT, 'font-weight': 700, 'letter-spacing': 1 }, clock);

  for (const x of [220, 580]) {
    el('rect', { x: x - 1, y: 0, width: 2, height: 18, fill: '#5b6b7c' }, svg);
    el('path', { d: `M${x - 16} 30 q16 -18 32 0z`, fill: '#2a3b4c' }, svg);
    el('ellipse', { cx: x, cy: 380, rx: 190, ry: 150, fill: 'url(#of-lamp)' }, svg);
  }

  // Everything on the floor shares one layer, re-sorted by foot position so nearer is in front.
  const floor = el('g', {}, svg);
  const sortables = [];
  const place = (g, footY) => { g.dataset.y = footY; floor.appendChild(g); sortables.push(g); return g; };
  // A prop is drawn here and swapped for its GPU art once that loads.
  const props = {};
  const prop = (name, footY, draw) => {
    const g = el('g', {});
    const drawn = el('g', {}, g); draw(drawn);
    const img = el('image', { visibility: 'hidden', preserveAspectRatio: 'xMidYMax meet' }, g);
    const [x, y, w, h] = PROP_BOX[name];
    Object.assign(img.dataset, { x, y, w, h });
    props[name] = [...(props[name] || []), { drawn, img }];
    return place(g, footY);
  };

  prop('coffee', 298, (g) => {
    el('rect', { x: 870, y: 252, width: 140, height: 46, fill: '#6e7d8c' }, g);
    el('rect', { x: 864, y: 244, width: 152, height: 12, rx: 3, fill: '#e9eef3' }, g);
    el('rect', { x: 890, y: 208, width: 36, height: 38, rx: 4, fill: '#2a3b4c' }, g);
    el('rect', { x: 896, y: 214, width: 24, height: 8, rx: 2, fill: '#7ef0d0' }, g);
    el('rect', { x: 902, y: 230, width: 12, height: 12, rx: 2, fill: '#fff' }, g);
    el('rect', { x: 950, y: 226, width: 40, height: 20, rx: 3, fill: '#c86b5a' }, g);
  });
  const steam = el('g', { opacity: 0 }, svg);
  for (let i = 0; i < 3; i++) el('path', { d: `M${902 + i * 6} 206 q-4 -8 0 -16 q4 -8 0 -16`, stroke: '#fff', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }, steam);
  prop('cooler', 308, (g) => {
    el('rect', { x: 1086, y: 250, width: 30, height: 56, rx: 4, fill: '#e9eef3', stroke: '#b9c4cf' }, g);
    el('rect', { x: 1090, y: 208, width: 22, height: 42, rx: 8, fill: '#9fd0f0', opacity: .85 }, g);
  });
  const rackLights = [];
  prop('rack', 372, (g) => {
    el('rect', { x: 1132, y: 250, width: 56, height: 120, rx: 4, fill: '#1d2433' }, g);
    for (let i = 0; i < 6; i++) el('rect', { x: 1138, y: 258 + i * 18, width: 44, height: 12, rx: 2, fill: '#2a3446' }, g);
  });
  const rackOverlay = el('g', {}, svg);
  for (let i = 0; i < 6; i++) rackLights.push(el('circle', { cx: 1174, cy: 264 + i * 18, r: 2.6, fill: '#3b4a5e' }, rackOverlay));
  const rackLabel = T(1160, 394, '', { 'font-size': 10, 'text-anchor': 'middle', fill: '#12263a', 'font-family': FONT, 'font-weight': 700 }, rackOverlay);
  prop('sofa', 654, (g) => {
    el('rect', { x: 930, y: 590, width: 160, height: 34, rx: 10, fill: '#3f6f8f' }, g);
    el('rect', { x: 924, y: 618, width: 172, height: 36, rx: 10, fill: '#4f86a8' }, g);
    el('rect', { x: 916, y: 604, width: 20, height: 50, rx: 8, fill: '#3f6f8f' }, g);
    el('rect', { x: 1084, y: 604, width: 20, height: 50, rx: 8, fill: '#3f6f8f' }, g);
  });
  prop('plant', 684, (g) => {
    el('path', { d: 'M786 680 h32 l-4 -24 h-24z', fill: '#c86b5a' }, g);
    for (const [dx, h] of [[-14, 30], [-4, 44], [8, 38], [16, 26]]) el('ellipse', { cx: 802 + dx, cy: 656 - h / 2, rx: 7, ry: h / 2, fill: '#5a8f6c', transform: `rotate(${dx * 1.5} ${802 + dx} 656)` }, g);
  });
  prop('inbox', 582, (g) => {
    el('rect', { x: 96, y: 528, width: 4, height: 50, fill: '#5b6b7c' }, g);
    el('rect', { x: 80, y: 510, width: 40, height: 22, rx: 6, fill: '#2f78a6' }, g);
  });
  const inboxFlag = el('rect', { x: 118, y: 506, width: 4, height: 18, fill: '#d0533f' }, svg);
  const labels = el('g', { 'font-size': 9, 'text-anchor': 'middle', 'font-family': FONT, 'font-weight': 700, 'letter-spacing': 1, fill: '#2a3b4c' }, svg);
  T(908, 192, 'COFFEE', {}, labels); T(1101, 192, 'WATER', {}, labels); T(1160, 240, 'SERVER', {}, labels);
  T(100, 598, 'YOUR OK', { fill: '#fff' }, labels);

  // desks: code-drawn monitor on top of the desk (drawn or GPU art)
  const desks = {};
  for (const c of crew) {
    const [x, y] = DESK[c.id];
    const g = el('g', { transform: `translate(${x},${y})` });
    const drawn = el('g', {}, g);
    el('rect', { x: -56, y: -44, width: 112, height: 12, rx: 3, fill: '#8a5a3c' }, drawn);
    el('rect', { x: -52, y: -32, width: 104, height: 30, fill: '#6e452c' }, drawn);
    el('rect', { x: -50, y: -2, width: 6, height: 6, fill: '#4b2f1e' }, drawn);
    el('rect', { x: 44, y: -2, width: 6, height: 6, fill: '#4b2f1e' }, drawn);
    const img = el('image', { visibility: 'hidden', preserveAspectRatio: 'xMidYMax meet' }, g);
    Object.assign(img.dataset, { x: PROP_BOX.desk[0], y: PROP_BOX.desk[1], w: PROP_BOX.desk[2], h: PROP_BOX.desk[3] });
    props.desk = [...(props.desk || []), { drawn, img }];
    el('rect', { x: 28, y: -54, width: 6, height: 10, fill: '#2a3b4c' }, g);
    el('rect', { x: 6, y: -88, width: 50, height: 36, rx: 4, fill: '#1d2433' }, g);
    const screen = el('g', {}, g);
    el('rect', { x: -40, y: -50, width: 26, height: 6, rx: 2, fill: '#cfd8e2' }, g);
    const plate = el('g', { transform: 'translate(0,20)' }, g);
    el('rect', { x: -48, y: -10, width: 96, height: 18, rx: 9, fill: 'rgba(18,38,58,.78)' }, plate);
    el('circle', { cx: -36, cy: -1, r: 4, fill: c.color }, plate);
    T(-28, 3, c.name.toUpperCase(), { 'font-size': 10, fill: '#fff', 'font-family': FONT, 'letter-spacing': 1, 'font-weight': 700 }, plate);
    desks[c.id] = { screen, key: '' };
    place(g, y + 4);
  }

  // ---------- robots ----------
  const agents = {}, bots = {};
  let simT = 0, steamUntil = 0, selected = null;
  const taken = {};

  function robot(c) {
    const g = el('g', { class: 'robot', tabindex: 0, role: 'button', 'aria-label': `${c.name}, ${c.role}` });
    const ring = el('ellipse', { cx: 0, cy: 0, rx: 24, ry: 7, fill: 'none', stroke: '#ffd36b', 'stroke-width': 3, visibility: 'hidden' }, g);
    const body = el('g', {}, g);
    const shadow = el('ellipse', { cx: 0, cy: 0, rx: 17, ry: 4.5, fill: 'rgba(0,0,0,.22)' }, body);
    const legs = el('g', {}, body);
    const legL = el('rect', { x: -10, y: -14, width: 7, height: 14, rx: 3, fill: '#3a4150' }, legs);
    const legR = el('rect', { x: 3, y: -14, width: 7, height: 14, rx: 3, fill: '#3a4150' }, legs);
    const tilt = el('g', {}, body);
    const armL = el('g', {}, tilt);
    const drawn = el('g', {}, tilt);
    const sprite = el('image', { x: -30, y: -84, width: 60, height: 76, preserveAspectRatio: 'xMidYMax meet', visibility: 'hidden' }, tilt);
    const armR = el('g', {}, tilt);
    // arms: a rounded limb for the drawn robot, a floating hand for the GPU sprite
    for (const [arm, x] of [[armL, -22], [armR, 15]]) {
      el('rect', { class: 'limb', x, y: -36, width: 7, height: 17, rx: 3.5, fill: c.color, stroke: 'rgba(0,0,0,.15)' }, arm);
      el('circle', { class: 'hand', cx: x + 3.5, cy: -18, r: 5, fill: c.color, stroke: 'rgba(0,0,0,.25)', visibility: 'hidden' }, arm);
    }
    el('rect', { x: -16, y: -40, width: 32, height: 28, rx: 9, fill: c.color, stroke: 'rgba(0,0,0,.12)' }, drawn);
    el('rect', { x: -8, y: -33, width: 16, height: 9, rx: 2.5, fill: 'rgba(255,255,255,.4)' }, drawn);
    const chest = el('circle', { cx: 0, cy: -28.5, r: 2.4, fill: '#fff' }, drawn);
    el('line', { x1: 0, y1: -64, x2: 0, y2: -73, stroke: '#3a4150', 'stroke-width': 2 }, drawn);
    el('rect', { x: -17, y: -66, width: 34, height: 26, rx: 10, fill: '#eef2f6', stroke: 'rgba(0,0,0,.12)' }, drawn);
    el('rect', { x: -13, y: -62, width: 26, height: 18, rx: 6, fill: '#1d2433' }, drawn);
    const face = el('g', {}, drawn);
    const gear = GEAR[c.id];
    if (gear === 'phones') { el('path', { d: 'M-18 -50 q0 -22 18 -22 q18 0 18 22', stroke: '#2a3b4c', 'stroke-width': 3, fill: 'none' }, drawn); el('rect', { x: -21, y: -56, width: 7, height: 12, rx: 3, fill: '#2a3b4c' }, drawn); el('rect', { x: 14, y: -56, width: 7, height: 12, rx: 3, fill: '#2a3b4c' }, drawn); }
    if (gear === 'dish') el('path', { d: 'M4 -78 q8 -2 10 -10 q-10 0 -10 10z', fill: '#cfd8e2', stroke: '#3a4150' }, drawn);
    if (gear === 'glasses') { el('circle', { cx: -6, cy: -52, r: 6, fill: 'none', stroke: '#f0c879', 'stroke-width': 1.6 }, drawn); el('circle', { cx: 6, cy: -52, r: 6, fill: 'none', stroke: '#f0c879', 'stroke-width': 1.6 }, drawn); }
    if (gear === 'visor') el('rect', { x: -17, y: -68, width: 34, height: 5, rx: 2.5, fill: '#1d2433' }, drawn);
    if (gear === 'pencil') el('rect', { x: 14, y: -72, width: 3, height: 16, rx: 1, fill: '#f0c879', transform: 'rotate(20 15 -64)' }, drawn);
    if (gear === 'plane') el('path', { d: 'M-6 -27 l12 -5 l-4 10 l-2 -4z', fill: '#fff' }, drawn);
    if (gear === 'chart') for (let i = 0; i < 3; i++) el('rect', { x: -6 + i * 4.5, y: -26 - i * 2.5, width: 3, height: 3 + i * 2.5, fill: '#fff' }, drawn);
    const bulb = el('circle', { cx: 0, cy: -75, r: 4, fill: BULB.idle }, tilt);
    const item = el('g', {}, tilt);
    const fx = el('g', {}, g);
    const bubble = el('g', { visibility: 'hidden' }, g);
    const bRect = el('rect', { x: 0, y: -124, height: 30, rx: 10, fill: '#fff', stroke: 'rgba(18,38,58,.18)' }, bubble);
    el('path', { d: 'M-6 -95 l6 9 l6 -9z', fill: '#fff' }, bubble);
    const bDot = el('circle', { cx: 0, cy: -109, r: 4 }, bubble);
    const bText = T(0, -105, '', { 'font-size': 12, fill: '#12263a', 'font-family': FONT, 'font-weight': 700 }, bubble);
    return { g, ring, body, shadow, legs, legL, legR, tilt, armL, armR, drawn, sprite, bulb, chest, face, item, fx, bubble, bRect, bDot, bText };
  }

  function useArt(b, href) {
    b.art = !!href;
    if (href) b.sprite.setAttribute('href', href);
    b.sprite.setAttribute('visibility', href ? 'visible' : 'hidden');
    for (const n of [b.drawn, b.legs]) n.setAttribute('visibility', href ? 'hidden' : 'visible');
    b.g.querySelectorAll('.limb').forEach((n) => n.setAttribute('visibility', href ? 'hidden' : 'visible'));
    b.g.querySelectorAll('.hand').forEach((n) => n.setAttribute('visibility', href ? 'visible' : 'hidden'));
    b.bulb.setAttribute('cy', href ? -90 : -75);
  }

  function setFace(b, mood) {
    if (b.mood === mood) return;
    b.mood = mood; b.face.innerHTML = ''; b.eyes = null;
    const eye = mood === 'failed' ? '#ff6b57' : mood === 'waiting' ? '#f0c879' : '#7ef0d0';
    if (mood === 'done') el('path', { d: 'M-8 -51 l3 -4 l3 4M2 -51 l3 -4 l3 4', stroke: eye, 'stroke-width': 2.2, fill: 'none', 'stroke-linecap': 'round' }, b.face);
    else if (mood === 'failed') el('path', { d: 'M-8 -57 l5 5M-3 -57 l-5 5M3 -57 l5 5M8 -57 l-5 5', stroke: eye, 'stroke-width': 2, 'stroke-linecap': 'round' }, b.face);
    else {
      b.eyes = el('g', {}, b.face);
      const y = mood === 'waiting' ? -59 : -57;
      el('rect', { x: -8, y, width: 5, height: 7, rx: 2.5, fill: eye }, b.eyes);
      el('rect', { x: 3, y, width: 5, height: 7, rx: 2.5, fill: eye }, b.eyes);
    }
    el('path', { d: mood === 'failed' ? 'M-4 -46 q4 -3 8 0' : 'M-4 -47 q4 3 8 0', stroke: eye, 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round' }, b.face);
  }

  function setItem(b, kind) {
    b.itemKind = kind; b.item.innerHTML = '';
    if (!kind) return;
    const g = el('g', { transform: b.art ? 'translate(18,-22)' : 'translate(14,-26)' }, b.item);
    if (kind === 'mug') { el('rect', { x: 0, y: -8, width: 10, height: 10, rx: 2, fill: '#fff', stroke: '#9aa8b5' }, g); el('path', { d: 'M10 -5 q5 0 5 3 q0 3 -5 3', stroke: '#9aa8b5', fill: 'none' }, g); }
    if (kind === 'paper' || kind === 'note') { el('rect', { x: -2, y: -14, width: 14, height: 18, rx: 1.5, fill: kind === 'note' ? '#fdeeb5' : '#fff', stroke: '#9aa8b5' }, g); for (let i = 0; i < 3; i++) el('rect', { x: 1, y: -10 + i * 4, width: 8, height: 1.5, fill: '#9aa8b5' }, g); }
    if (kind === 'tape') { el('rect', { x: -2, y: -9, width: 16, height: 11, rx: 2, fill: '#2a3b4c' }, g); el('circle', { cx: 3, cy: -4, r: 2.5, fill: '#cfd8e2' }, g); el('circle', { cx: 9, cy: -4, r: 2.5, fill: '#cfd8e2' }, g); }
    if (kind === 'film') { el('circle', { cx: 6, cy: -4, r: 8, fill: '#2a3b4c' }, g); for (let i = 0; i < 4; i++) el('circle', { cx: 6 + 4 * Math.cos(i * 1.57), cy: -4 + 4 * Math.sin(i * 1.57), r: 1.6, fill: '#cfd8e2' }, g); }
    if (kind === 'phone') { el('rect', { x: 0, y: -16, width: 9, height: 15, rx: 2, fill: '#1d2433' }, g); el('rect', { x: 1.5, y: -14, width: 6, height: 9, fill: '#7fbde6' }, g); }
  }

  const claim = (b, spot) => { if (b.spot && taken[b.spot] === b.id) delete taken[b.spot]; b.spot = spot; if (spot) taken[spot] = b.id; };
  const poseFor = (spot) => spot?.startsWith('sofa') ? 'sit' : spot?.startsWith('coffee') ? 'mug' : 'stand';
  const go = (b, spot) => b.queue.push({ do: 'go', spot });

  function plan(id, handoff) {
    const a = agents[id], b = bots[id];
    b.queue = []; b.path = []; b.waitUntil = 0;
    if (a.state !== 'done' && a.state !== 'idle') setItem(b, null);
    if (a.state === 'working') { go(b, `seat-${id}`); b.queue.push({ do: 'wait', sec: Infinity, pose: 'type' }); }
    else if (a.state === 'waiting' && id === 'publisher') { go(b, 'inbox'); b.queue.push({ do: 'item', kind: 'phone' }, { do: 'wait', sec: Infinity, pose: 'phone' }); }
    else if (a.state === 'waiting') { go(b, `seat-${id}`); b.queue.push({ do: 'wait', sec: Infinity, pose: 'sitIdle' }); }
    else if (a.state === 'failed') { go(b, `seat-${id}`); b.queue.push({ do: 'wait', sec: Infinity, pose: 'broken' }); }
    else if (a.state === 'done' && handoff) {
      b.queue.push({ do: 'wait', sec: 2.2, pose: b.pose === 'type' ? 'sitIdle' : 'stand' });
      if (id === 'scout') { b.queue.push({ do: 'item', kind: 'note' }); go(b, 'give-writer'); b.queue.push({ do: 'wait', sec: 1.2, pose: 'reach' }, { do: 'item', kind: null }); }
      else if (NEXT[id]) { b.queue.push({ do: 'item', kind: CARRY[id] }); go(b, `give-${NEXT[id]}`); b.queue.push({ do: 'wait', sec: 1.4, pose: 'reach' }, { do: 'item', kind: null }); }
      b.queue.push({ do: 'wander' });
    } else b.queue.push({ do: 'wander' });
  }

  function wander(b) {
    const free = FREE_SPOTS.filter((s) => !taken[s] || taken[s] === b.id);
    const spot = free[Math.floor(Math.random() * free.length)] || 'plant';
    claim(b, spot);
    if (spot.startsWith('coffee')) {
      go(b, spot);
      b.queue.push({ do: 'wait', sec: 2.4, pose: 'reach', steam: true }, { do: 'item', kind: 'mug' });
      const sofa = !taken.sofa1 ? 'sofa1' : !taken.sofa2 ? 'sofa2' : null;
      if (sofa && Math.random() < .5) { go(b, sofa); b.queue.push({ do: 'claim', spot: sofa }); }
      b.queue.push({ do: 'wait', sec: 6 + Math.random() * 6, pose: 'auto' }, { do: 'item', kind: null }, { do: 'wander' });
      return;
    }
    go(b, spot);
    b.queue.push({ do: 'wait', sec: 5 + Math.random() * 8, pose: poseFor(spot) }, { do: 'wander' });
  }

  // Jump straight to where the queue would end up: page load and reduced motion.
  function settle(b) {
    for (let guard = 0; guard < 40 && b.queue.length; guard++) {
      const job = b.queue[0];
      if (job.do === 'wait' && job.sec === Infinity) { step(b, 0); break; }
      if (job.do === 'wander') { b.queue.shift(); wander(b); const n = nodes[b.spot]; b.x = n.x; b.y = n.y; b.queue = []; b.pose = poseFor(b.spot); b.waitUntil = simT + 4 + Math.random() * 10; b.queue.push({ do: 'wander' }); break; }
      b.queue.shift();
      if (job.do === 'go') { const n = nodes[job.spot]; b.x = n.x; b.y = n.y; b.target = job.spot; }
      else if (job.do === 'item') setItem(b, job.kind);
    }
    b.path = [];
  }

  function step(b, dt) {
    if (b.path.length) {
      const t = b.path[0];
      const dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy), v = 95 * dt;
      if (Math.abs(dx) > .5) b.dir = dx > 0 ? 1 : -1;
      if (d <= v) { b.x = t.x; b.y = t.y; b.path.shift(); } else { b.x += dx / d * v; b.y += dy / d * v; }
      b.pose = 'walk';
      return;
    }
    if (b.waitUntil > simT) return;
    const job = b.queue.shift();
    if (!job) { if (agents[b.id].state === 'idle' || agents[b.id].state === 'done') b.queue.push({ do: 'wander' }); return; }
    if (job.do === 'go') {
      if (!FREE_SPOTS.includes(job.spot)) claim(b, null);
      b.path = REDUCED ? [nodes[job.spot]] : route(b, job.spot);
      if (REDUCED) { b.x = nodes[job.spot].x; b.y = nodes[job.spot].y; b.path = []; }
      b.target = job.spot;
    } else if (job.do === 'wait') {
      b.waitUntil = simT + job.sec;
      b.pose = job.pose === 'auto' ? poseFor(b.target) : job.pose;
      if (b.target?.startsWith('seat')) b.dir = 1;
      if (b.target?.startsWith('give')) b.dir = -1;
      if (job.steam) steamUntil = simT + job.sec;
    } else if (job.do === 'item') setItem(b, job.kind);
    else if (job.do === 'claim') claim(b, job.spot);
    else if (job.do === 'wander') wander(b);
  }

  function bubbleText(a) {
    if (a.state === 'idle') return null;
    if (a.state === 'done' && simT - (a.simSince ?? -99) > 4) return null;
    let s = a.text || '';
    if (a.llm) s = a.llm.phase === 'reading' ? 'Reading the brief…' : `Writing · ${a.llm.tokens} tokens`;
    else if (a.progress != null && a.state === 'working') s = `${Math.round(a.progress * 100)}% · ${s.replace(/^#\d+ · /, '')}`;
    if (a.job && !s.includes(`#${a.job}`)) s = `#${a.job} · ${s}`;
    if (a.state === 'done') s = `✓ ${s}`;
    return s.length > 36 ? `${s.slice(0, 35)}…` : s;
  }

  function draw(b) {
    const a = agents[b.id];
    const t = simT + b.phase;
    let bob = 0, legL = 0, legR = 0, armL = 0, armR = 0, tilt = 0;
    if (b.pose === 'walk') {
      const s = Math.sin(t * 11);
      legL = s * 22; legR = -s * 22; armL = -s * 18; armR = s * 18;
      bob = Math.abs(Math.cos(t * 11)) * -2.5;
      if (b.art) tilt = s * 4; // the sprite has no legs to swing, so it waddles instead
    } else if (b.pose === 'type') { armL = -50 + Math.sin(t * 18) * 10; armR = -50 + Math.cos(t * 17) * 10; bob = Math.sin(t * 3) * .6; }
    else if (b.pose === 'phone' || b.pose === 'mug' || b.pose === 'reach') { armR = -70; armL = Math.sin(t * 2) * 4; bob = Math.sin(t * 2.4) * .8; if (b.pose === 'phone') bob += Math.max(0, Math.sin(t * 6)) * -2; }
    else if (b.pose === 'broken') { tilt = Math.sin(t * 25) * 1.5; armL = 30; armR = -20; }
    else if (b.pose === 'sit') { bob = 6; armR = b.itemKind ? -60 : 0; }
    else { bob = Math.sin(t * 2) * .8; if (b.itemKind) armR = -60; }
    if (b.art && b.pose !== 'sit') bob += Math.sin(t * 3.2) * 1.6 - 3; // hover
    b.g.setAttribute('transform', `translate(${b.x.toFixed(1)},${b.y.toFixed(1)})`);
    b.body.setAttribute('transform', `scale(${b.dir},1)`);
    b.legL.setAttribute('transform', `rotate(${legL.toFixed(1)} -6.5 -14)`);
    b.legR.setAttribute('transform', `rotate(${legR.toFixed(1)} 6.5 -14)`);
    b.tilt.setAttribute('transform', `translate(0,${bob.toFixed(2)}) rotate(${tilt.toFixed(2)})`);
    b.armL.setAttribute('transform', `rotate(${armL.toFixed(1)} -18.5 -33)`);
    b.armR.setAttribute('transform', `rotate(${armR.toFixed(1)} 18.5 -33)`);
    const blink = a.state === 'working' || a.state === 'failed' ? (Math.sin(t * 6) > 0 ? 1 : .45) : 1;
    b.bulb.setAttribute('fill', BULB[a.state]); b.bulb.setAttribute('opacity', blink);
    b.chest.setAttribute('fill', BULB[a.state]);
    if (b.eyes) { if (Math.sin(t * 1.3) > .985) b.eyes.setAttribute('transform', 'translate(0,-53) scale(1,.15) translate(0,53)'); else b.eyes.removeAttribute('transform'); }
    b.g.dataset.y = b.y;
    b.fx.innerHTML = '';
    if (a.state === 'failed') for (let i = 0; i < 3; i++) { const p = (simT * .8 + i / 3) % 1; el('circle', { cx: 8 + Math.sin(p * 6 + i) * 6, cy: -72 - p * 40, r: 4 + p * 8, fill: '#6b6f78', opacity: ((1 - p) * .55).toFixed(2) }, b.fx); }
    if (a.state === 'working' && b.id === 'narrator' && b.pose === 'type') for (let i = 0; i < 3; i++) { const p = (simT * 1.2 + i / 3) % 1; el('path', { d: `M${20 + p * 22} ${-70 - p * 6} q${6 + p * 4} ${8 + p * 6} 0 ${16 + p * 12}`, stroke: '#6f9f80', 'stroke-width': 2, fill: 'none', opacity: (1 - p).toFixed(2) }, b.fx); }
    if (b.pose === 'sit' && a.state === 'idle' && !b.itemKind) { const p = (simT * .5) % 1; T(14 + p * 8, -72 - p * 18, 'z', { 'font-size': 10 + p * 6, fill: '#fff', opacity: (1 - p).toFixed(2), 'font-weight': 800, 'font-family': FONT }, b.fx); }
    const txt = bubbleText(a);
    b.bubble.setAttribute('visibility', txt ? 'visible' : 'hidden');
    if (txt && b.bText.textContent !== txt) {
      b.bText.textContent = txt;
      const w = Math.max(70, txt.length * 6.6 + 34);
      let x0 = -w / 2;
      const left = b.x + x0, right = left + w;
      if (left < 8) x0 += 8 - left;
      if (right > 1192) x0 -= right - 1192;
      b.bRect.setAttribute('x', x0); b.bRect.setAttribute('width', w);
      b.bDot.setAttribute('cx', x0 + 14); b.bText.setAttribute('x', x0 + 24);
    }
    if (txt) b.bDot.setAttribute('fill', BULB[a.state]);
  }

  function paintScreen(id) {
    const a = agents[id], d = desks[id];
    const key = `${a.state}|${a.progress == null ? '' : Math.round(a.progress * 100)}`;
    if (d.key === key) return;
    d.key = key; d.screen.innerHTML = '';
    if (a.state === 'idle' || a.state === 'done') {
      el('rect', { x: 10, y: -84, width: 42, height: 28, rx: 2, fill: '#22303f' }, d.screen);
      T(31, -66, 'PCM', { 'font-size': 9, 'text-anchor': 'middle', fill: '#4b5d70', 'font-family': FONT, 'font-weight': 800 }, d.screen);
      return;
    }
    el('rect', { x: 10, y: -84, width: 42, height: 28, rx: 2, fill: a.state === 'failed' ? '#5a1f1a' : a.state === 'waiting' ? '#4a3a16' : '#123a2e' }, d.screen);
    if (a.progress != null && a.state === 'working') {
      el('rect', { x: 14, y: -72, width: 34, height: 6, rx: 3, fill: '#1f5a46' }, d.screen);
      el('rect', { x: 14, y: -72, width: 34 * a.progress, height: 6, rx: 3, fill: '#7ef0d0' }, d.screen);
      T(31, -61, `${Math.round(a.progress * 100)}%`, { 'font-size': 8, 'text-anchor': 'middle', fill: '#7ef0d0', 'font-family': FONT, 'font-weight': 700 }, d.screen);
    } else {
      const col = a.state === 'failed' ? '#ff9a8a' : a.state === 'waiting' ? '#f0c879' : '#7ef0d0';
      const lines = el('g', { class: 'scroll' }, d.screen);
      for (let i = 0; i < 4; i++) el('rect', { x: 14, y: -80 + i * 6, width: 10 + ((i * 13 + id.length * 7) % 22), height: 2.5, rx: 1, fill: col, opacity: .85 }, lines);
    }
  }

  crew.forEach((c, i) => {
    const b = robot(c);
    const spot = FREE_SPOTS[i % FREE_SPOTS.length];
    Object.assign(b, { id: c.id, x: nodes[spot].x, y: nodes[spot].y, dir: 1, path: [], queue: [], pose: poseFor(spot), waitUntil: 0, phase: Math.random() * 6 });
    claim(b, spot);
    const pick = () => onSelect?.(c.id);
    b.g.addEventListener('click', pick);
    b.g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    floor.appendChild(b.g); sortables.push(b.g);
    bots[c.id] = b;
    agents[c.id] = { id: c.id, state: 'idle', text: 'Free' };
    setFace(b, 'idle');
    paintScreen(c.id);
  });

  // ---------- GPU art, when it has been generated ----------
  fetch(`${artBase}manifest.json`, { cache: 'no-cache' }).then((r) => r.ok ? r.json() : null).then((m) => {
    if (!m) return;
    art = { robots: m.robots || {}, props: m.props || {} };
    const url = (f) => `${artBase}${f}`;
    for (const id in bots) if (art.robots[id]) {
      const probe = new Image();
      probe.onload = () => useArt(bots[id], url(art.robots[id]));
      probe.src = url(art.robots[id]);
    }
    for (const name in props) if (art.props[name]) {
      const probe = new Image();
      probe.onload = () => props[name].forEach(({ drawn, img }) => {
        const { x, y, w, h } = img.dataset;
        Object.entries({ href: url(art.props[name]), x, y, width: w, height: h, visibility: 'visible' }).forEach(([k, v]) => img.setAttribute(k, v));
        drawn.setAttribute('visibility', 'hidden');
      });
      probe.src = url(art.props[name]);
    }
    if (m.props?.window) { view.setAttribute('href', url(m.props.window)); view.setAttribute('visibility', 'visible'); }
  }).catch(() => { /* no art yet: the drawn office stays */ });

  // ---------- loop ----------
  let last = performance.now(), lastSort = 0;
  const fmtTime = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: tz(), ...o }).format(new Date());
  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    simT += dt;
    for (const b of Object.values(bots)) { step(b, dt); draw(b); }
    if (now - lastSort > 120) { lastSort = now; sortables.sort((p, q) => p.dataset.y - q.dataset.y).forEach((g) => floor.appendChild(g)); }
    const llm = Object.values(agents).find((a) => a.llm && a.state === 'working');
    const reading = llm?.llm.phase === 'reading';
    rackLights.forEach((l, i) => l.setAttribute('fill', llm ? (Math.sin(simT * (reading ? 14 : 7) + i * 1.7) > 0 ? (reading ? '#f0b354' : '#2fd38a') : '#3b4a5e') : (i === 0 ? '#2fd38a' : '#3b4a5e')));
    rackLabel.textContent = llm ? (reading ? 'Ollama reading' : 'Ollama writing') : '';
    steam.setAttribute('opacity', simT < steamUntil ? .8 : 0);
    steam.setAttribute('transform', `translate(0,${-((simT * 20) % 8)})`);
    inboxFlag.setAttribute('transform', agents.publisher?.state === 'waiting' ? '' : 'rotate(90 120 524)');
    for (const id in desks) { const s = desks[id].screen.querySelector('.scroll'); if (s) s.setAttribute('transform', `translate(0,${-((simT * 6) % 6)})`); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function tickClock() {
    const hm = fmtTime({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const sec = new Date().getSeconds();
    clockHm.textContent = sec % 2 ? hm.replace(':', ' ') : hm;
    clockDay.textContent = fmtTime({ weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase().replace(',', '');
    const [h, m] = hm.split(':').map(Number);
    const hour = h + m / 60;
    const day = hour >= 7 && hour < 18, dusk = (hour >= 18 && hour < 20) || (hour >= 6 && hour < 7);
    sky.setAttribute('fill', day ? '#9fd0f0' : dusk ? '#f2a76b' : '#1d2a4a');
    sun.setAttribute('fill', day || dusk ? '#ffe08a' : '#e9eef6');
    sun.setAttribute('cy', day ? 90 : 76);
    view.setAttribute('opacity', day ? 1 : dusk ? .75 : .35);
    hills.setAttribute('opacity', day ? .8 : .45);
  }
  tickClock();
  setInterval(tickClock, 1000);

  return {
    // A live status update for one agent. The first one only places the robot; later changes
    // make it walk (and hand over work when it finishes).
    agent(a) {
      const prev = agents[a.id];
      if (!prev || !bots[a.id]) return;
      const first = !prev.seen;
      const changed = first || prev.state !== a.state;
      Object.assign(prev, a, { seen: true });
      if (changed) {
        prev.simSince = first ? -99 : simT;
        const b = bots[a.id];
        setFace(b, a.state === 'idle' ? 'idle' : a.state);
        plan(a.id, !first);
        if (first || REDUCED) settle(b);
      }
      paintScreen(a.id);
    },
    select(id) {
      selected = id;
      for (const k in bots) bots[k].ring.setAttribute('visibility', k === id ? 'visible' : 'hidden');
    }
  };
}

window.StudioOffice = { create };
})();
