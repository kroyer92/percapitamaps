// Planned scripts: the code decides the story (which country, which number, which visual in
// each beat) and the language model only writes one spoken line per slot. A small local model
// writes good single sentences but can't plan a story under many rules at once.
import { config, type Format } from './config.js';
import type { Facts, RankRow } from './facts.js';
import { chatJson } from './llm.js';
import { isBanned, numbersIn, wordCount, type Beat, type Script } from './validate.js';

export interface Slot {
  role: 'hook' | 'guess' | 'contender' | 'reveal' | 'closer' | 'then' | 'group' | 'options' | 'fixed';
  brief: string; // what the line must say, in plain words
  country?: string; // must appear in the line
  numbers: string[]; // the only numbers the line may use (it must use the first one, if any)
  fallback: string; // used when the model's line breaks a rule
  alts?: string[]; // other plain lines that say the same thing; the one used least lately wins
  visual: string;
  on_screen: string;
}

// "the United States", "the Netherlands"; plain names otherwise.
const THE = /^(United |Netherlands|Philippines|Czech|Central African|Dominican|Democratic|Gambia|Bahamas|Maldives|Solomon|Marshall|Comoros|Seychelles)/;
const the = (name: string) => (THE.test(name) ? `the ${name}` : name);
const The = (name: string) => (THE.test(name) ? `The ${name}` : name);

// One angle per contender, so the build-up lines don't all share one sentence pattern. Each video
// starts at a different angle (see ctx.seed), so the #5 line isn't worded the same way every day.
const ANGLES = [
  'Open with the country name and say it is far above most of the world.',
  'Open with the number, then say which country it is.',
  'Say what makes this country a surprising place to rank this high, without inventing numbers.',
  'Say it is close to the top but still not number one.',
  'Ask a short question, then answer it with the country and number.',
  'Start with a short transition word, then the country and the number.',
];

// One slot per country group in the "world of 100" picture. Countries with the same count share
// a line, and each line gets its own shape and plain fallback, so they don't all sound alike.
type ScaleGroup = { name: string; iso3?: string; people: number };
const SCALE_SHAPES: { brief: string; fallback: (names: string, n: number) => string }[] = [
  { brief: 'Say it plainly, as the first and biggest group.', fallback: (x, n) => `${x} would get ${n} of the 100.` },
  { brief: 'Open with the number, then the country. Do not repeat words from the line before.', fallback: (x, n) => `${n} more belong to ${x}.` },
  { brief: 'Keep it short and punchy, like a quick count.', fallback: (x, n) => `${x}? Just ${n}.` },
  { brief: 'Say how small or big that share feels. Do not repeat earlier phrasing.', fallback: (x, n) => `Only ${n} would come from ${x}.` },
  { brief: 'Mention it in passing, as the count goes on.', fallback: (x, n) => `Then ${x}, with ${n}.` },
];
function scaleGroupSlots(groups: ScaleGroup[]): Slot[] {
  const merged: { names: string[]; people: number }[] = [];
  for (const g of groups.filter((x) => x.iso3)) {
    const last = merged.at(-1);
    if (last && last.people === g.people) last.names.push(g.name);
    else merged.push({ names: [g.name], people: g.people });
  }
  const slots: Slot[] = merged.map((m, i) => {
    const shape = SCALE_SHAPES[i % SCALE_SHAPES.length];
    const both = m.names.length > 1;
    const names = both ? `${m.names.slice(0, -1).map(the).join(', ')} and ${the(m.names.at(-1)!)}` : the(m.names[0]);
    const line = both ? `${names} would have ${m.people} each.` : shape.fallback(names, m.people);
    return {
      role: 'group',
      brief: `${names} would have ${m.people}${both ? ' each' : ''} of the 100. ${shape.brief}`,
      country: m.names[0],
      numbers: [String(m.people), '100'], // the first is required; "of the 100" is fine
      fallback: line[0].toUpperCase() + line.slice(1),
      visual: 'scale_grid',
      on_screen: `${m.names.join(' + ')}: ${m.people}${both ? ' each' : ''}`,
    };
  });
  const rest = groups.find((g) => !g.iso3);
  if (rest) slots.push({
    role: 'group',
    brief: `Everyone else in the world shares the last ${rest.people}. Make the contrast land.`,
    numbers: [String(rest.people), '100'],
    fallback: `The whole rest of the world shares just ${rest.people}.`,
    visual: 'scale_grid',
    on_screen: `Rest of the world: ${rest.people}`,
  });
  return slots;
}

