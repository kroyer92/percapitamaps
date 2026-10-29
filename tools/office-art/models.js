// The office's robots and furniture as small three.js models. render.mjs photographs each one
// from the office's camera angle into a transparent PNG for worker/studio/office/art/. Because
// every picture comes from the same model, a robot looks the same in every pose and frame.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Same colours as the agents on the studio page.
export const CREW = {
  scout: { color: '#4f98c6', gear: 'dish' },
  writer: { color: '#e0a03c', gear: 'pencil' },
  narrator: { color: '#6f9f80', gear: 'phones' },
  editor: { color: '#c86b5a', gear: 'visor' },
  checker: { color: '#7d6bb5', gear: 'glasses' },
  publisher: { color: '#2f78a6', gear: 'plane' },
  analyst: { color: '#4d6577', gear: 'chart' },
};

const plastic = (color, rough = 0.32) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });
const matte = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 });
const glow = (color, strength = 1.6) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: strength, roughness: 0.4 });
const metal = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.8 });
const box = (w, h, d, r, mat) => new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, r), mat);
const at = (mesh, x, y, z, rx = 0, ry = 0, rz = 0) => { mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz); return mesh; };

// A hover robot: no arms or legs (the page draws floating hands and moves the whole sprite).
export function robot(id) {
  const { color, gear } = CREW[id];
  const g = new THREE.Group();
  const shell = plastic(color);
  const white = plastic('#eef2f6', 0.28);
  const dark = new THREE.MeshStandardMaterial({ color: '#141b27', roughness: 0.15, metalness: 0.2 });

  // body: a rounded egg-ish block with a lighter belly panel and a thruster ring below
  const body = box(0.78, 0.62, 0.62, 0.26, shell); at(body, 0, 0.62, 0); g.add(body);
  g.add(at(box(0.4, 0.22, 0.05, 0.07, plastic('#ffffff', 0.4)), 0, 0.6, 0.31));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 12, 32), glow('#7ef0d0', 1.2));
  g.add(at(ring, 0, 0.26, 0, Math.PI / 2));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.1, 24), metal('#3a4150')), 0, 0.31, 0));

  // head: white shell, dark glass screen, two mint eyes and a small smile
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.08, 16), metal('#3a4150')), 0, 0.96, 0));
  const head = box(0.92, 0.66, 0.66, 0.24, white); at(head, 0, 1.3, 0); g.add(head);
  g.add(at(box(0.72, 0.46, 0.06, 0.14, dark), 0, 1.3, 0.32));
  for (const x of [-0.15, 0.15]) g.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.09, 6, 12), glow('#7ef0d0', 2.2)), x, 1.34, 0.36));
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.016, 8, 24, Math.PI), glow('#7ef0d0', 2));
  g.add(at(smile, 0, 1.22, 0.36, 0, 0, Math.PI));
  // ear bolts
  for (const x of [-0.48, 0.48]) g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 16), shell), x, 1.3, 0, 0, 0, Math.PI / 2));

  if (gear === 'dish') {
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 3), new THREE.MeshStandardMaterial({ color: '#d7dee6', roughness: 0.35, metalness: 0.4, side: THREE.DoubleSide }));
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 8), metal('#3a4150')), 0.28, 1.72, 0));
    g.add(at(dish, 0.32, 1.86, 0.02, -0.5, 0, -0.6));
  }
  if (gear === 'pencil') {
    const p = new THREE.Group();
    p.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6), matte('#f0c040')), 0, 0, 0));
    p.add(at(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 6), matte('#f2d3a8')), 0, -0.3, 0, Math.PI));
    p.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.06, 6), matte('#e08a9a')), 0, 0.27, 0));
    g.add(at(p, 0.5, 1.5, -0.05, 0, 0, 0.5));
  }
  if (gear === 'phones') {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.045, 10, 32, Math.PI), plastic('#2a3b4c'));
    g.add(at(band, 0, 1.36, 0));
    for (const x of [-0.52, 0.52]) g.add(at(box(0.14, 0.3, 0.3, 0.06, plastic('#2a3b4c')), x, 1.3, 0));
  }
  if (gear === 'visor') { // a little clapperboard tucked on its head
    const c = new THREE.Group();
    c.add(at(box(0.36, 0.24, 0.05, 0.02, plastic('#1d2433', 0.3)), 0, 0, 0));
    const top = new THREE.Group();
    top.add(at(box(0.38, 0.07, 0.05, 0.01, plastic('#1d2433', 0.3)), 0.19, 0, 0));
    for (let k = 0; k < 4; k++) top.add(at(box(0.04, 0.072, 0.052, 0.005, plastic('#eef2f6')), 0.05 + k * 0.09, 0, 0, 0, 0, 0.5));
    c.add(at(top, -0.19, 0.17, 0, 0, 0, 0.35));
    for (let k = 0; k < 3; k++) c.add(at(box(0.25, 0.015, 0.052, 0.003, plastic('#eef2f6')), 0, 0.04 - k * 0.07, 0));
    g.add(at(c, 0.36, 1.72, 0, 0, 0, -0.35));
  }
  if (gear === 'glasses') {
    const gold = metal('#f0c879');
    for (const x of [-0.15, 0.15]) g.add(at(new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 8, 28), gold), x, 1.34, 0.4));
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6), gold), 0, 1.36, 0.4, 0, 0, Math.PI / 2));
  }
  if (gear === 'plane' || gear === 'chart') g.children.find((m) => m.position.z === 0.31 && m.position.y === 0.6).visible = false; // the emblem replaces the belly panel
  if (gear === 'plane') {
    const s = new THREE.Shape(); s.moveTo(-0.13, -0.02); s.lineTo(0.15, 0.08); s.lineTo(-0.02, -0.1); s.lineTo(-0.04, -0.03); s.closePath();
    g.add(at(new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false }), plastic('#ffffff')), -0.01, 0.6, 0.36));
  }
  if (gear === 'chart') {
    [0.08, 0.13, 0.18].forEach((h, i) => g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.03), plastic(i === 2 ? '#f0b04a' : '#ffffff')), -0.08 + i * 0.08, 0.5 + h / 2, 0.36)));
  }
  return g;
}

