// The daily census of Per Capita Nation: how many citizens, where they come from, and where the
// nation would rank among real countries if its citizens' home countries were averaged.
import { config } from '../config.js';
import { one, q } from '../db.js';
import { localDate, zonedToUtc } from '../lib/time.js';
import { countryTable, fmtMetric, metricValue, type CountryTable, type Metric } from './data.js';

// What the viewers vote on, one question at a time and in this order. A question opens once the
// nation has NATION_VOTE_FROM citizens, and is decided at the first census where it has
// NATION_VOTE_MIN votes; then the next one opens. When all are decided, voting stops.
export interface Vote { key: string; topic: string; question: string; options: string[]; result: (x: string) => string }
export const VOTES: Vote[] = [
  { key: 'flag', topic: 'our flag', question: 'What colours should our flag be?', options: ['Navy and amber', 'Red and white', 'Green and gold', 'Black and sky blue'], result: (x) => `our flag is now ${x.toLowerCase()}` },
  { key: 'capital', topic: 'the name of our capital', question: 'What should we call our capital?', options: ['Median City', 'Port Average', 'New Percapita', 'Datatown'], result: (x) => `our capital is called ${x}` },
  { key: 'motto', topic: 'our motto', question: 'Which motto should we pick?', options: ['Every person counts', 'Divide and share', 'Small but mighty', 'Per person, for all'], result: (x) => `our motto is "${x}"` },
  { key: 'animal', topic: 'our national animal', question: 'What should our national animal be?', options: ['Puffin', 'Capybara', 'Red panda', 'Sea otter'], result: (x) => `our national animal is the ${x.toLowerCase()}` },
  { key: 'dish', topic: 'our national dish', question: 'What should our national dish be?', options: ['Pizza', 'Dumplings', 'Tacos', 'Pancakes'], result: (x) => `our national dish is ${x.toLowerCase()}` },
  { key: 'sport', topic: 'our national sport', question: 'What should our national sport be?', options: ['Football', 'Chess', 'Basketball', 'Cricket'], result: (x) => `our national sport is ${x.toLowerCase()}` },
];
// The question waiting for votes: the first one not decided yet.
export const openVote = (state: Record<string, string>): Vote | undefined => VOTES.find((v) => !(v.key in state));
// The colours the flag vote gives the flag on the island and the passport (same order as its options).
export const FLAG_COLOURS: [string, string][] = [['#0f2a3d', '#f0b04a'], ['#d62828', '#ffffff'], ['#1b7a3e', '#f2c230'], ['#111111', '#7db8de']];

export interface Person { no: number; name: string; iso3: string }
export interface Row { iso3: string; name: string; value: number; display: string; rank: number }
export interface Census {
  day: number;
  at: string; // when the census was taken (ISO)
  n: number;
  newSince: number; // joined since the last census (on Day 1: everyone)
  newest: Person[]; // up to 3 of them, newest first
  homelands: number;
  top: { iso3: string; name: string; count: number }[];
  citizens: Record<string, number>;
  metric: Metric;
  year: number;
  avg: number | null; // over citizens whose home has a figure
  display: string | null;
  covered: number;
  rank: number | null; // among real countries
  of: number;
  ladder: (Row & { us?: boolean })[]; // two countries above, the nation, one below
  target: { iso3: string; name: string; pop: number; year: number } | null; // the smallest country still bigger
  passed: { iso3: string; name: string; pop: number } | null; // a country passed since the last census
  // The question after this census: open (enough citizens) or waiting for citizens; null when all are decided.
  vote: { key: string; topic: string; question: string; options: string[]; open: boolean; from: number; votes: number; min: number } | null;
  result: { key: string; answer: string; line: string; votes: number; total: number } | null; // of the previous vote
  state: Record<string, string>; // what the votes decided so far: flag, capital, ...
}

// Day 1 is NATION_START; the day number counts calendar days in SLOT_TZ.
export function dayNumber(at: Date): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(config.nation.start);
  if (!m) return undefined;
  const d = localDate(at, config.slotTz);
  return Math.round((Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86_400_000) + 1;
}

// The day's publish slot and its census time.
export function dayTimes(at: Date): { slot: Date; census: Date } {
  const d = localDate(at, config.slotTz);
  const [hh, mm] = config.nation.slot.split(':').map(Number);
  const slot = zonedToUtc(d.y, d.m, d.d, hh, mm || 0, config.slotTz);
  return { slot, census: new Date(+slot - config.nation.leadHours * 3600_000) };
}

// The votes so far on one question, per option.
// What the votes have decided so far (flag, capital, ...), as of the latest episode.
export async function decided(): Promise<Record<string, string>> {
  return (await one<{ state: Record<string, string> }>(`SELECT census->'state' AS state FROM nation_days ORDER BY day DESC LIMIT 1`))?.state ?? {};
}

export async function tallyOf(v: Vote): Promise<number[]> {
  const rows = await q<{ choice: number; n: number }>('SELECT choice, count(*)::int AS n FROM nation_votes WHERE topic = $1 GROUP BY choice', [v.key]);
  return v.options.map((_, i) => rows.find((r) => r.choice === i)?.n ?? 0);
}