// Plain backup lines for contenders, in different shapes, for when the model's line fails a check.
const CONTENDER_LINES: ((name: string, rank: number, value: string) => string)[] = [
  (n, r, v) => `${The(n)} ranks number ${r}, with ${v}.`,
  (n, r, v) => `Number ${r} is ${the(n)}: ${v}.`,
  (n, r, v) => `Then comes ${the(n)}, at ${v}, in number ${r}.`,
  (n, r, v) => `${The(n)} has ${v}. That is number ${r}.`,
  (n, r, v) => `At number ${r} sits ${the(n)}, with ${v}.`,
  (n, r, v) => `Next up, ${the(n)}: ${v}, good for number ${r}.`,
];
const contenderLines = (name: string, rank: number, value: string, start: number) =>
  CONTENDER_LINES.map((_, k) => CONTENDER_LINES[(start + k) % CONTENDER_LINES.length](name, rank, value));

const withUnit = (display: string, unit: string) => (/^[\d.,]+$/.test(display) ? `${display} ${unit}` : display);

// Big countries people tend to guess. The guess rotates per dataset (picked from the dataset id, so
// the same video always gets the same guess) among the three that rank highest, so it is a country
// people would really name ("richest": the US, not Brazil at #68).
const BIG_GUESSES = ['USA', 'IND', 'CHN', 'BRA', 'RUS', 'GBR', 'DEU', 'JPN'];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

interface Ctx { question: string; f: Facts; u: string; top: RankRow; seed: number }

const hookSlot = ({ question }: Ctx, visual: string): Slot => ({
  role: 'hook',
  brief: `A hook of at most 9 words that makes the viewer want the answer to: "${question}". Do not name any country or number.`,
  numbers: [],
  fallback: question,
  visual,
  on_screen: question,
});

function guessSlot({ f, u, question }: Ctx, minRank: number, visual: (iso: string) => string): Slot | undefined {
  const byIso = new Map(f.ranking.map((r) => [r.iso3, r]));
  const options = BIG_GUESSES.map((iso) => byIso.get(iso))
    .filter((r): r is RankRow => !!r && r.rank > minRank && r.iso3 !== f.ranking.at(-1)?.iso3) // the closer names the last one
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
  const guess = options.at(hash(f.dataset_id ?? question) % Math.max(1, options.length));
  if (!guess) return undefined;
  return {
    role: 'guess',
    brief: `Most viewers would guess ${the(guess.name)}. Say that it only has ${withUnit(guess.display, u)}, ranking number ${guess.rank}.`,
    country: guess.name,
    numbers: [guess.display, String(guess.rank)],
    fallback: `You might guess ${the(guess.name)}, but it has only ${withUnit(guess.display, u)}.`,
    alts: [
      `Most people would say ${the(guess.name)}. It has just ${withUnit(guess.display, u)}.`,
      `${The(guess.name)} seems the obvious pick, yet it only has ${withUnit(guess.display, u)}.`,
      `Not ${the(guess.name)}: it sits at number ${guess.rank}, with ${withUnit(guess.display, u)}.`,
      `Guess ${the(guess.name)}? It only reaches ${withUnit(guess.display, u)}, number ${guess.rank}.`,
    ],
    visual: visual(guess.iso3),
    on_screen: `${guess.name}: ${guess.display}`,
  };
}

const medianSlot = ({ f, u }: Ctx, visual: string): Slot => ({
  role: 'contender',
  brief: `Context: the typical country (the world median) has just ${withUnit(f.world_median, u)}.`,
  numbers: [f.world_median],
  fallback: `The typical country has just ${withUnit(f.world_median, u)}.`,
  alts: [
    `For comparison, the world median is ${withUnit(f.world_median, u)}.`,
    `Half of all countries have less than ${withUnit(f.world_median, u)}.`,
    `A country in the middle of the pack has ${withUnit(f.world_median, u)}.`,
  ],
  visual,
  on_screen: `World median: ${f.world_median}`,
});

