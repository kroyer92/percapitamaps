// Paste-ready replies to viewer comments, in Niko's style (see README "Comment replies").
// Pure functions, no database or network, so every rule here can be tried on its own.
//
// Every number in a reply comes from the video's own facts (the same ranking the video showed).
// The language model only sorts a comment and may word a reply to a general question; any number
// it writes that is not in the facts throws its reply away.
import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import type { Facts, RankRow } from './facts.js';
import type { CatalogEntry } from './data/catalog.js';
import { countryName } from './data/countries.js';

countries.registerLocale(en as any);

export type CommentKind = 'question' | 'correction' | 'critical' | 'praise' | 'spam' | 'other';
export const KINDS: CommentKind[] = ['question', 'correction', 'critical', 'praise', 'spam', 'other'];

export interface Draft {
  kind: CommentKind;
  countries: string[];   // ISO3 codes the comment names
  reply?: string;        // paste-ready text; absent when the action is not a reply
  action: string;        // the one thing to do, e.g. "Reply with this" or "Heart it. No reply needed."
}

type Unit = Pick<CatalogEntry, 'prefix' | 'suffix' | 'unit' | 'sourceName'>;

// ---------- finding the countries a comment names ----------

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'");

// Extra names people type, and demonyms ("as a Dane", "Danish here").
const EXTRA: Record<string, string> = {
  'united states': 'USA', 'america': 'USA', 'american': 'USA', 'americans': 'USA', 'the states': 'USA',
  'britain': 'GBR', 'great britain': 'GBR', 'england': 'GBR', 'scotland': 'GBR', 'wales': 'GBR', 'british': 'GBR', 'english': 'GBR', 'scottish': 'GBR', 'welsh': 'GBR',
  'holland': 'NLD', 'dutch': 'NLD', 'czech republic': 'CZE', 'czech': 'CZE', 'ivory coast': 'CIV', 'burma': 'MMR',
  'south korea': 'KOR', 'korea': 'KOR', 'north korea': 'PRK', 'russia': 'RUS', 'iran': 'IRN', 'syria': 'SYR', 'vietnam': 'VNM',
  'laos': 'LAO', 'bolivia': 'BOL', 'venezuela': 'VEN', 'tanzania': 'TZA', 'dr congo': 'COD', 'drc': 'COD', 'moldova': 'MDA',
  'taiwan': 'TWN', 'turkey': 'TUR', 'turkiye': 'TUR', 'uae': 'ARE', 'emirates': 'ARE', 'palestine': 'PSE', 'cape verde': 'CPV', 'eswatini': 'SWZ', 'swaziland': 'SWZ',
  'danish': 'DNK', 'dane': 'DNK', 'german': 'DEU', 'germans': 'DEU', 'french': 'FRA', 'indian': 'IND', 'indians': 'IND', 'chinese': 'CHN', 'japanese': 'JPN',
  'canadian': 'CAN', 'canadians': 'CAN', 'australian': 'AUS', 'aussie': 'AUS', 'brazilian': 'BRA', 'mexican': 'MEX', 'swedish': 'SWE', 'swede': 'SWE',
  'norwegian': 'NOR', 'finnish': 'FIN', 'italian': 'ITA', 'spanish': 'ESP', 'polish': 'POL', 'russian': 'RUS', 'turkish': 'TUR', 'korean': 'KOR',
  'pakistani': 'PAK', 'nigerian': 'NGA', 'filipino': 'PHL', 'filipina': 'PHL', 'philippines': 'PHL', 'indonesian': 'IDN', 'irish': 'IRL', 'swiss': 'CHE',
  'portuguese': 'PRT', 'greek': 'GRC', 'egyptian': 'EGY', 'vietnamese': 'VNM', 'thai': 'THA', 'ukrainian': 'UKR', 'romanian': 'ROU', 'kenyan': 'KEN',
  'south african': 'ZAF', 'argentinian': 'ARG', 'argentine': 'ARG', 'colombian': 'COL', 'chilean': 'CHL', 'peruvian': 'PER', 'iranian': 'IRN',
  'israeli': 'ISR', 'saudi': 'SAU', 'saudi arabia': 'SAU', 'bangladeshi': 'BGD', 'malaysian': 'MYS', 'singaporean': 'SGP', 'austrian': 'AUT',
  'belgian': 'BEL', 'hungarian': 'HUN', 'icelandic': 'ISL', 'new zealander': 'NZL', 'estonian': 'EST', 'latvian': 'LVA', 'lithuanian': 'LTU',
  'croatian': 'HRV', 'serbian': 'SRB', 'bulgarian': 'BGR', 'slovak': 'SVK', 'slovenian': 'SVN', 'moroccan': 'MAR', 'algerian': 'DZA',
  'ethiopian': 'ETH', 'ghanaian': 'GHA', 'qatari': 'QAT', 'kuwaiti': 'KWT', 'nepali': 'NPL', 'sri lankan': 'LKA', 'cuban': 'CUB',
};
// Codes only count in capitals, so "us" (the pronoun) is never read as the USA.
const CODES: Record<string, string> = { US: 'USA', USA: 'USA', 'U.S.': 'USA', 'U.S.A.': 'USA', UK: 'GBR', 'U.K.': 'GBR', UAE: 'ARE', DRC: 'COD', KSA: 'SAU', NZ: 'NZL' };

