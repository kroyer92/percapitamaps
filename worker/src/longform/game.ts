// Plans the weekly long-form video as a game. A cold open teases the biggest surprises without
// naming an answer, then every map is a round: the viewer guesses before a timer runs out, the
// answer lands, their own country shows up, and one more fact closes the round. It ends on a
// reveal that needs the whole video (the country in the most top tens) and the viewer's score.
//
// Like the classic long-form (plan.ts), every line is written by code from the facts builder: no
// language model is involved, so no number can be made up. Each round takes the kind its data can
// carry (roundKinds), and falls back to the plain "pick the #1" when it can carry nothing else.
import { ANCHORS, iso3ToIso2 } from '../data/countries.js';
import { FAMOUS, formatValue, type Facts, type RankRow } from '../facts.js';
import type { Champion, CountView, GameBar, GameOption, GameRound, OwnChip, RoundKind, Teaser } from '../../remotion/game-types.js';
import type { RankItem } from '../../remotion/types.js';
import { cap, inSentence, lower, namesList, spoken, type Dataset, type PickedMap } from './plan.js';
import type { Theme } from './themes.js';

// A spoken line. `marks` name the words that move the picture: the frame where the voice starts
// that word becomes the cue of that name (game-time.ts), e.g. an option card pops on its name.
export interface GameLine {
  id: string; // ask, opts, then, reveal, point, ladder, own, compare, extremes ...
  vo: string;
  marks?: [string, number][]; // [cue name, which word of `vo` it is (0-based, split on spaces)]
  timer?: boolean; // the guess timer runs after this line
  lapse?: boolean; // then the years run before the answer (then_now)
  gap?: number; // seconds of silence after it
}

// "{opt.0|Norway}, {opt.1|Ireland}, or {opt.2|Chad}?" -> the plain line, and which word each name
// in braces starts on. Marking the word where it is written (not searching for it afterwards) keeps
// a cue right when the same word is in the line twice ("under 50 years today? 50, 38, or 26?").
export function marked(text: string): { vo: string; marks: [string, number][] } {
  const marks: [string, number][] = [];
  let vo = '';
  let last = 0;
  for (const m of text.matchAll(/\{([\w.]+)\|([^{}]*)\}/g)) {
    vo += text.slice(last, m.index);
    const before = vo.split(/\s+/).filter(Boolean).length;
    marks.push([m[1], /\S$/.test(vo) ? before - 1 : before]);
    vo += m[2];
    last = m.index! + m[0].length;
  }
  return { vo: vo + text.slice(last), marks };
}
const L = (id: string, text: string, extra: Partial<GameLine> = {}): GameLine => {
  const { vo, marks } = marked(text);
  return { id, vo, ...(marks.length ? { marks } : {}), ...extra };
};

export type RoundView = Omit<GameRound, 'start' | 'end' | 'phases' | 'cue'>;
export interface PlannedRound { dataset_id: string; ds: Dataset; facts: Facts; lines: GameLine[]; view: RoundView }
export type TeaserView = Omit<Teaser, 'start' | 'cue'>;

export interface GamePlan {
  theme: Theme;
  rounds: PlannedRound[];
  open: { line: GameLine; view: TeaserView }[];
  ending: { lines: GameLine[]; champions: Champion[]; times: number };
  skipped: string[]; // datasets left out, and why
}

export const GAME_ROUNDS = 9; // about six minutes
export const GAME_MIN_ROUNDS = 7;
export const GAME_MAX_ROUNDS = 12;
// A map whose top value several countries share ("100%") has no #1 to guess: "Which country is
// highest?" would have more than one right answer. The quiz leaves such a map out (pickMaps' skip).
export function gameUnusable({ facts }: Pick<PickedMap, 'facts'>): string | undefined {
  const r = facts.ranking;
  if (r.length < 2 || r[0].display !== r[1].display) return undefined;
  return `${r.filter((x) => x.display === r[0].display).length} countries share the top value (${r[0].display}), so there is no #1 to guess`;
}

// How many rounds to make: what was asked (/longform, --maps), else LONGFORM_ROUNDS, else 9.
export function roundsWanted(asked?: number): number {
  const n = asked || Number(process.env.LONGFORM_ROUNDS) || GAME_ROUNDS;
  return Math.max(GAME_MIN_ROUNDS, Math.min(GAME_MAX_ROUNDS, Math.round(n)));
}

const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const numWord = (n: number) => NUM_WORD[n] ?? String(n);
const rankItem = (r: RankRow): RankItem => ({ ...r, iso2: iso3ToIso2(r.iso3) });
const find = (facts: Facts, iso: string) => facts.ranking.find((r) => r.iso3 === iso);
// A country inside the shared lowest value has no real rank ("number 87" of 100 countries at 0%).
const inTie = (facts: Facts, r: RankRow) => !!facts.bottom_tie && r.display === facts.bottom_tie.display;
const ordinal = (k: number) => `${k}${k % 10 === 1 && k % 100 !== 11 ? 'st' : k % 10 === 2 && k % 100 !== 12 ? 'nd' : k % 10 === 3 && k % 100 !== 13 ? 'rd' : 'th'}`;
// "6th" (the voice says "sixth"), or "number 46": long ordinals are a mouthful.
const rankSaid = (k: number) => (k <= 20 ? ordinal(k) : `number ${k}`);
const said = (r: RankRow) => inSentence(r.name);