// #5, #4, #3, #2 (or a shorter run), each with its own angle.
const contenderSlots = ({ f, u, seed }: Ctx, from: number, visual: (iso: string) => string): Slot[] =>
  f.ranking.slice(1, from).reverse().map((c, i) => ({
    role: 'contender',
    brief: `${the(c.name)} is number ${c.rank} with ${withUnit(c.display, u)}. ${ANGLES[(seed + i) % ANGLES.length]}`,
    country: c.name,
    numbers: [c.display, String(c.rank)],
    ...(([first, ...rest]) => ({ fallback: first, alts: rest }))(contenderLines(c.name, c.rank, withUnit(c.display, u), seed + i)),
    visual: visual(c.iso3),
    on_screen: `#${c.rank} ${c.name}`,
  }));

const revealSlot = ({ f, u, top }: Ctx, lead = 'number one is'): Slot => ({
  role: 'reveal',
  brief: `The payoff: ${lead} ${the(top.name)}, with ${withUnit(top.display, u)}.${f.top_vs_median ? ` If you compare it with the median, it is ${f.top_vs_median} the median; never say any other multiple.` : ''} Make it land.`,
  country: top.name,
  numbers: [top.display, ...(f.top_vs_median ? [f.top_vs_median] : [])],
  fallback: `${lead.charAt(0).toUpperCase()}${lead.slice(1)} ${the(top.name)}, with ${withUnit(top.display, u)}.`,
  alts: lead === 'number one is' ? [
    `The top spot goes to ${the(top.name)}, with ${withUnit(top.display, u)}.`,
    `${The(top.name)} leads the world, with ${withUnit(top.display, u)}.`,
    `And number one: ${the(top.name)}, at ${withUnit(top.display, u)}.`,
  ] : undefined,
  visual: 'reveal_answer',
  on_screen: `#1 ${top.name}: ${top.display}`,
});

function closerSlot({ f, top }: Ctx, visual: string): Slot | undefined {
  if (f.threshold) {
    return {
      role: 'closer',
      brief: `A closing line: only ${f.threshold.count} countries have ${f.threshold.label}. End on that surprise, so the video can loop back to the question.`,
      numbers: [f.threshold.count],
      fallback: `Only ${f.threshold.count} countries have ${f.threshold.label}.`,
      alts: [
        `In the whole world, only ${f.threshold.count} countries have ${f.threshold.label}.`,
        `Just ${f.threshold.count} countries on Earth have ${f.threshold.label}.`,
      ],
      visual,
      on_screen: `${f.threshold.count} countries`,
    };
  }
  // The reveal already gives the multiple of the median, so the closer contrasts the top with the
  // bottom instead of saying the same thing twice.
  const last = f.ranking.at(-1);
  if (last && last.iso3 !== top.iso3) {
    return {
      role: 'closer',
      brief: `A closing line: at the other end, ${the(last.name)} has just ${withUnit(last.display, f.unit)}. End on that contrast, so the video can loop back to the question.`,
      country: last.name,
      numbers: [last.display],
      fallback: `At the other end, ${the(last.name)} has just ${withUnit(last.display, f.unit)}.`,
      alts: [
        `Compare that with ${the(last.name)}: just ${withUnit(last.display, f.unit)}.`,
        `${The(last.name)}, in last place, has ${withUnit(last.display, f.unit)}.`,
        `At the bottom of the list sits ${the(last.name)}, at ${withUnit(last.display, f.unit)}.`,
      ],
      visual,
      on_screen: `Last: ${last.name} ${last.display}`,
    };
  }
  return undefined;
}

const nameOf = (s: string) => s.split(': ')[0];
const valueOf = (s: string) => s.split(': ').slice(1).join(': ');

