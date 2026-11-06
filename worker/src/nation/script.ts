// The daily episode's words, written in code from the census (no language model: every number
// comes straight from the census, so nothing can be made up). Each beat's visual tag tells the
// video which scene to show.
import { config } from '../config.js';
import type { Beat } from '../validate.js';
import type { Facts } from '../facts.js';
import type { Packaging } from '../content.js';
import { METRIC, WB_LICENSE } from './data.js';
import type { Census } from './census.js';

const fmt = (n: number) => n.toLocaleString('en-US');
const list = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
// How a country is said in a sentence ("the US", "the UK").
const spoken = (name: string) => ({ 'United States': 'the US', 'United Kingdom': 'the UK', Netherlands: 'the Netherlands', Philippines: 'the Philippines', UAE: 'the UAE', Bahamas: 'the Bahamas', Gambia: 'the Gambia' } as Record<string, string>)[name] ?? name;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function pageAddress(): string {
  return config.nation.domain || 'the link in our profile';
}

export function nationBeats(c: Census): Beat[] {
  const beats: Beat[] = [];
  const add = (visual: string, vo: string, on_screen = '') => beats.push({ vo, on_screen, visual });
  const people = c.n === 1 ? 'citizen' : 'citizens';
  add('nation:hook', c.day === 1 ? `Day 1. This country has ${fmt(c.n)} ${people}, and every one of them is a viewer.` : `Day ${c.day}. This country has ${fmt(c.n)} ${people}.`, `${fmt(c.n)} ${people.toUpperCase()}`);
  if (c.day <= 3 || c.n < 10) add('nation:how', 'Join on our page, and you get a passport and a citizen number.', 'EVERY VIEWER = 1 CITIZEN');
  if (c.day > 1 && c.newSince > 0) add('nation:new', c.newSince === 1 ? 'One new citizen moved in since yesterday. Welcome!' : `${fmt(c.newSince)} new citizens moved in since yesterday. Welcome!`, `+${fmt(c.newSince)} NEW`);
  if (c.top.length >= 3) add('nation:homes', `Most of you come from ${list(c.top.slice(0, 3).map((t) => spoken(t.name)))}.`, 'TOP HOMELANDS');
  else if (c.top.length) add('nation:homes', `So far you come from ${list(c.top.map((t) => spoken(t.name)))}.`, 'HOMELANDS');
  if (c.avg !== null && c.rank !== null && c.display) {
    add('nation:census', c.metric === 'gdp'
      ? `Our average citizen comes from a country earning ${c.display} a person.`
      : `Our average citizen comes from a country where people live ${c.display}.`, c.display);
    const prev = c.ladder.find((r) => r.rank === c.rank! - 1 && !r.us);
    const next = c.ladder.find((r) => r.rank === c.rank! + 1 && !r.us);
    add('nation:rank', c.rank === 1
      ? `That makes us number 1 in the world${next ? `, ahead of ${spoken(next.name)}` : ''}.`
      : `That puts us ${ordinal(c.rank)} in the world, just behind ${spoken(prev!.name)}.`, `#${c.rank}`);
  }
  if (c.passed && c.target) add('nation:target', `We just passed ${spoken(c.passed.name)}! Next up is ${spoken(c.target.name)}, ${fmt(c.target.pop - c.n)} citizens to go.`, c.target.name);
  else if (c.target) add('nation:target', c.n === 0 ? `Even ${spoken(c.target.name)} has ${fmt(c.target.pop)} people.` : `But we're still smaller than ${spoken(c.target.name)}. ${fmt(c.target.pop - c.n)} citizens to go.`, c.target.name);
  if (c.result) add('nation:voted', `You voted, and ${c.result.line}.`, c.result.answer);
  add('nation:cta', !c.vote ? 'Get your free passport with the link in our profile.'
    : c.vote.open ? `Get your free passport with the link in our profile, and vote on ${c.vote.topic}.`
    : `Get your free passport with the link in our profile. At ${fmt(c.vote.from)} citizens, you vote on ${c.vote.topic}.`, 'GET YOUR PASSPORT');
  return beats;
}

export function nationFacts(c: Census): Facts {
  const m = METRIC[c.metric];
  const ranking = c.ladder.filter((r) => !r.us).map((r) => ({ rank: r.rank, iso3: r.iso3, name: r.name, value: r.value, display: r.display }));
  return {
    dataset_id: m.dataset,
    title: `Per Capita Nation census, Day ${c.day}`,
    unit: m.unit,
    year: c.year,
    year_text: String(c.year),
    countries_count: c.of,
    source_line: `Census of our passport page, ${censusStamp(c)}. Country figures: World Bank WDI (${m.title.toLowerCase()} ${c.year}, population ${c.target?.year ?? c.year}).`,
    source_url: m.url,
    license: WB_LICENSE,
    ranking,
    world_median: '',
    anchors: {},
    map: c.citizens,
    decimals: m.decimals,
  };
}

function voteBit(c: Census): string {
  if (!c.vote) return '';
  return c.vote.open ? ` and vote on ${c.vote.topic}` : ` (at ${fmt(c.vote.from)} citizens we vote on ${c.vote.topic})`;
}

export function censusStamp(c: Census): string {
  const d = new Date(c.at);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function nationPackaging(c: Census): Packaging {
  const m = METRIC[c.metric];
  const rankBit = c.rank ? `, #${c.rank} in ${m.label}` : '';
  const title = `Day ${c.day}: our country has ${fmt(c.n)} citizen${c.n === 1 ? '' : 's'}${rankBit} | Per Capita Nation`;
  const page = config.nation.domain ? `https://${config.nation.domain}` : 'the link on our channel page';
  const summary = `Per Capita Nation is a country made of our viewers. Join on our page and you get a passport with a citizen number. Every day the census counts you, averages the real ${m.label} of your home countries, and ranks the nation against real countries.`;
  const description = [
    summary,
    '',
    `Get your passport${voteBit(c)}: ${page}`,
    '',
    `Day ${c.day} census: ${fmt(c.n)} citizens from ${c.homelands} countries${c.display ? `; average ${m.label} of their home countries ${c.display} (${c.covered} citizens with data), #${c.rank} of ${c.of + 1}` : ''}.`,
    `Census taken ${censusStamp(c)}.`,
    '',
    `Country figures: World Bank, World Development Indicators (${m.title} ${c.year}; population ${c.target?.year ?? c.year}), ${WB_LICENSE}. Map shapes: Natural Earth.`,
    '',
    '#shorts #percapitanation #maps #data',
  ].join('\n');
  return {
    title: title.length <= 100 ? title : `Day ${c.day}: ${fmt(c.n)} citizens${rankBit} | Per Capita Nation`,
    summary,
    hashtags: ['#shorts', '#percapitanation', '#maps'],
    pinned_comment: `Get your passport (free, name + country only): ${page}.${c.vote ? c.vote.open ? ` Open vote: ${c.vote.question}` : ` At ${fmt(c.vote.from)} citizens we vote on ${c.vote.topic}.` : ''}`,
    ig_caption: `Day ${c.day} of Per Capita Nation: ${fmt(c.n)} citizens${rankBit}.${c.vote?.open ? ` ${cap(c.vote.question)}` : ''} Get your passport with the link in our bio.`,
    ig_hashtags: ['#percapitanation', '#maps', '#geography', '#data', '#countries'],
    search_tags: ['per capita nation', 'country made of viewers', 'citizen census', 'world bank data', 'per capita', 'country ranking', 'geography'],
    description,
  };
}
