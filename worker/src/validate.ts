import countries from 'i18n-iso-countries';
import { ISO3 } from './data/countries.js';

// Code checks on the model's output. Numbers are the main thing: every number in the
// voiceover, on-screen text and title must appear in the facts.

export interface Beat { vo: string; on_screen: string; visual: string; emphasis_words?: string[]; filler?: boolean }
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
// Real facts the code may add as build-up beats when the script is too short (ranks 2-6, anchors).
export interface Filler { name: string; iso3: string; display: string; rank: number }

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

export function checkScript(script: Script, allowed: Set<string>, words: [number, number], spoiler?: Spoiler, fillers: Filler[] = []): string[] {
  const errors: string[] = [];
  if (!script || !Array.isArray(script.beats)) return ['Output has no "beats" array.'];
  errors.push(...fixVisuals(script.beats));
  tidy(script);
  if (spoiler) landPayoff(script, spoiler);
  if (spoiler) padShort(script, words[0], spoiler, fillers);
  const beats = script.beats;
  if (beats.length < 6 || beats.length > 14) errors.push(`Use 8 to 12 beats (you wrote ${beats.length}).`);
  const total = beats.reduce((s, b) => s + wordCount(b.vo ?? ''), 0);
  // Too short makes a weak video (under about 28 s), so it is a real failure; a bit long is minor.
  if (total < words[0]) errors.push(`Total spoken words must be ${words[0]}-${words[1]} (you wrote ${total}). Add beats with more facts from FACTS.`);
  else if (total > words[1]) errors.push(minor(`Total spoken words must be ${words[0]}-${words[1]} (you wrote ${total}).`));
  beats.forEach((b, i) => {
    if (!b.vo || typeof b.vo !== 'string') { errors.push(`Beat ${i + 1} has no vo.`); return; }
    const w = wordCount(b.vo);
    if (w > 14) errors.push(`Beat ${i + 1} has ${w} spoken words; max 12.`);
    if (i === 0 && w > 10) errors.push(`The hook (beat 1) has ${w} words; max 9.`);
    for (const re of BANNED) if (re.test(b.vo) || re.test(b.on_screen ?? '')) errors.push(`Beat ${i + 1} uses a banned phrase (${re.source}).`);
    const early = i < Math.floor((beats.length * 2) / 3);
    if (early && spoils(`${b.vo} ${b.on_screen ?? ''}`, spoiler))
      errors.push(minor(`Beat ${i + 1} gives away the answer (${spoiler!.name} / ${spoiler!.value}). Save it for the final third.`));
    const twin = b.filler ? -1 : beats.findIndex((o, j) => j < i && !o.filler && o.vo && similar(o.vo, b.vo));
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

// The local model often writes too few words. Rather than fail, add build-up beats made only
// from FACTS (a country, its rank and value) just before the reveal until the script is long enough.
function padShort(script: Script, minWords: number, sp: Spoiler, fillers: Filler[]): void {
  const beats = script.beats;
  const total = () => beats.reduce((n, b) => n + wordCount(b.vo ?? ''), 0);
  const said = (name: string) => beats.some((b) => `${b.vo} ${b.on_screen}`.toLowerCase().includes(name.toLowerCase()));
  const unitText = (display: string) => (/^[\d.,]+$/.test(display) ? ` ${sp.unit}` : '');
  const add: Filler[] = [];
  let have = total();
  for (const f of fillers) {
    if (have >= minWords || beats.length + add.length >= 14) break;
    if (f.iso3 === sp.iso3 || said(f.name)) continue;
    add.push(f);
    have += 7;
  }
  // Count down towards the reveal: #4, #3, #2, then the #1.
  for (const f of add.sort((a, b) => b.rank - a.rank)) {
    // Just before the reveal: the first reveal_answer beat, else the last beat naming the #1.
    let at = beats.findIndex((b) => b.visual === 'reveal_answer');
    if (at < 1) at = beats.map((b) => (b.vo ?? '').includes(sp.name)).lastIndexOf(true);
    beats.splice(at > 0 ? at : Math.max(1, beats.length - 1), 0, {
      filler: true,
      vo: `${f.name} ranks number ${f.rank}, with ${f.display}${unitText(f.display)}.`,
      on_screen: `#${f.rank} ${f.name}`,
      visual: `highlight:${f.iso3}`,
      emphasis_words: [f.name],
    });
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
    if (b.vo && !b.filler && script.beats.some((o, j) => j < i && !o.filler && o.vo && similar(o.vo, b.vo))) script.beats.splice(i, 1);
  }
}

export function isBanned(text: string): boolean {
  return BANNED.some((re) => re.test(text));
}

export function checkText(label: string, text: string, allowed: Set<string>): string[] {
  return numbersIn(text).filter((n) => !allowed.has(n)).map((n) => `${label} uses the number ${n}, which is not in FACTS.`);
}