// One story per format. Formats the code can't plan (missing facts) return undefined and
// fall back to the old single-prompt writer.
export function planFor(format: Format, question: string, f: Facts): Slot[] | undefined {
  const top = f.ranking[0];
  if (!top) return undefined;
  const c: Ctx = { question, f, u: f.unit, top, seed: hash(`${f.dataset_id ?? ''}|${question}`) };
  const keep = (xs: (Slot | undefined)[]) => xs.filter((x): x is Slot => !!x);

  if (format === 'MAP_REVEAL') {
    return keep([
      hookSlot(c, 'map_fill'),
      config.guessBeat ? guessSlot(c, 5, (iso) => `zoom_to:${iso}`) : undefined, // never a country the build-up names again
      medianSlot(c, 'map_fill'),
      ...contenderSlots(c, 5, (iso) => `highlight:${iso}`),
      revealSlot(c),
      closerSlot(c, 'map_fill'),
    ]);
  }

  if (format === 'COUNTDOWN') {
    const low = f.ranking.slice(5, 10).reverse(); // #10 .. #6
    const names = low.map((r) => the(r.name));
    const lowList = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    // The map sits above the ladder: it flies to each country as the voice names it.
    return keep([
      hookSlot(c, 'map_fill'),
      low.length ? {
        role: 'contender',
        brief: `Quickly run through numbers ${low[0].rank} to ${low.at(-1)!.rank}: ${lowList}. Names only, no values.`,
        numbers: [String(low[0].rank), String(low.at(-1)!.rank)],
        fallback: `Numbers ${low[0].rank} to ${low.at(-1)!.rank}: ${lowList}.`,
        visual: 'map_fill',
        on_screen: `#${low[0].rank} to #${low.at(-1)!.rank}`,
      } as Slot : undefined,
      guessSlot(c, 10, (iso) => `zoom_to:${iso}`), // gets a pinned row of its own under the ladder
      ...contenderSlots(c, 5, (iso) => `highlight:${iso}`),
      revealSlot(c),
      closerSlot(c, 'map_fill'),
    ]);
  }

  if (format === 'THEN_NOW' && f.series) {
    const s = f.series;
    const then = s.start_top3.map(nameOf);
    const now = f.ranking.slice(0, 3);
    return keep([
      hookSlot(c, `race_year:${s.start_year}`),
      {
        role: 'then',
        brief: `Back in ${s.start_year}, the top three were ${then.map(the).join(', ')}. Set the scene.`,
        numbers: [String(s.start_year)],
        fallback: `In ${s.start_year}, the leaders were ${then.slice(0, -1).map(the).join(', ')} and ${the(then.at(-1) ?? '')}.`,
        visual: `race_year:${s.start_year}`,
        on_screen: `${s.start_year}: #1 ${then[0]}`,
      },
      {
        role: 'then',
        brief: `Back then, the typical country had ${withUnit(s.start_median, c.u)}; today it is ${withUnit(f.world_median, c.u)}.`,
        numbers: [s.start_median, f.world_median],
        fallback: `The typical country went from ${withUnit(s.start_median, c.u)} to ${withUnit(f.world_median, c.u)}.`,
        visual: `race_year:${Math.round((s.start_year + f.year) / 2)}`,
        on_screen: `Median: ${s.start_median} → ${f.world_median}`,
      },
      ...now.slice(1).reverse().map((r, i): Slot => ({
        role: 'contender',
        brief: `Today ${the(r.name)} is number ${r.rank} with ${withUnit(r.display, c.u)}. ${ANGLES[(c.seed + i + 1) % ANGLES.length]}`,
        country: r.name,
        numbers: [r.display, String(r.rank)],
        fallback: `Today ${the(r.name)} ranks number ${r.rank}, with ${withUnit(r.display, c.u)}.`,
        visual: `race_year:${f.year}`,
        on_screen: `#${r.rank} ${r.name}`,
      })),
      revealSlot(c, `in ${f.year}, number one is`),
      then[0] && then[0] !== top.name ? {
        role: 'closer',
        brief: `A closing line: in ${s.start_year} the leader was ${the(then[0])}, with ${valueOf(s.start_top3[0])}. Contrast that with today, so the video can loop back to the question.`,
        country: then[0],
        numbers: [String(s.start_year), valueOf(s.start_top3[0])],
        fallback: `In ${s.start_year}, ${the(then[0])} led with ${valueOf(s.start_top3[0])}.`,
        visual: `race_year:${f.year}`,
        on_screen: `${s.start_year} leader: ${then[0]}`,
      } as Slot : closerSlot(c, `race_year:${f.year}`),
    ]);
  }

  if (format === 'SCALE' && f.scale) {
    const groups = f.scale.groups;
    const what = f.title.toLowerCase();
    const [g1, g2] = groups.filter((g) => g.iso3);
    return keep([
      // The hook may say "100": the whole picture is built on it.
      { ...hookSlot(c, 'scale_grid'), numbers: ['100'], brief: `A hook of at most 9 words that makes the viewer want the answer to: "${c.question}". Do not name any country. The only number you may use is 100.` },
      {
        role: 'then',
        brief: `Set up the picture: shrink the whole world's ${what} down to just 100.`,
        numbers: ['100'],
        fallback: `Shrink the whole world's ${what} down to just 100.`,
        visual: 'map_fill', // not a scale_grid beat, so the first group lights on the next one
        on_screen: 'If the world were 100',
      },
      ...scaleGroupSlots(groups),
      g1 && g2 ? {
        role: 'group',
        brief: `Together, ${the(g1.name)} and ${the(g2.name)} would have ${g1.people + g2.people} of the 100. Make it land.`,
        country: g1.name,
        numbers: [String(g1.people + g2.people), '100'],
        fallback: `Together, ${the(g1.name)} and ${the(g2.name)} would have ${g1.people + g2.people} of the 100.`,
        visual: 'reveal_answer',
        on_screen: `${g1.name} + ${g2.name}: ${g1.people + g2.people}`,
      } as Slot : undefined,
      {
        role: 'closer',
        brief: `A closing line: the world total is ${withUnit(f.scale.world_total, c.u)}. End so the video can loop back to the question.`,
        numbers: [f.scale.world_total],
        fallback: `The real world total is ${f.scale.world_total}.`,
        visual: 'scale_grid',
        on_screen: `Total: ${f.scale.world_total}`,
      },
    ]);
  }

  if (format === 'GUESS' && f.guess) {
    const opts = f.guess.options;
    const list = opts.map((o) => `${o.letter}, ${the(o.name)}`).join('; ');
    // The options are on screen from the first frame. Context comes before the pause, so nothing
    // stands between the pause and the answer; after it, the map shows the answer and #2.
    return keep([
      hookSlot(c, 'map_fill'),
      {
        role: 'options',
        brief: `Ask the viewer to pick one: ${list}. Name all three in order.`,
        numbers: [],
        fallback: `Is it ${opts.map((o) => the(o.name)).slice(0, -1).join(', ')}, or ${the(opts.at(-1)!.name)}?`,
        visual: 'flag_row',
        on_screen: 'Pick one',
      },
      medianSlot(c, 'flag_row'),
      { role: 'fixed', brief: 'Write exactly: Think about it.', numbers: [], fallback: 'Think about it.', visual: 'pause', on_screen: `${opts.map((o) => o.letter).slice(0, -1).join(', ')} or ${opts.at(-1)!.letter}?` },
      revealSlot(c, 'the answer is'),
      ...contenderSlots(c, 3, (iso) => `highlight:${iso}`).slice(-1), // #2
      closerSlot(c, 'map_fill'),
    ]);
  }
  return undefined;
}