// ---------- furniture ----------
const wood = () => plastic('#a8724a', 0.6);
const darkWood = () => plastic('#6e452c', 0.65);

export function desk() {
  const g = new THREE.Group();
  g.add(at(box(2.4, 0.14, 1.1, 0.04, wood()), 0, 0.92, 0));
  g.add(at(box(2.2, 0.6, 0.06, 0.02, darkWood()), 0, 0.6, 0.48));
  for (const x of [-1.08, 1.08]) for (const z of [-0.45, 0.45]) g.add(at(box(0.09, 0.86, 0.09, 0.02, darkWood()), x, 0.43, z));
  g.add(at(box(0.5, 0.5, 0.9, 0.03, darkWood()), 0.75, 0.6, 0)); // drawers
  for (const y of [0.72, 0.5]) g.add(at(box(0.16, 0.03, 0.03, 0.01, metal('#c9ced6')), 0.75, y, 0.47));
  return g;
}

export function coffee() {
  const g = new THREE.Group();
  g.add(at(box(3.0, 0.9, 0.9, 0.04, plastic('#6e7d8c', 0.5)), 0, 0.45, 0));
  for (const x of [-1.0, 0, 1.0]) g.add(at(box(0.9, 0.78, 0.02, 0.01, plastic('#7d8c9b', 0.5)), x, 0.45, 0.46));
  for (const x of [-0.6, 0.4, 1.4]) g.add(at(box(0.18, 0.03, 0.03, 0.01, metal('#c9ced6')), x, 0.75, 0.48));
  g.add(at(box(3.1, 0.08, 0.98, 0.03, plastic('#e9eef3', 0.3)), 0, 0.94, 0));
  // espresso machine
  const m = new THREE.Group();
  m.add(at(box(0.7, 0.8, 0.6, 0.08, plastic('#2a3b4c', 0.3)), 0, 0.4, 0));
  m.add(at(box(0.44, 0.14, 0.04, 0.03, glow('#7ef0d0', 1)), 0, 0.62, 0.31));
  m.add(at(box(0.5, 0.06, 0.4, 0.02, metal('#c9ced6')), 0, 0.06, 0.15));
  m.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.16, 16), plastic('#ffffff', 0.3)), 0, 0.18, 0.2));
  g.add(at(m, -0.7, 0.98, 0));
  // toaster
  g.add(at(box(0.62, 0.36, 0.38, 0.1, plastic('#c86b5a', 0.3)), 0.6, 1.16, 0));
  g.add(at(box(0.4, 0.02, 0.06, 0.01, matte('#3a2a20')), 0.6, 1.35, -0.06));
  g.add(at(box(0.4, 0.02, 0.06, 0.01, matte('#3a2a20')), 0.6, 1.35, 0.06));
  return g;
}