let aliasList: [string, string][] | undefined;
function aliases(): [string, string][] {
  if (aliasList) return aliasList;
  const map = new Map<string, string>();
  const all = countries.getNames('en', { select: 'all' }) as Record<string, string[]>;
  for (const [a2, names] of Object.entries(all)) {
    const iso3 = countries.alpha2ToAlpha3(a2);
    if (!iso3) continue;
    for (const n of [...names, countryName(iso3)]) {
      const k = norm(n).replace(/\s*\(.*\)$/, '').replace(/,.*$/, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
      // Very short names ("Chad" is fine, but nothing under 4 letters) would match ordinary words.
      if (k.length >= 4 && !map.has(k)) map.set(k, iso3);
    }
  }
  for (const [k, v] of Object.entries(EXTRA)) map.set(k, v);
  // "Georgia", "Jordan" and "Chad" can be names; they still count, a wrong match only adds a line.
  aliasList = [...map.entries()].sort((a, b) => b[0].length - a[0].length); // longest first: "South Sudan" before "Sudan"
  return aliasList;
}

export function findCountries(text: string): string[] {
  const found: string[] = [];
  const add = (iso: string) => { if (!found.includes(iso)) found.push(iso); };
  for (const [code, iso] of Object.entries(CODES)) {
    const re = new RegExp(`(^|[^A-Za-z.])${code.replace(/\./g, '\\.')}(?![A-Za-z])`);
    if (re.test(text)) add(iso);
  }
  let t = ` ${norm(text).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const hits: { at: number; iso: string }[] = [];
  for (const [name, iso] of aliases()) {
    const needle = ` ${name} `;
    let at = t.indexOf(needle);
    while (at >= 0) {
      hits.push({ at, iso });
      t = t.slice(0, at) + ' ' + '#'.repeat(name.length) + ' ' + t.slice(at + needle.length); // so "Sudan" can't match inside "South Sudan"
      at = t.indexOf(needle);
    }
    // Possessives: "Denmark's".
    const poss = ` ${name}'s `;
    if (t.includes(poss)) hits.push({ at: t.indexOf(poss), iso });
  }
  for (const h of hits.sort((a, b) => a.at - b.at)) add(h.iso);
  return found;
}

// ---------- wording ----------

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

// "World Bank WDI / ILO" -> "World Bank": viewers know the big name, not the agency behind it.
export function shortSource(sourceName: string): string {
  return sourceName.split('/')[0].replace(/\bWDI\b/, '').replace(/\s+/g, ' ').trim();
}

// The words after a value: "$347" + "of US-priced goods", "4.1%" + "of GDP", "1.45" + "children per woman".
export function unitTail(u: Pick<Unit, 'prefix' | 'suffix' | 'unit'>): string {
  const unit = u.unit.trim();
  if (u.suffix?.trim() === '%') return unit.replace(/^percent\b\s*/i, '');
  if (u.suffix && /[a-z]/i.test(u.suffix)) return ''; // " years", " hours" already say it
  if (u.prefix === '$') return unit.replace(/^(international\s+)?dollars?\b\s*/i, '');
  return unit;
}

function valueText(r: RankRow, u: Unit): string {
  const tail = unitTail(u);
  return tail ? `${r.display} ${tail}` : r.display;
}

function listJoin(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const finish = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[.]+$/, ''); // Niko leaves off the final full stop