const MAX_WORDS = 14; // the same limit validate.ts checks every beat against

// Rules for one line. Anything that fails falls back to the slot's template line.
export function lineProblem(line: unknown, s: Slot, topName: string): string | undefined {
  if (s.role === 'fixed') return 'fixed line';
  if (typeof line !== 'string' || !line.trim()) return 'empty';
  const w = wordCount(line);
  if (w > (s.role === 'hook' ? 10 : MAX_WORDS)) return 'too long';
  if (s.role !== 'hook' && w < 5) return 'too short';
  if (isBanned(line)) return 'banned phrase';
  if (s.country && !line.toLowerCase().includes(s.country.toLowerCase())) return 'missing country';
  const early = s.role === 'hook' || s.role === 'guess' || s.role === 'contender';
  if (early && topName && line.toLowerCase().includes(topName.toLowerCase())) return 'names the answer early';
  const allowed = new Set(s.numbers.flatMap((n) => numbersIn(n)));
  if (numbersIn(line).some((n) => !allowed.has(n))) return 'number not allowed';
  const must = s.numbers[0] ? numbersIn(s.numbers[0]) : [];
  if (must.length && !must.every((n) => numbersIn(line).includes(n))) return 'missing number';
  // A question has to come before its answer: "Iceland is number 5 with $98,323. What's the fifth
  // richest country?" asks what the line just said.
  const q = line.lastIndexOf('?');
  if (q >= 0 && must.length && !must.every((n) => numbersIn(line.slice(q + 1)).includes(n))) return 'question after the answer';
  return undefined;
}