// The words after a shown value. The value's own $, % or unit says the first word of the unit:
// "$137,782 per person", "61% of seats", "131.7 kg a year", but "2.80 cattle per person".
export function valueUnit(ds: Pick<Dataset, 'prefix' | 'suffix' | 'unit'>): string {
  const unit = ds.unit.replace(/\s*\(.*?\)/g, '').trim();
  if (ds.suffix?.includes('°')) return '';
  if (!ds.prefix && !ds.suffix) return unit;
  return unit.replace(/^international\s+/, '').replace(/^\S+\s*/, '');
}

// How a title is said: "Youth unemployment (ages 15–24)" -> "youth unemployment, ages 15 to 24".
export function saidTitle(title: string): string {
  return lower(title).replace(/\s*\(([^)]*)\)/g, ', $1').replace(/(\d)\s*[–-]\s*(\d)/g, '$1 to $2');
}

// A round number as the dataset shows its values: "50 years", "$20,000", "2.5".
function limitDisplay(v: number, ds: Dataset): string {
  const decimals = Number.isInteger(v) ? 0 : Math.min(3, (String(v).split('.')[1] ?? '').length);
  return formatValue(v, { ...ds, decimals });
}

// Round numbers between two values: multiples of 1, 2, 2.5 or 5 times a power of ten, about a dozen.
export function roundNumbers(lo: number, hi: number): number[] {
  if (!(hi > lo) || !isFinite(lo) || !isFinite(hi)) return [];
  const raw = (hi - lo) / 12;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let k = Math.ceil(lo / step); k * step <= hi; k++) out.push(Number((k * step).toPrecision(12)));
  return out.filter((v) => v !== 0 || lo < 0);
}

// "50" and "20,000" are rounder than "45" or "2.5": a viewer holds them more easily.
function roundness(v: number): number {
  const digits = Math.abs(v).toExponential(6).split('e')[0].replace('.', '').replace(/0+$/, '').length;
  return digits <= 1 ? 1.2 : digits === 2 ? 1 : 0.8;
}