// "Same World Bank data (2024): ..." plus a line to compare with, like Niko's own reply.
export function countryReply(facts: Facts, u: Unit, isos: string[], opener: string): string | undefined {
  const rows = isos.map((iso) => facts.ranking.find((r) => r.iso3 === iso)).filter((r): r is RankRow => !!r);
  const missing = isos.filter((iso) => !facts.ranking.some((r) => r.iso3 === iso)).map((iso) => countryName(iso));
  if (!rows.length && !missing.length) return undefined;
  const n = facts.countries_count || facts.ranking.length;
  const src = `Same ${shortSource(u.sourceName)} data (${facts.year_text})`;
  const parts: string[] = [];
  const shown = rows.sort((a, b) => a.rank - b.rank).slice(0, 4); // highest first, as in Niko's reply
  if (shown.length === 1) {
    const r = shown[0];
    parts.push(`${src}: ${r.name} is ${ordinal(r.rank)} highest of ${n} at ${valueText(r, u)}`);
  } else if (shown.length > 1) {
    const items = shown.map((r, i) => `${r.name} ${ordinal(r.rank)} at ${i === 0 ? valueText(r, u) : r.display}`);
    parts.push(`${src}, out of ${n} countries: ${listJoin(items)}`);
  }
  if (missing.length) parts.push(`${listJoin(missing.slice(0, 3))} ${missing.length > 1 ? "aren't" : "isn't"} in this ${facts.year_text} data`);
  if (shown.length) {
    const usa = facts.ranking.find((r) => r.iso3 === 'USA');
    if (usa && !isos.includes('USA')) parts.push(`The US is ${ordinal(usa.rank)} at ${usa.display}`);
    else parts.push(`The world median is ${facts.world_median}`);
  }
  if (!shown.length) parts[0] = `${src}: ${parts[0]}`;
  return finish(`${opener} ${parts.join('. ')}`);
}

// What the map counts, for critical or political comments: no rebuttal, no numbers.
export function metricLine(facts: Facts, u: Unit): string {
  return finish(`Fair point. The map only shows ${lowerFirst(facts.title)} (${facts.unit}), ${shortSource(u.sourceName)} data (${facts.year_text})`);
}

export function sourceReply(facts: Facts, u: Unit): string {
  return finish(`Good question! It's ${shortSource(u.sourceName)} data (${facts.year_text}): ${lowerFirst(facts.title)}, in ${facts.unit}, for ${facts.countries_count} countries`);
}

// ---------- sorting a comment without the model ----------

export function guessKind(text: string): CommentKind {
  const t = text.toLowerCase();
  if (/https?:\/\/|www\.|t\.me\/|whatsapp|telegram|check (out )?my (channel|page)|sub(scribe)? to (me|my)|crypto|forex|investment advice/.test(t)) return 'spam';
  if (/\b(propaganda|biased|bias|fake|lies|lying|bs|bullshit|nonsense|garbage|stupid|slavery|agenda|woke)\b/.test(t)) return 'critical';
  if (/\b(wrong|incorrect|mistake|error|not true|isn't true|that's not|should be|actually)\b/.test(t)) return 'correction';
  if (/\?|^(what|how|why|where|which|who|when|is|are|does|do|can|could|would)\b/.test(t.trim())) return 'question';
  if (/\b(great|love|nice|awesome|amazing|cool|interesting|wow|thanks|thank you|good)\b/.test(t)) return 'praise';
  return 'other';
}

// ---------- the model's suggestion, checked ----------

const NUM = /\d[\d,]*(?:\.\d+)?/g;
const cleanNum = (s: string) => s.replace(/,/g, '').replace(/\.0+$/, '');

// Every number the reply may use: the lines in the fact sheet the model was shown.
export function factSheet(facts: Facts, u: Unit): string[] {
  const n = facts.countries_count || facts.ranking.length;
  const lines = [
    `Metric: ${facts.title} (${facts.unit}), ${shortSource(u.sourceName)} data, year ${facts.year_text}, ${n} countries ranked, highest first`,
    `World median: ${facts.world_median}`,
    ...facts.ranking.slice(0, 5).map((r) => `#${r.rank} ${r.name}: ${r.display}`),
    ...facts.ranking.slice(-3).map((r) => `#${r.rank} ${r.name}: ${r.display}`),
  ];
  const usa = facts.ranking.find((r) => r.iso3 === 'USA');
  if (usa && usa.rank > 5 && usa.rank <= n - 3) lines.push(`#${usa.rank} United States: ${usa.display}`);
  return lines;
}

export const EMOJI = /\p{Extended_Pictographic}/u;
const TEASER = /\b(next video|future video|new video|upcoming|stay tuned|coming soon|subscribe|make a video|part 2|follow for)\b/i;

