import countries from 'i18n-iso-countries';
import { ISO3 } from './data/countries.js';

// Code checks on the model's output. Numbers are the main thing: every number in the
// voiceover, on-screen text and title must appear in the facts.

export interface Beat { vo: string; on_screen: string; visual: string; emphasis_words?: string[] }
export interface Script { beats: Beat[]; loop_check?: string }

const NUM = /\d[\d,]*(?:\.\d+)?/g;

export function normNum(s: string): string {
  let n = s.replace(/,/g, '');
  if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '');
  return n;
}

export function numbersIn(text: string): string[] {
  return (text.match(NUM) ?? []).map(normNum);
}

export function allowedNumbers(...sources: unknown[]): Set<string> {
  const set = new Set<string>();
  for (const s of sources) for (const n of numbersIn(typeof s === 'string' ? s : JSON.stringify(s))) set.add(n);
  return set;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const BANNED = [/\bsubscribe\b/i, /\bfollow (us|me|for)\b/i, /did you know/i, /let'?s dive in/i, /\bsmash\b/i, /that'?s (the|our) (full )?list/i, /now you know/i];

// The #1 country and its value: the payoff, so they must stay out of the hook and the first two thirds.
export interface Spoiler { name: string; value: string; iso3: string; unit: string }

// Minor problems are sent back to the writer as hints, but a script with only minor
// problems is still used after the last attempt instead of failing the whole video.
const MINOR = '(minor) ';
const minor = (msg: string) => MINOR + msg;
export const isMinor = (msg: string) => msg.startsWith(MINOR);

export function spoils(text: string, sp?: Spoiler): boolean {
  if (!sp) return false;
  const t = text.toLowerCase();
  return t.includes(sp.name.toLowerCase()) || numbersIn(text).some((n) => numbersIn(sp.value).includes(n));
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function similar(a: string, b: string): boolean {
  const x = tokens(a), y = tokens(b);
  if (x.size < 3 || y.size < 3) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.75;
}

export function checkScript(script: Script, allowed: Set<string>, words: [number, number], spoiler?: Spoiler): string[] {
  const errors: string[] = [];
  if (!script || !Array.isArray(script.beats)) return ['Output has no "beats" array.'];
  errors.push(...fixVisuals(script.beats));
  tidy(script);
  if (spoiler) landPayoff(script, spoiler);
  const beats = script.beats;
  if (beats.length < 6 || beats.length > 12) errors.push(`Use 7 to 11 beats (you wrote ${beats.length}).`);
  const total = beats.reduce((s, b) => s + wordCount(b.vo ?? ''), 0);
  // Far too short is a real failure; a little short or long is minor.
  if (total < words[0] * 0.7) errors.push(`Total spoken words must be ${words[0]}-${words[1]} (you wrote ${total}). Add beats with more facts.`);
  else if (total < words[0] || total > words[1]) errors.push(minor(`Total spoken words must be ${words[0]}-${words[1]} (you wrote ${total}).`));
  beats.forEach((b, i) => {
    if (!b.vo || typeof b.vo !== 'string') { errors.push(`Beat ${i + 1} has no vo.`); return; }
    const w = wordCount(b.vo);
    if (w > 12) errors.push(`Beat ${i + 1} has ${w} spoken words; max 8.`);
    if (i === 0 && w > 10) errors.push(`The hook (beat 1) has ${w} words; max 9.`);
    for (const re of BANNED) if (re.test(b.vo) || re.test(b.on_screen ?? '')) errors.push(`Beat ${i + 1} uses a banned phrase (${re.source}).`);
    const early = i < Math.floor((beats.length * 2) / 3);
    if (early && spoils(`${b.vo} ${b.on_screen ?? ''}`, spoiler))
      errors.push(minor(`Beat ${i + 1} gives away the answer (${spoiler!.name} / ${spoiler!.value}). Save it for the final third.`));
    const twin = beats.findIndex((o, j) => j < i && o.vo && similar(o.vo, b.vo));
    if (twin >= 0) errors.push(minor(`Beat ${i + 1} repeats beat ${twin + 1}. Say something new.`));
    for (const n of [...numbersIn(b.vo), ...numbersIn(b.on_screen ?? '')]) {
      if (!allowed.has(n)) errors.push(`Beat ${i + 1} uses the number ${n}, which is not in FACTS. Copy numbers exactly from FACTS.`);
    }
  });
  return errors;
}

// Country visuals need one ISO3 code. Two-letter codes are converted; from a list
// ("zoom_to:URY,PRY") the first valid code is kept; with no valid code it is an error.
export function fixVisuals(beats: Beat[]): string[] {
  const errors: string[] = [];
  beats.forEach((b, i) => {
    const m = /^(zoom_to|highlight|bar_add):(.+)$/.exec((b.visual ?? '').trim());
    if (!m) return;
    const codes = m[2].split(/[^A-Za-z]+/).filter(Boolean).map((c) => {
      const up = c.toUpperCase();
      return up.length === 2 ? countries.alpha2ToAlpha3(up) ?? up : up;
    });
    const code = codes.find((c) => ISO3.has(c));
    if (code) b.visual = `${m[1]}:${code}`;
    else errors.push(`Beat ${i + 1} visual "${b.visual}" needs one country code from FACTS.`);
  });
  return errors;
}

// Small problems the model keeps making are fixed here instead of costing a full rewrite:
// on-screen text is cut to 6 words, and a beat that repeats an earlier one is dropped
// while at least 7 beats remain.
// The payoff must land. Early visuals that show the #1 fall back to the plain map, and if
// the final third never names the #1, a reveal beat is added before the last beat.
function landPayoff(script: Script, sp: Spoiler): void {
  const beats = script.beats;
  const cut = () => Math.floor((beats.length * 2) / 3);
  beats.forEach((b, i) => {
    if (i < cut() && (b.visual ?? '').endsWith(`:${sp.iso3}`)) b.visual = 'map_fill';
  });
  const named = beats.slice(cut()).some((b) => (b.vo ?? '').toLowerCase().includes(sp.name.toLowerCase()));
  if (!named && beats.length) {
    beats.splice(Math.max(1, beats.length - 1), 0, {
      vo: `${sp.name} leads with ${sp.value} ${sp.unit}.`,
      on_screen: `#1 ${sp.name}`,
      visual: 'reveal_answer',
      emphasis_words: [sp.name, sp.value],
    } as Beat);
  }
}

function tidy(script: Script): void {
  for (const b of script.beats) {
    if (!b.on_screen || wordCount(b.on_screen) <= 6) continue;
    const w = b.on_screen.trim().split(/\s+/).slice(0, 6);
    while (w.length > 2 && /^(in|the|of|a|an|and|or|to|per|with|for|than|by|at|on|is|are)$/i.test(w[w.length - 1])) w.pop();
    b.on_screen = w.join(' ').replace(/[,;:.\-–]+$/, '');
  }
  for (let i = script.beats.length - 1; i > 0 && script.beats.length > 7; i--) {
    const b = script.beats[i];
    if (b.vo && script.beats.some((o, j) => j < i && o.vo && similar(o.vo, b.vo))) script.beats.splice(i, 1);
  }
}

export function isBanned(text: string): boolean {
  return BANNED.some((re) => re.test(text));
}

export function checkText(label: string, text: string, allowed: Set<string>): string[] {
  return numbersIn(text).filter((n) => !allowed.has(n)).map((n) => `${label} uses the number ${n}, which is not in FACTS.`);
}