function quantileOf(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- Then and now: how many countries are over or under a round number, long ago and today.
const BACK_YEARS = 15; // "then" is at least this long ago
const SAME_COUNTRIES = 0.85; // this share of today's countries must have a value in every year shown
const MIN_COUNTED = 40;
const MIN_SWING = 0.15; // the count must move by this share of the countries, or there is no story

export function thenNowOf({ ds, facts, series }: Pick<PickedMap, 'ds' | 'facts' | 'series'>): CountView | undefined {
  const isos = Object.keys(facts.map);
  const now = facts.year;
  const at = (iso: string, y: number) => { const v = series.values.get(iso)?.get(y); return v !== undefined && isFinite(v) ? v : undefined; };
  const covered = (y: number) => isos.filter((iso) => at(iso, y) !== undefined).length >= isos.length * SAME_COUNTRIES;
  const earlier = new Set<number>();
  for (const iso of isos) for (const y of series.values.get(iso)?.keys() ?? []) if (y <= now - BACK_YEARS) earlier.add(y);
  // The earliest year where nearly all of today's countries already have data.
  const then = [...earlier].sort((a, b) => a - b).find(covered);
  if (then === undefined) return undefined;
  // Two years in between for the time-lapse: the ones nearest to an even split, round years first.
  const between = [...new Set(isos.flatMap((iso) => [...(series.values.get(iso)?.keys() ?? [])]))].filter((y) => y > then && y < now && covered(y));
  const mids: number[] = [];
  for (const k of [1, 2]) {
    const target = then + ((now - then) * k) / 3;
    const cost = (y: number) => Math.abs(y - target) + (y % 10 === 0 ? 0 : y % 5 === 0 ? 2 : 4);
    const y = between.filter((c) => !mids.includes(c)).sort((a, b) => cost(a) - cost(b))[0];
    if (y !== undefined) mids.push(y);
  }
  const same = (years: number[]) => isos.filter((iso) => years.every((y) => at(iso, y) !== undefined));
  let years = mids.length === 2 ? [then, ...mids.sort((a, b) => a - b), now] : [then, now];
  let common = same(years);
  if (common.length < isos.length * SAME_COUNTRIES) { years = [then, now]; common = same(years); }
  if (common.length < MIN_COUNTED) return undefined;
  const maps = years.map((y) => Object.fromEntries(common.map((iso) => [iso, at(iso, y)!])));

  const first = Object.values(maps[0]);
  const last = Object.values(maps[maps.length - 1]);
  const pooled = [...first, ...last].sort((a, b) => a - b);
  const n = common.length;
  let best: { score: number; dir: 'above' | 'under'; limit: number } | undefined;
  for (const limit of roundNumbers(quantileOf(pooled, 0.02), quantileOf(pooled, 0.98))) {
    for (const dir of ['under', 'above'] as const) {
      const count = (xs: number[]) => xs.filter((v) => (dir === 'above' ? v > limit : v < limit)).length;
      const c0 = count(first);
      const c1 = count(last);
      const swing = Math.abs(c1 - c0) / n;
      if (swing < MIN_SWING) continue;
      // "Zero today" is the best ending a count can have; "none back then" is a good start.
      const score = swing * roundness(limit) + (c1 === 0 ? 0.3 : 0) + (c0 === 0 ? 0.1 : 0);
      if (!best || score > best.score) best = { score, dir, limit };
    }
  }
  if (!best) return undefined;
  const { dir, limit } = best;
  const shown = limitDisplay(limit, ds);
  return {
    dir, limit, verb: 'are', phrase: `${dir} ${spoken({ display: shown }, ds)}`, short: `${dir} ${shown}`,
    years, maps, counts: maps.map((m) => Object.values(m).filter((v) => (dir === 'above' ? v > limit : v < limit)).length), of: n,
  };
}

// ---------- How many: countries above a round number today (or over the dataset's own line,
// "more cattle than people").
export function howManyOf({ ds, facts }: Pick<PickedMap, 'ds' | 'facts'>): CountView | undefined {
  const values = facts.ranking.map((r) => r.value);
  const n = values.length;
  const above = (limit: number) => values.filter((v) => v > limit).length;
  const view = (limit: number, phrase: string, short: string, verb: 'are' | 'have'): CountView =>
    ({ dir: 'above', limit, verb, phrase, short, years: [facts.year], maps: [facts.map], counts: [above(limit)], of: n });
  if (ds.threshold) {
    const c = above(ds.threshold.value);
    if (c >= 2 && c <= n * 0.5) return view(ds.threshold.value, ds.threshold.label, `with ${ds.threshold.label}`, 'have');
  }
  const sorted = [...values].sort((a, b) => a - b);
  let best: { score: number; limit: number } | undefined;
  for (const limit of roundNumbers(quantileOf(sorted, 0.5), quantileOf(sorted, 0.99))) {
    const c = above(limit);
    // Few enough to be a club, enough to be worth counting.
    if (c < Math.max(3, Math.ceil(n * 0.03)) || c > n * 0.4) continue;
    const score = roundness(limit) * (1 - Math.abs(c / n - 0.12));
    if (!best || score > best.score) best = { score, limit };
  }
  if (!best) return undefined;
  const shown = limitDisplay(best.limit, ds);
  return view(best.limit, `above ${spoken({ display: shown }, ds)}`, `above ${shown}`, 'are');
}

// ---------- Higher or lower: one of the viewer's own countries against a famous one that is not
// its neighbour in the ranking (too close to call) and not #1 (that stays for the top five).
const DUEL_TARGETS = ['USA', 'IND', 'GBR', 'DEU', 'CAN', 'AUS'];

export function duelOf({ facts }: Pick<PickedMap, 'facts'>, exclude: string[] = [], turn = 0): { ref: RankRow; target: RankRow; higher: boolean } | undefined {
  const usable = (x: RankRow | undefined): x is RankRow => !!x && x.rank > 1 && !inTie(facts, x) && !exclude.includes(x.iso3);
  const apart = Math.max(4, Math.round(facts.ranking.length * 0.06));
  // A second higher-or-lower round in the same video starts from the next country.
  const targets = DUEL_TARGETS.map((_, i) => DUEL_TARGETS[(i + turn) % DUEL_TARGETS.length]);
  for (const iso of targets) {
    const target = find(facts, iso);
    if (!usable(target)) continue;
    const far = (x: RankRow) => Math.abs(x.rank - target.rank);
    const near = (x: RankRow) => far(x) <= apart * 4;
    // The most famous country that is clearly apart but still in sight; failing that, the nearest.
    const ref = FAMOUS.map((f) => find(facts, f))
      .filter((x): x is RankRow => usable(x) && x.iso3 !== target.iso3 && x.display !== target.display && far(x) >= apart)
      .sort((a, b) => Number(near(b)) - Number(near(a)) || (near(a) ? FAMOUS.indexOf(a.iso3) - FAMOUS.indexOf(b.iso3) : far(a) - far(b)))[0];
    if (ref) return { ref, target, higher: target.value > ref.value };
  }
  return undefined;
}

// ---------- Which kind each round gets. The pattern keeps "pick the #1" as the backbone (first,
// last and every third round) and never repeats another kind twice in a row.
const PATTERN: RoundKind[] = ['pick', 'then_now', 'higher_lower', 'pick', 'how_many', 'then_now', 'pick', 'higher_lower', 'how_many', 'pick', 'then_now', 'pick'];
const MAX_OF_A_KIND = 3;

export function roundKinds(can: RoundKind[][]): RoundKind[] {
  const out: RoundKind[] = [];
  const used = (k: RoundKind) => out.filter((x) => x === k).length;
  can.forEach((kinds, i) => {
    const want: RoundKind = i === can.length - 1 ? 'pick' : PATTERN[i % PATTERN.length];
    const order = [want, ...(['then_now', 'higher_lower', 'how_many'] as RoundKind[]).filter((k) => k !== want)];
    const kind = order.find((k) => k !== 'pick' && kinds.includes(k) && k !== out[i - 1] && used(k) < MAX_OF_A_KIND);
    out.push(want === 'pick' ? 'pick' : kind ?? 'pick');
  });
  return out;
}

// ---------- The three choices
function pickOptions(facts: Facts, exclude: string[]): { options: GameOption[]; answer: number } {
  const one = facts.ranking[0];
  const ok = (x: RankRow | undefined): x is RankRow => !!x && x.iso3 !== one.iso3 && !exclude.includes(x.iso3) && !inTie(facts, x);
  // The two best-placed famous countries: the obvious guesses (as in the Guess Shorts).
  const decoys = FAMOUS.map((iso) => find(facts, iso)).filter(ok).sort((a, b) => a.rank - b.rank).slice(0, 2);
  for (const x of facts.ranking.slice(1)) {
    if (decoys.length >= 2) break;
    if (ok(x) && !decoys.includes(x)) decoys.push(x);
  }
  // The answer's place depends on the data, not always the same letter.
  const slot = Math.min(decoys.length, one.value.toString().length % 3);
  const rows = [...decoys];
  rows.splice(slot, 0, one);
  return { options: rows.map((x, i) => ({ letter: 'ABC'[i], label: x.name, iso3: x.iso3, iso2: iso3ToIso2(x.iso3) })), answer: slot };
}

// The answer and two wrong counts that are clearly apart from it. `from` is the count the viewer
// was just told (then and now); it sets the scale, and when the count fell the choices run downward.
export function countOptions(answer: number, of: number, from?: number): { values: number[]; answer: number } {
  const scale = from === undefined ? Math.max(answer, 6) : Math.max(Math.abs(from - answer), 10);
  const wide = Math.max(2, Math.round(scale * (from === undefined ? 0.45 : 0.15)), Math.round(answer * 0.12));
  const floor = from === undefined ? 1 : 0;
  // Where the answer sits among the three depends on the data, not on a habit.
  const slot = (answer + of) % 3;
  let values: number[] | undefined;
  for (const step of [wide, Math.round(wide * 0.6), Math.round(wide * 0.35), 2, 1]) {
    if (step < 1) continue;
    for (const p of [slot, (slot + 1) % 3, (slot + 2) % 3]) {
      const set = [0, 1, 2].map((k) => answer + (k - p) * step);
      if (set.every((v) => v >= floor && v <= of)) { values = set; break; }
    }
    if (values) break;
  }
  values ??= [answer, answer + 1, answer + 2];
  if (from !== undefined && from > answer) values.reverse();
  return { values, answer: values.indexOf(answer) };
}

const countWord = (v: number) => (v === 0 ? 'zero' : v.toLocaleString('en-US'));
const countOptionCards = (values: number[]): GameOption[] => values.map((v, i) => ({ letter: 'ABC'[i], label: v.toLocaleString('en-US') }));
const optionsSaid = (words: string[]) => `${words.slice(0, -1).join(', ')}, or ${words[words.length - 1]}?`;

// ---------- The viewer's own countries
// With ranks: every anchor as a chip, and the voice names two the viewer has not heard yet.
function ownByRank(facts: Facts, heard: string[]): { own: OwnChip[]; ownTitle: string; ownNamed: string[]; line?: GameLine } {
  const rows = ANCHORS.map((iso) => find(facts, iso)).filter((x): x is RankRow => !!x).sort((a, b) => a.rank - b.rank);
  const own = rows.map((x): OwnChip => inTie(facts, x)
    ? { iso3: x.iso3, iso2: iso3ToIso2(x.iso3), name: x.name, main: x.display, sub: 'tied at the bottom' }
    : { iso3: x.iso3, iso2: iso3ToIso2(x.iso3), name: x.name, main: `#${x.rank}`, sub: x.display });
  const two = ['USA', 'IND', 'GBR', 'DEU', 'CAN', 'AUS'].map((iso) => find(facts, iso))
    .filter((x): x is RankRow => !!x && !inTie(facts, x) && !heard.includes(x.iso3)).slice(0, 2);
  const ownTitle = `WHERE’S YOURS? · RANK OF ${facts.ranking.length}`;
  if (!two.length) return { own, ownTitle, ownNamed: [] };
  return {
    own, ownTitle, ownNamed: two.map((x) => x.iso3),
    line: L('own', `Where is yours? ${two.map((x, i) => `{own.${i}|${cap(said(x))}} is ${rankSaid(x.rank)}.`).join(' ')}`, { gap: 0.5 }),
  };
}

// With then and now: what each anchor had in the first year and has today.
function ownThenNow(ds: Dataset, facts: Facts, count: CountView): { own: OwnChip[]; ownTitle: string; ownNamed: string[]; line?: GameLine } {
  const then = count.maps[0];
  const year = count.years[0];
  const rows = ANCHORS.map((iso) => find(facts, iso)).filter((x): x is RankRow => !!x && then[x.iso3] !== undefined).sort((a, b) => a.rank - b.rank);
  // "69.8 years" -> "69.8": the unit is said once, after today's value.
  const bare = (display: string) => (ds.suffix && display.endsWith(ds.suffix) ? display.slice(0, -ds.suffix.length) : display);
  const was = (x: RankRow) => formatValue(then[x.iso3], ds);
  const own = rows.map((x): OwnChip => ({ iso3: x.iso3, iso2: iso3ToIso2(x.iso3), name: x.name, main: x.display, sub: `${bare(was(x))} in ${year}` }));
  const two = ['USA', 'IND', 'GBR', 'DEU', 'CAN', 'AUS'].map((iso) => rows.find((x) => x.iso3 === iso)).filter((x): x is RankRow => !!x && was(x) !== x.display).slice(0, 2);
  const ownTitle = `AND YOURS? · ${year} → TODAY`;
  if (!two.length) return { own, ownTitle, ownNamed: [] };
  const went = (x: RankRow, i: number) => `{own.${i}|${cap(said(x))}}${i === 0 ? ' went' : ','} from ${bare(was(x))} to ${spoken(x, ds)}.`;
  return {
    own, ownTitle, ownNamed: two.map((x) => x.iso3),
    line: L('own', `And yours? ${two.map(went).join(' ')}`, { gap: 0.6 }),
  };
}

// ---------- The rounds
const POINT = ['Take a point if you got it.', 'One point if you got it.', 'Give yourself a point if you got it.'];
const TAGS: Record<RoundKind, string> = { pick: 'PICK THE #1', then_now: 'THEN AND NOW', how_many: 'HOW MANY?', higher_lower: 'HIGHER OR LOWER?' };

// "about 20 times" (rounded) or "4.2 times".
function timesSaid(r: number): string {
  return r >= 10 ? `about ${Math.round(r).toLocaleString('en-US')} times` : `${r.toFixed(1).replace(/\.0$/, '')} times`;
}
const timesShown = (r: number) => (r >= 10 ? `about ${Math.round(r).toLocaleString('en-US')}×` : `${r.toFixed(1).replace(/\.0$/, '')}×`);

export interface RoundExtras { then?: CountView; many?: CountView; exclude?: string[]; duelTurn?: number }

export function buildRound(n: number, total: number, kind: RoundKind, p: PickedMap, x: RoundExtras = {}): PlannedRound {
  const { ds, facts } = p;
  const r = facts.ranking;
  const one = r[0];
  const v = (alts: string[]) => alts[n % alts.length];
  const round = n === total && total > 1 ? 'Last round' : `Round ${numWord(n)}`;
  const what = saidTitle(facts.title);
  const tie = facts.bottom_tie;
  const base = {
    n, kind, tag: TAGS[kind], title: facts.title, yearText: facts.year_text ?? String(facts.year), unit: facts.unit, valueUnit: valueUnit(ds), sourceLine: facts.source_line,
    countries: facts.countries_count, map: facts.map, top: r.slice(0, 5).map(rankItem),
  };
  const point = L('point', v(POINT), { gap: 0.4 });
  // "Ireland, Switzerland, Singapore and Norway", each name marked for its row in the top five.
  const thenCome = namesList(r.slice(1, 5).map((row) => `{ladder.${row.rank}|${said(row)}}`));
  const fromTheTop = `Number one is {ladder.1|${said(one)}}, at ${spoken(one, ds)}. Then come ${thenCome}.`;
  const lines: GameLine[] = [];
  const done = (view: RoundView): PlannedRound => ({ dataset_id: ds.id, ds, facts, lines, view });

  if (kind === 'then_now' || kind === 'how_many') {
    const count = kind === 'then_now' ? x.then ?? thenNowOf(p) : x.many ?? howManyOf(p);
    if (!count) throw new Error(`${ds.id} cannot carry a ${kind} round`);
    const today = count.counts[count.counts.length - 1];
    const before = count.counts[0];
    const { values, answer } = countOptions(today, count.of, kind === 'then_now' ? before : undefined);
    const reveal = L('reveal', today === 0 ? `Zero. Not one country ${count.verb === 'have' ? 'has' : 'is'} ${count.phrase} today.` : `${cap(countWord(today))}, out of ${count.of} countries.`, { gap: 0.35 });
    const ask = `How many ${kind === 'then_now' ? '' : 'countries '}${count.verb} ${count.phrase}${kind === 'then_now' ? ' today' : ''}?`;
    const choices = optionsSaid(values.map((val, i) => `{opt.${i}|${i === 0 ? cap(countWord(val)) : countWord(val)}}`));
    const pointText: [string, string] = ['point if you said', countWord(today)];
    if (kind === 'then_now') {
      const year = count.years[0];
      lines.push(L('ask', `${round}: ${what}. Then and now.`, { gap: 0.3 }));
      lines.push(L('then', before === 0 ? `In ${year}, {then.count|not} one country was ${count.phrase}.`
        : before === 1 ? `In ${year}, {then.count|only} one country was ${count.phrase}.`
        : `In ${year}, {then.count|${countWord(before)}} countries were ${count.phrase}.`, { gap: 0.4 }));
      lines.push(L('opts', `${ask} ${choices}`, { timer: true, lapse: true, gap: 0.2 }));
      lines.push(reveal, point);
      const low = r[r.length - 1];
      lines.push(L('extremes', `Today, the highest is {ext.high|${said(one)}}, at ${spoken(one, ds)}.${tie ? '' : ` The lowest is {ext.low|${said(low)}}, at ${spoken(low, ds)}.`}`, { gap: 0.5 }));
      const own = ownThenNow(ds, facts, count);
      if (own.line) lines.push(own.line);
      // The source line names the years the round shows, not only the latest.
      const sourceLine = facts.source_line.replace(`, ${facts.year_text ?? facts.year},`, `, ${year} to ${facts.year},`);
      return done({ ...base, yearText: `${year} to ${facts.year}`, sourceLine, question: ask, options: countOptionCards(values), answer, pointText, count, extremes: { high: rankItem(one), low: tie ? undefined : rankItem(low) }, own: own.own, ownTitle: own.ownTitle, ownNamed: own.ownNamed });
    }
    lines.push(L('ask', `${round}: ${what}. ${ask}`, { gap: 0.15 }));
    lines.push(L('opts', choices, { timer: true, gap: 0.2 }));
    lines.push(reveal, point);
    lines.push(L('ladder', fromTheTop, { gap: 0.45 }));
    const own = ownByRank(facts, r.slice(0, 5).map((row) => row.iso3));
    if (own.line) lines.push(own.line);
    return done({ ...base, question: ask, options: countOptionCards(values), answer, pointText, count, own: own.own, ownTitle: own.ownTitle, ownNamed: own.ownNamed });
  }

  if (kind === 'higher_lower') {
    const duel = duelOf(p, x.exclude, x.duelTurn);
    if (!duel) throw new Error(`${ds.id} cannot carry a higher_lower round`);
    const { ref, target, higher } = duel;
    const question = `Is ${said(target)} higher or lower than ${said(ref)}?`;
    lines.push(L('ask', `${round}: ${what}. Higher or lower?`, { gap: 0.2 }));
    lines.push(L('opts', `{duel.ref|${cap(said(ref))}} is at ${spoken(ref, ds)}. Is {duel.target|${said(target)}} {opt.0|higher}, or {opt.1|lower}?`, { timer: true, gap: 0.2 }));
    lines.push(L('reveal', `${higher ? 'Higher' : 'Lower'}. ${cap(said(target))} is at ${spoken(target, ds)}.`, { gap: 0.35 }));
    lines.push(point);
    lines.push(L('ladder', fromTheTop, { gap: 0.45 }));
    const own = ownByRank(facts, [...r.slice(0, 5).map((row) => row.iso3), ref.iso3, target.iso3]);
    if (own.line) lines.push(own.line);
    return done({
      ...base, question, options: [{ letter: 'A', label: 'Higher' }, { letter: 'B', label: 'Lower' }], answer: higher ? 0 : 1,
      pointText: ['point if you said', higher ? 'higher' : 'lower'], duel: { ref: rankItem(ref), target: rankItem(target), higher },
      own: own.own, ownTitle: own.ownTitle, ownNamed: own.ownNamed,
    });
  }

  // Pick the #1.
  const { options, answer } = pickOptions(facts, x.exclude ?? []);
  const question = v(['Which country is number one?', 'Which country is highest?', 'Who is number one?']);
  lines.push(L('ask', `${round}: ${what}. ${question}`, { gap: 0.15 }));
  lines.push(L('opts', optionsSaid(options.map((o, i) => `{opt.${i}|${i === 0 ? cap(inSentence(o.label)) : inSentence(o.label)}}`)), { timer: true, gap: 0.2 }));
  lines.push(L('reveal', `${cap(said(one))}, at ${spoken(one, ds)}.`, { gap: 0.3 }));
  lines.push(point);
  lines.push(L('ladder', `Then come ${thenCome}.`, { gap: 0.45 }));
  const own = ownByRank(facts, [...r.slice(0, 5).map((row) => row.iso3), ...options.map((o) => o.iso3!)]);
  if (own.line) lines.push(own.line);

  // One comparison to close: how far ahead #1 is of the middle country and of the lowest.
  const mid = medianOf(r.map((row) => row.value));
  const low = r[r.length - 1];
  const overMid = one.value > 0 && mid > 0 ? one.value / mid : 0;
  const overLow = one.value > 0 && low.value > 0 ? one.value / low.value : 0;
  const share = (val: number) => (one.value > 0 ? Math.max(0, Math.min(1, val / one.value)) : 0);
  const bars: GameBar[] = [{ label: one.name, iso2: iso3ToIso2(one.iso3), display: one.display, share: 1, amber: true }];
  const parts: string[] = [];
  // When half the countries share the lowest value, the middle country is just that value.
  if (!tie?.median_at_floor) {
    parts.push(overMid >= 3 ? `That is ${timesSaid(overMid)} the {compare.mid|middle} country.` : `The {compare.mid|middle} country is at ${spoken({ display: facts.world_median }, ds)}.`);
    bars.push({ label: 'The middle country', display: facts.world_median, share: share(mid), note: overMid >= 3 ? `#1 is ${timesShown(overMid)} this` : undefined });
  }
  if (tie) {
    parts.push(tie.none ? `{compare.low|${cap(numWord(tie.count))}} countries have none at all.` : `{compare.low|${cap(numWord(tie.count))}} countries are tied at the bottom, at ${spoken({ display: tie.display }, ds)}.`);
    bars.push({ label: `${tie.count} countries`, display: tie.display, share: share(low.value), note: tie.none ? 'none at all' : 'tied at the bottom' });
  } else {
    parts.push(`The lowest is {compare.low|${said(low)}}, at ${spoken(low, ds)}.`);
    bars.push({ label: `${low.name} (lowest)`, iso2: iso3ToIso2(low.iso3), display: low.display, share: share(low.value), note: overLow >= 3 ? `#1 is ${timesShown(overLow)} this` : undefined });
  }
  lines.push(L('compare', parts.join(' '), { gap: 0.55 }));
  return done({
    ...base, question, options, answer, pointText: ['point if you said', one.name], bars, lowIso: tie ? undefined : low.iso3,
    own: own.own, ownTitle: own.ownTitle, ownNamed: own.ownNamed,
  });
}

// ---------- The cold open: up to two surprises from the rounds, the promise of the ending, the rules.
interface Tease { score: number; round: number; line: GameLine; view: TeaserView; exclude?: string[] }

// "over 600 times", "over 40 times": rounded down, so it is never an overstatement.
function overTimes(r: number): number {
  const unit = r >= 1000 ? 1000 : r >= 100 ? 100 : 10;
  return Math.floor(r / unit) * unit;
}

function teasesFor(i: number, kind: RoundKind, p: PickedMap, then?: CountView): Tease[] {
  const { ds, facts } = p;
  const r = facts.ranking;
  const what = saidTitle(facts.title);
  const panelTitle = `${facts.title.toUpperCase()} · ${facts.year_text ?? facts.year}`;
  const out: Tease[] = [];
  const earlier = -0.02 * i; // on a tie, the earlier round

  // America is good here, but not top five: the surprise a US viewer cares about. Only for rounds
  // where naming the United States gives nothing away (it is then kept out of the choices).
  const usa = find(facts, 'USA');
  if (usa && kind !== 'higher_lower' && !inTie(facts, usa) && usa.rank > 5 && usa.rank <= Math.max(12, r.length * 0.2)) {
    const top = usa.rank <= 10 ? 5 : usa.rank <= 20 ? 10 : 20;
    out.push({
      score: (top === 5 ? 3 : top === 10 ? 2.6 : 2.2) + earlier, round: i, exclude: ['USA'],
      line: L('tease', `America is not even in the top {hit|${numWord(top)}} for ${what}.`, { gap: 0.35 }),
      view: { kind: 'rank', headline: ['AMERICA ISN’T EVEN ', `TOP ${top}`, ''], round: i, rank: { iso3: 'USA', row: rankItem(usa), top, panelTitle } },
    });
  }

  // The gap between first and last, without a name.
  const low = r[r.length - 1];
  if (!facts.bottom_tie && low.value > 0 && r[0].value / low.value >= 20) {
    const times = overTimes(r[0].value / low.value).toLocaleString('en-US');
    out.push({
      score: 2 + Math.min(1.2, Math.log10(r[0].value / low.value) / 3) + earlier, round: i,
      line: L('tease', `${cap(what)}: number one has over {hit|${times}} times as much as the lowest country.`, { gap: 0.35 }),
      view: { kind: 'gap', headline: ['#1 HAS OVER ', `${times}×`, ' THE LOWEST'], round: i, gap: { high: r[0].display, low: low.display, badge: `OVER ${times}× AS MUCH`, panelTitle } },
    });
  } else if (!facts.bottom_tie && low.value > 0 && (ds.suffix || ds.prefix)) {
    const apart = ds.suffix === '%' ? `${formatValue(r[0].value - low.value, { decimals: ds.decimals })} points` : formatValue(r[0].value - low.value, ds);
    out.push({
      score: 1.8 + earlier, round: i,
      line: L('tease', `${cap(what)}: first and last are {hit|${apart}} apart.`, { gap: 0.35 }),
      view: { kind: 'gap', headline: ['', apart.toUpperCase(), ' FROM FIRST TO LAST'], round: i, gap: { high: r[0].display, low: low.display, badge: `${apart.toUpperCase()} APART`, panelTitle } },
    });
  }

  // A then-and-now round's starting count: the question itself is the hook.
  if (kind === 'then_now' && then) {
    const before = then.counts[0];
    const today = then.counts[then.counts.length - 1];
    const year = then.years[0];
    const countries = before === 0 ? 'not one country was' : before === 1 ? 'only one country was' : `${countWord(before)} countries were`;
    out.push({
      score: 2 + Math.abs(today - before) / then.of + (today === 0 ? 0.4 : 0) + earlier, round: i,
      line: L('tease', `${cap(what)}: in ${year}, {hit|${countries}} ${then.phrase}. Guess how many today.`, { gap: 0.35 }),
      view: { kind: 'count', headline: [`${year}: `, countWord(before).toUpperCase(), ` ${before === 1 ? 'COUNTRY' : 'COUNTRIES'} ${then.short.toUpperCase()}. TODAY?`], round: i, count: { year, n: before, phrase: then.short, panelTitle: `${facts.title.toUpperCase()} · ${year}` } },
    });
  }
  return out;
}

const TEASE_ORDER: TeaserView['kind'][] = ['rank', 'count', 'gap'];

// The two strongest surprises, from different rounds and of different kinds when there is a choice.
function pickTeases(all: Tease[]): Tease[] {
  const sorted = [...all].sort((a, b) => b.score - a.score);
  const first = sorted[0];
  if (!first) return [];
  const second = sorted.find((t) => t.round !== first.round && t.view.kind !== first.view.kind) ?? sorted.find((t) => t.round !== first.round);
  return [first, ...(second ? [second] : [])].sort((a, b) => TEASE_ORDER.indexOf(a.view.kind) - TEASE_ORDER.indexOf(b.view.kind));
}

// ---------- The last reveal: the country (or two, or three) in the top ten on the most maps.
function championsOf(picked: PickedMap[]): { champions: Champion[]; times: number } {
  const seen = new Map<string, Champion>();
  for (const p of picked) {
    for (const row of p.facts.ranking.slice(0, 10)) {
      const c = seen.get(row.iso3) ?? { iso3: row.iso3, iso2: iso3ToIso2(row.iso3), name: row.name, maps: [] };
      c.maps.push({ title: p.facts.title, rank: row.rank });
      seen.set(row.iso3, c);
    }
  }
  const times = Math.max(0, ...[...seen.values()].map((c) => c.maps.length));
  const champions = [...seen.values()].filter((c) => c.maps.length === times);
  // One appearance each, or a crowd sharing the lead, is no reveal.
  return times >= 3 && champions.length <= 3 ? { champions, times } : { champions: [], times: 0 };
}

// ---------- The whole plan
export function planGame(theme: Theme, picked: PickedMap[], skipped: string[] = []): GamePlan {
  const total = picked.length;
  const extras = picked.map((p) => ({ then: thenNowOf(p), many: howManyOf(p) }));
  const kinds = roundKinds(picked.map((p, i) => [
    'pick' as RoundKind,
    ...(extras[i].then ? ['then_now' as RoundKind] : []),
    ...(extras[i].many ? ['how_many' as RoundKind] : []),
    ...(duelOf(p) ? ['higher_lower' as RoundKind] : []),
  ]));

  const teases = pickTeases(picked.flatMap((p, i) => teasesFor(i, kinds[i], p, extras[i].then)));
  let duels = 0;
  const rounds = picked.map((p, i): PlannedRound => {
    const x: RoundExtras = { ...extras[i], exclude: teases.filter((t) => t.round === i).flatMap((t) => t.exclude ?? []), duelTurn: kinds[i] === 'higher_lower' ? duels++ : 0 };
    try {
      return buildRound(i + 1, total, kinds[i], p, x);
    } catch (e: any) {
      // A round kind that fails on this week's data must not cost the whole video.
      console.warn(`[longform] round ${i + 1} (${p.ds.id}) could not be a ${kinds[i]} round: ${e.message}; it is a pick round instead`);
      return buildRound(i + 1, total, 'pick', p, x);
    }
  });

  const { champions, times } = championsOf(picked);
  const open: GamePlan['open'] = teases.map((t, i) => ({ line: { ...t.line, id: `tease${i + 1}` }, view: t.view }));
  if (!open.length) {
    // No surprise to lead with: the theme's own opening line over the first map.
    open.push({
      line: L('tease1', theme.intro.replace(/^Ten maps/, `${cap(numWord(total))} maps`), { gap: 0.35 }),
      view: { kind: 'intro', headline: [`${total} MAPS OF `, theme.name.toUpperCase(), ''], round: 0 },
    });
  }
  if (champions.length) {
    const k = champions.length;
    const all = times === total;
    open.push({
      line: L('promise', `And {cards|${k === 1 ? 'one country is' : `${numWord(k)} countries are`}} in the top ten on ${all ? `{hit|all} ${numWord(total)} of these maps` : `{hit|${numWord(times)}} of these ${numWord(total)} maps`}.`, { gap: 0.35 }),
      view: { kind: 'promise', headline: [`${k === 1 ? 'ONE COUNTRY IS' : `${numWord(k).toUpperCase()} COUNTRIES ARE`} TOP 10 ON `, all ? `ALL ${total}` : `${times} OF ${total}`, ' MAPS'], promise: { cards: k, lines: ['TOP 10 ON', all ? `ALL ${total} MAPS` : `${times} OF ${total} MAPS`] } },
    });
  }
  open.push({
    line: L('rules', `{rule.0|${cap(numWord(total))}} rounds. {rule.1|Beat} the timer. {rule.2|Keep} your score.`, { gap: 0.3 }),
    view: { kind: 'rules', headline: ['', '', ''], rules: [{ big: String(total), small: 'ROUNDS' }, { big: '4 s', small: 'BEAT THE TIMER' }, { big: '+1', small: 'KEEP YOUR SCORE' }] },
  });

  const score = L('score', `So, how many did you get out of ${numWord(total)}? {score.ask|Comment} your score.`, { gap: 0 });
  const ending: GameLine[] = champions.length
    ? [
      L('final', `Last one. {final.cards|${champions.length === 1 ? 'One country was' : `${cap(numWord(champions.length))} countries were`}} in the top ten on ${times === total ? `{final.hit|all} ${numWord(total)} maps` : `{final.hit|${numWord(times)}} of the ${numWord(total)} maps`}.`, { gap: 0.75 }),
      L('names', `${namesList(champions.map((c, i) => `{champ.${i}|${i === 0 ? cap(inSentence(c.name)) : inSentence(c.name)}}`))}.`, { gap: 1.9 }),
      score,
    ]
    : [L('final', `That was all ${numWord(total)} rounds.`, { gap: 0.4 }), score];
  return { theme, rounds, open, ending: { lines: ending, champions, times }, skipped };
}

// Every spoken line in order, with where it belongs: the open, a round (0-based) or the ending.
export function gameLines(plan: GamePlan): { part: 'open' | 'round' | 'end'; round: number; line: GameLine }[] {
  return [
    ...plan.open.map((o) => ({ part: 'open' as const, round: -1, line: o.line })),
    ...plan.rounds.flatMap((r, i) => r.lines.map((line) => ({ part: 'round' as const, round: i, line }))),
    ...plan.ending.lines.map((line) => ({ part: 'end' as const, round: -1, line })),
  ];
}