export function slotsUser(slots: Slot[], fixHint?: string, avoid: string[] = []): string {
  return `TASK: write the voiceover, one spoken line per slot. The story is already planned; you only write the lines.
Each line: one natural spoken sentence, 7 to 12 words (the hook max 9), that does exactly what its slot says.
Use only the numbers given in the slot, written exactly as given. Always name the slot's country.
Start every line differently: never reuse a sentence pattern such as "X has N, but...", and never repeat a phrase (like "in this tiny world") across lines.
${avoid.length ? `Recent videos already used these phrases, so do not use them: ${avoid.map((p) => `"${p}"`).join(', ')}.\n` : ''}${fixHint ? `FIX THIS FROM THE LAST ATTEMPT: ${fixHint}\n` : ''}SLOTS:
${slots.map((s, i) => `${i + 1}. ${s.brief}`).join('\n')}
Return JSON only: {"lines":["line for slot 1","line for slot 2", ...]} with exactly ${slots.length} lines.`;
}

// A three-word phrase may appear in two lines, not three ("in this tiny world" every line).
const phrases = (line: string) => {
  const w = line.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(w.slice(2).map((_, i) => w.slice(i, i + 3).join(' ')));
};
// Phrases the plan itself repeats (the unit, "cattle per person", is in every slot) don't count.
const overused = (line: string, seen: Map<string, number>, planned: Set<string>) => [...phrases(line)].some((p) => !planned.has(p) && (seen.get(p) ?? 0) >= 2);
function plannedPhrases(slots: Slot[]): Set<string> {
  const count = new Map<string, number>();
  for (const s of slots) phrases(`${s.brief} ${s.fallback}`).forEach((p) => count.set(p, (count.get(p) ?? 0) + 1));
  return new Set([...count].filter(([, n]) => n >= 2).map(([p]) => p));
}
const remember = (line: string, seen: Map<string, number>) => phrases(line).forEach((p) => seen.set(p, (seen.get(p) ?? 0) + 1));