export function computeCensus(opts: {
  day: number; at: Date; table: CountryTable; people: Person[]; lastNo: number;
  prevN: number | null; tally: number[]; state: Record<string, string>; voteFrom: number; voteMin: number;
}): Census {
  const { day, table, people } = opts;
  const metric: Metric = day % 2 === 1 ? 'gdp' : 'le';
  const citizens: Record<string, number> = {};
  for (const p of people) citizens[p.iso3] = (citizens[p.iso3] ?? 0) + 1;
  const name = (iso: string) => table.byIso.get(iso)?.name ?? iso;
  const top = Object.entries(citizens).sort((a, b) => b[1] - a[1] || name(a[0]).localeCompare(name(b[0]))).slice(0, 5).map(([iso3, count]) => ({ iso3, name: name(iso3), count }));
  const fresh = people.filter((p) => p.no > opts.lastNo);
  const newest = [...fresh].sort((a, b) => b.no - a.no).slice(0, 3);

  // The nation's figure: the average over citizens, each counting their home country's value once.
  let sum = 0, covered = 0;
  for (const p of people) { const v = metricValue(table.byIso.get(p.iso3), metric); if (v !== undefined) { sum += v; covered++; } }
  const real = table.rows.filter((r) => metricValue(r, metric) !== undefined)
    .map((r) => ({ iso3: r.iso3, name: r.name, value: metricValue(r, metric)! }))
    .sort((a, b) => b.value - a.value)
    .map((r, i) => ({ ...r, rank: i + 1, display: fmtMetric(r.value, metric) }));
  let avg: number | null = null, rank: number | null = null, ladder: Census['ladder'] = [];
  if (covered) {
    // Rounded the way it is shown, so the ladder and the voice never disagree with the screen.
    avg = metric === 'gdp' ? Math.round(sum / covered) : Math.round((sum / covered) * 10) / 10;
    const above = real.filter((r) => r.value > avg!);
    rank = above.length + 1;
    const below = real.filter((r) => r.value <= avg!);
    ladder = [
      ...above.slice(-2),
      { iso3: '', name: 'Per Capita Nation', value: avg, display: fmtMetric(avg, metric), rank, us: true },
      ...below.slice(0, 1).map((r) => ({ ...r, rank: r.rank + 1 })),
    ];
  }

  const byPop = table.rows.filter((r) => r.pop).sort((a, b) => a.pop! - b.pop!);
  const t = byPop.find((r) => r.pop! > people.length);
  const prev = opts.prevN ?? 0;
  const passedRow = [...byPop].reverse().find((r) => r.pop! <= people.length && r.pop! > prev);

  // The open question is decided once it has enough votes (and voting is open at all).
  let result: Census['result'] = null;
  const state = { ...opts.state };
  const asked = openVote(state);
  const total = opts.tally.reduce((a, b) => a + b, 0);
  if (asked && people.length >= opts.voteFrom && total >= opts.voteMin) {
    const best = opts.tally.indexOf(Math.max(...opts.tally));
    const answer = asked.options[best];
    state[asked.key] = answer;
    result = { key: asked.key, answer, line: asked.result(answer), votes: opts.tally[best], total };
  }
  const v = openVote(state);
  return {
    day, at: opts.at.toISOString(), n: people.length, newSince: day === 1 ? people.length : fresh.length, newest,
    homelands: Object.keys(citizens).length, top, citizens, metric, year: table.years[metric],
    avg, display: avg === null ? null : fmtMetric(avg, metric), covered, rank, of: real.length, ladder,
    target: t ? { iso3: t.iso3, name: t.name, pop: t.pop!, year: table.years.pop } : null,
    passed: passedRow && opts.prevN !== null ? { iso3: passedRow.iso3, name: passedRow.name, pop: passedRow.pop! } : null,
    vote: v ? { key: v.key, topic: v.topic, question: v.question, options: v.options, open: people.length >= opts.voteFrom, from: opts.voteFrom, votes: result ? 0 : total, min: opts.voteMin } : null,
    result, state,
  };
}

// Takes the census from the database (the citizens who joined up to now) for the given day.
export async function takeCensus(day: number, at = new Date()): Promise<Census> {
  const table = await countryTable();
  const people = await q<Person>('SELECT no, name, iso3 FROM nation_citizens WHERE joined_at <= $1 ORDER BY no', [at]);
  const prev = await one<{ census: Census }>('SELECT census FROM nation_days WHERE day < $1 ORDER BY day DESC LIMIT 1', [day]);
  const lastNo = prev ? Math.max(0, ...(await q<{ no: number }>('SELECT max(no)::int AS no FROM nation_citizens WHERE joined_at <= $1', [prev.census.at])).map((r) => r.no ?? 0)) : 0;
  // What earlier votes decided comes from the last episode, so making a day again (or a test) is safe.
  const state = prev?.census.state ?? {};
  const asked = openVote(state);
  const tally = asked ? await tallyOf(asked) : [];
  const census = computeCensus({ day, at, table, people, lastNo, prevN: prev?.census.n ?? null, tally, state, voteFrom: config.nation.voteFrom, voteMin: config.nation.voteMin });
  return census;
}