// Why a model-written reply can't be sent, or undefined if it can.
export function replyProblem(reply: string, sheet: string[]): string | undefined {
  if (!reply.trim()) return 'empty';
  if (EMOJI.test(reply)) return 'emoji';
  if (TEASER.test(reply)) return 'teaser or promise';
  if (reply.split(/\s+/).length > 45) return 'too long';
  const allowed = new Set(sheet.join(' ').match(NUM)?.map(cleanNum) ?? []);
  for (const raw of reply.match(NUM) ?? []) {
    if (!allowed.has(cleanNum(raw))) return `number ${raw} is not in the video's data`;
  }
  return undefined;
}

export interface ModelView { kind?: string; countries?: string[]; reply?: string }

// Puts the deterministic country lookup, the model's view (if any) and the facts together into
// the one action Niko takes. `facts` is missing when the video isn't linked to a job.
export function draftFor(text: string, facts: Facts | undefined, u: Unit | undefined, model?: ModelView): Draft {
  const kind: CommentKind = KINDS.includes(model?.kind as CommentKind) ? (model!.kind as CommentKind) : guessKind(text);
  const valid = (iso: string) => countries.isValid(iso) || !!facts?.ranking.some((r) => r.iso3 === iso);
  const isos = [...new Set([...findCountries(text), ...(model?.countries ?? []).map((c) => String(c).toUpperCase()).filter(valid)])];
  const heart: Draft = { kind, countries: isos, action: 'Heart it. No reply needed.' };

  if (kind === 'spam') return { kind, countries: isos, action: 'Spam: remove it (⋮ → Remove). No reply.' };
  if (!facts || !u) {
    // Nothing to check numbers against, so no numbers.
    if (kind === 'critical') return { kind, countries: isos, reply: 'Fair point', action: 'Reply with this' };
    return heart;
  }
  if (kind === 'critical') return { kind, countries: isos, reply: metricLine(facts, u), action: 'Reply with this' };
  if (isos.length) {
    const opener = openerFor(kind, text, isos.length);
    const reply = countryReply(facts, u, isos, opener);
    if (reply) return { kind, countries: isos, reply, action: 'Reply with this' };
  }
  if (kind === 'question' || kind === 'correction') {
    const sheet = factSheet(facts, u);
    const m = model?.reply ? finish(model.reply) : '';
    if (m && !replyProblem(m, sheet)) return { kind, countries: isos, reply: m, action: 'Reply with this' };
    if (kind === 'correction') return { kind, countries: isos, reply: metricLine(facts, u), action: 'Reply with this' };
    return { kind, countries: isos, reply: sourceReply(facts, u), action: 'Reply with this' };
  }
  return heart;
}

// A short friendly opener, as in Niko's replies.
export function openerFor(kind: CommentKind, text: string, countries: number): string {
  if (kind === 'question') return 'Good question!';
  if (kind === 'correction') return 'Thanks for checking!';
  if (kind === 'praise') return 'Thanks!';
  const pick = /\b(what|how) about\b|\bguess|\bpick|\bmy (vote|bet)\b|\bi (say|think)\b/i.test(text) || text.trim().split(/\s+/).length <= 4;
  return pick ? (countries > 1 ? 'Good picks!' : 'Good pick!') : 'Thanks for watching!';
}

// ---------- the model prompt (local model only: comments are YouTube API data) ----------

export function modelPrompt(text: string, title: string, facts: Facts | undefined, u: Unit | undefined): { system: string; user: string } {
  const system = [
    'You sort viewer comments on a YouTube Shorts channel that shows world maps of open data, and you draft short replies.',
    'Answer with JSON only: {"kind": one of "question","correction","critical","praise","spam","other", "countries": [ISO3 codes of every country the comment names or implies, e.g. "Danish" -> "DNK"], "reply": "..."}.',
    'kind: question = asks something; correction = says a number or rank is wrong; critical = attacks the topic, the metric or politics; praise = compliments or reactions; spam = ads, links, self-promotion; other = anything else.',
    'reply: only for question or correction, otherwise "". At most 35 words. Start with a short friendly opener ("Good question!"). Use only numbers that appear in FACTS, copied exactly. Name the source as in FACTS. No emoji, no hashtags, no promises of future videos, no final full stop. If FACTS cannot answer it, say what the data shows instead.',
  ].join('\n');
  const user = [
    `VIDEO: ${title}`,
    facts && u ? `FACTS:\n${factSheet(facts, u).join('\n')}` : 'FACTS: none (write reply "")',
    `COMMENT: ${text.slice(0, 600)}`,
  ].join('\n\n');
  return { system, user };
}