// Across videos: a three-word phrase that two of the recent videos already said is stale ("number
// one is", "has just", "dwarfs the"). Phrases of only small words ("one of the") or with a country
// name in them ("the united states") don't count: the plan picks the countries, not the wording.
const SMALL = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'is', 'it', 'and', 'or', 'but', 'that', 'this', 'with', 'for', 'one', 'by', 'as', 'are', 'its', "it's", 'has', 'have', 'than', 'more', 'most', 'just', 'only', 'per']);
export function stalePhrases(recent: string[][], slots: Slot[], countryNames: string[] = []): Set<string> {
  const nameWords = new Set(countryNames.flatMap((n) => n.toLowerCase().split(/[^a-z']+/)).filter((w) => w && !SMALL.has(w)));
  const planned = plannedPhrases(slots);
  const count = new Map<string, number>();
  for (const video of recent) {
    const once = new Set(video.flatMap((l) => [...phrases(l)]));
    once.forEach((p) => count.set(p, (count.get(p) ?? 0) + 1));
  }
  return new Set([...count].filter(([p, n]) => n >= 2 && !planned.has(p) && p.split(' ').some((w) => !SMALL.has(w)) && !p.split(' ').some((w) => nameWords.has(w))).map(([p]) => p));
}
const staleIn = (line: string, stale: Set<string>) => [...phrases(line)].filter((p) => stale.has(p)).length;
// A line's shape: country names become "xx" and numbers "nn", so "Number 4 is India: 2,100 hours."
// and "Number 3 is Costa Rica: 2,149 hours." are seen as the same sentence.
function shaper(countryNames: string[]) {
  const names = [...countryNames].sort((a, b) => b.length - a.length).map((n) => n.toLowerCase());
  return (line: string) => {
    let t = ` ${line.toLowerCase()} `;
    for (const n of names) if (t.includes(n)) t = t.split(n).join(' xx ');
    return phrases(t.replace(/\d[\d,.]*/g, ' nn ').replace(/\bthe xx\b/g, 'xx'));
  };
}
// The plain line for a slot: of its versions, the one whose shape this video and the last few
// videos used least. Ties keep the order, which the plan already rotates per video.
// A plain line also has to fit the spoken-word limit. With a long unit ("812 applications per
// million people") some versions don't, so those are left out; if none fit, the unit is dropped
// from the line (the map key and captions still show it).
function plainLine(s: Slot, shape: (l: string) => Set<string>, usedHere: Set<string>, usedLately: Set<string>, unit = ''): string {
  const all = [s.fallback, ...(s.alts ?? [])];
  const fits = (l: string) => wordCount(l) <= MAX_WORDS;
  let options = all.filter(fits);
  if (!options.length && unit) options = all.map((l) => l.split(` ${unit}`).join('')).filter(fits);
  if (!options.length) options = all;
  const score = (l: string) => [...shape(l)].reduce((n, p) => n + (usedHere.has(p) ? 3 : 0) + (usedLately.has(p) ? 1 : 0), 0);
  return options.reduce((best, l) => (score(l) < score(best) ? l : best));
}

// recent: the spoken lines of the last few videos, one array per video.
export async function writePlanned(system: string, slots: Slot[], topName: string, fixHint?: string, onStep: (s: string) => void = () => {}, recent: string[][] = [], countryNames: string[] = [], unit = ''): Promise<Script> {
  onStep(`Writing ${slots.length} planned lines`);
  const stale = stalePhrases(recent, slots, countryNames);
  const shape = shaper(countryNames);
  const usedLately = new Set(recent.slice(0, 3).flatMap((v) => v.flatMap((l) => [...shape(l)])));
  const usedHere = new Set<string>();
  const avoid = [...stale].slice(0, 25);
  const out = await chatJson<{ lines?: unknown[] }>({ temperature: 0.8, system, user: slotsUser(slots, fixHint, avoid), numPredict: 900 }).catch(() => ({ lines: [] as unknown[] }));
  const lines = Array.isArray(out.lines) ? out.lines : [];
  const fixed: string[] = [];
  const seen = new Map<string, number>(); // three-word phrase -> lines that used it
  const planned = plannedPhrases(slots);
  const beats: Beat[] = slots.map((s, i) => {
    let problem = lineProblem(lines[i], s, topName);
    if (!problem && overused(String(lines[i]), seen, planned)) problem = 'repeats a phrase';
    if (!problem && staleIn(String(lines[i]), stale)) problem = 'same wording as recent videos';
    const vo = problem ? (s.role === 'fixed' ? s.fallback : plainLine(s, shape, usedHere, usedLately, unit)) : String(lines[i]).trim();
    remember(vo, seen);
    shape(vo).forEach((p) => usedHere.add(p));
    if (problem && s.role !== 'fixed') fixed.push(`${i + 1} (${problem})`);
    // filler: planned beats repeat a pattern on purpose, so the repeat check skips them.
    return { vo, on_screen: s.on_screen, visual: s.visual, emphasis_words: s.country ? [s.country] : [], filler: true };
  });
  if (fixed.length) onStep(`Used the plain line for slot ${fixed.join(', ')}`);
  return { beats };
}