export function cooler() {
  const g = new THREE.Group();
  g.add(at(box(0.6, 1.1, 0.55, 0.06, plastic('#e9eef3', 0.4)), 0, 0.55, 0));
  g.add(at(box(0.3, 0.16, 0.05, 0.03, plastic('#2a3b4c')), 0, 0.82, 0.28));
  for (const [x, c] of [[-0.07, '#d0533f'], [0.07, '#4f98c6']]) g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 10), plastic(c)), x, 0.75, 0.31, Math.PI / 2));
  const water = new THREE.MeshPhysicalMaterial({ color: '#9fd0f0', roughness: 0.05, transmission: 0.4, transparent: true, opacity: 0.85 });
  g.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 8, 24), water), 0, 1.5, 0));
  return g;
}

export function rack() {
  const g = new THREE.Group();
  g.add(at(box(0.9, 2.0, 0.8, 0.05, plastic('#1d2433', 0.35)), 0, 1.0, 0));
  for (let i = 0; i < 6; i++) {
    g.add(at(box(0.76, 0.24, 0.04, 0.02, plastic('#2a3446', 0.4)), 0, 1.72 - i * 0.29, 0.4));
    for (let k = 0; k < 5; k++) g.add(at(box(0.06, 0.12, 0.02, 0.005, matte('#141b27')), -0.3 + k * 0.08, 1.72 - i * 0.29, 0.42));
    // the page draws the blinking lights on top, so these stay dark
  }
  return g;
}

export function sofa() {
  const g = new THREE.Group();
  const fabric = matte('#4f86a8');
  const deep = matte('#3f6f8f');
  g.add(at(box(2.6, 0.4, 1.0, 0.12, deep), 0, 0.3, 0));
  for (const x of [-0.62, 0.62]) g.add(at(box(1.18, 0.24, 0.9, 0.12, fabric), x, 0.6, 0.05));
  g.add(at(box(2.6, 0.8, 0.3, 0.14, deep), 0, 0.85, -0.38));
  for (const x of [-0.62, 0.62]) g.add(at(box(1.14, 0.6, 0.22, 0.12, fabric), x, 0.95, -0.2));
  for (const x of [-1.35, 1.35]) g.add(at(box(0.3, 0.7, 1.0, 0.13, deep), x, 0.55, 0));
  for (const x of [-1.15, 1.15]) g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.12, 8), darkWood()), x, 0.06, 0.35));
  return g;
}

export function plant() {
  const g = new THREE.Group();
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.6, 24), plastic('#c86b5a', 0.6)), 0, 0.3, 0));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.04, 24), matte('#4b2f1e')), 0, 0.59, 0));
  const leaf = matte('#5a8f6c'), leaf2 = matte('#6fa77f');
  const rnd = (i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2, tilt = 0.25 + rnd(i) * 0.5, len = 0.5 + rnd(i + 3) * 0.45;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 10), i % 2 ? leaf : leaf2);
    m.scale.set(0.22, len, 0.08);
    const pivot = new THREE.Group(); pivot.position.set(0, 0.6, 0); pivot.rotation.set(0, a, tilt);
    m.position.set(0, len * 0.45, 0); pivot.add(m); g.add(pivot);
  }
  return g;
}

export function inbox() {
  const g = new THREE.Group();
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 10), metal('#7d8794')), 0, 0.6, 0));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.05, 20), metal('#5b6b7c')), 0, 0.025, 0));
  const mb = new THREE.Group();
  mb.add(at(box(0.5, 0.36, 0.8, 0.06, plastic('#2f78a6', 0.3)), 0, 0, 0));
  mb.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.8, 24, 1, false, 0, Math.PI), plastic('#2f78a6', 0.3)), 0, 0.16, 0, Math.PI / 2, 0, Math.PI / 2));
  mb.add(at(box(0.42, 0.42, 0.03, 0.04, plastic('#255f86', 0.35)), 0, 0.08, 0.41));
  g.add(at(mb, 0, 1.38, 0, 0, Math.PI / 2, 0)); // long side to the viewer, door on the left
  g.add(at(box(0.035, 0.32, 0.035, 0.01, plastic('#d0533f')), 0.22, 1.62, 0.27)); // the flag, up
  g.add(at(box(0.16, 0.1, 0.035, 0.01, plastic('#d0533f')), 0.3, 1.74, 0.27));
  return g;
}
