// Planned scripts: the code decides the story (which country, which number, which visual in
// each beat) and the language model only writes one spoken line per slot. A small local model
// writes good single sentences but can't plan a story under many rules at once.
import type { Facts, RankRow } from './facts.js';
import { chatJson } from './llm.js';
import { isBanned, numbersIn, wordCount, type Beat, type Script } from './validate.js';

export interface Slot {
  role: 'hook' | 'guess' | 'contender' | 'reveal' | 'closer';
  brief: string; // what the line must say, in plain words
  country?: string; // must appear in the line
  numbers: string[]; // the only numbers the line may use (it must use the first one, if any)
  fallback: string; // used when the model's line breaks a rule
  visual: string;
  on_screen: string;
}

// "the United States", "the Netherlands"; plain names otherwise.
const THE = /^(United |Netherlands|Philippines|Czech|Central African|Dominican|Democratic|Gambia|Bahamas|Maldives|Solomon|Marshall|Comoros|Seychelles)/;
const the = (name: string) => (THE.test(name) ? `the ${name}` : name);
const The = (name: string) => (THE.test(name) ? `The ${name}` : name);

const withUnit = (display: string, unit: string) => (/^[\d.,]+$/.test(display) ? `${display} ${unit}` : display);

// Big countries people tend to guess. Each video uses a different one (picked from the dataset
// id, so the same video always gets the same guess), skipping any in the top 3.
const BIG_GUESSES = ['USA', 'IND', 'CHN', 'BRA', 'RUS', 'GBR', 'DEU', 'JPN'];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function planMapReveal(question: string, f: Facts): Slot[] {
  const top = f.ranking[0];
  const u = f.unit;
  const byIso = new Map(f.ranking.map((r) => [r.iso3, r]));
  const options = BIG_GUESSES.map((iso) => byIso.get(iso)).filter((r): r is RankRow => !!r && r.rank > 3);
  const guess = options.at(hash(f.dataset_id ?? question) % Math.max(1, options.length));
  const contenders = f.ranking.slice(1, 5).reverse(); // #5, #4, #3, #2

  const slots: Slot[] = [{
    role: 'hook',
    brief: `A hook of at most 9 words that makes the viewer want the answer to: "${question}". Do not name any country or number.`,
    numbers: [],
    fallback: question,
    visual: 'map_fill',
    on_screen: question,
  }];
  if (guess) {
    slots.push({
      role: 'guess',
      brief: `Most viewers would guess ${the(guess.name)}. Say that it only has ${withUnit(guess.display, u)}, ranking number ${guess.rank}.`,
      country: guess.name,
      numbers: [guess.display, String(guess.rank)],
      fallback: `You might guess ${the(guess.name)}, but it has only ${withUnit(guess.display, u)}.`,
      visual: `zoom_to:${guess.iso3}`,
      on_screen: `${guess.name}: ${guess.display}`,
    });
  }
  slots.push({
    role: 'contender',
    brief: `Context: the typical country (the world median) has just ${withUnit(f.world_median, u)}.`,
    numbers: [f.world_median],
    fallback: `The typical country has just ${withUnit(f.world_median, u)}.`,
    visual: 'map_fill',
    on_screen: `World median: ${f.world_median}`,
  });
  for (const c of contenders) {
    slots.push({
      role: 'contender',
      brief: `Build suspense: ${the(c.name)} is number ${c.rank} with ${withUnit(c.display, u)}. Mention one thing that makes this surprising, without inventing numbers.`,
      country: c.name,
      numbers: [c.display, String(c.rank)],
      fallback: `${The(c.name)} ranks number ${c.rank}, with ${withUnit(c.display, u)}.`,
      visual: `highlight:${c.iso3}`,
      on_screen: `#${c.rank} ${c.name}`,
    });
  }
  slots.push({
    role: 'reveal',
    brief: `The payoff: number one is ${the(top.name)}, with ${withUnit(top.display, u)}. Make it land.`,
    country: top.name,
    numbers: [top.display],
    fallback: `Number one is ${the(top.name)}, with ${withUnit(top.display, u)}.`,
    visual: 'reveal_answer',
    on_screen: `#1 ${top.name}: ${top.display}`,
  });
  if (f.threshold) {
    slots.push({
      role: 'closer',
      brief: `A closing line: only ${f.threshold.count} countries have ${f.threshold.label}. End on that surprise, so the video can loop back to the question.`,
      numbers: [f.threshold.count],
      fallback: `Only ${f.threshold.count} countries have ${f.threshold.label}.`,
      visual: 'map_fill',
      on_screen: `${f.threshold.count} countries`,
    });
  } else if (f.top_vs_median) {
    slots.push({
      role: 'closer',
      brief: `A closing line: ${the(top.name)} has ${f.top_vs_median} the world median of ${f.world_median}. End on that contrast, so the video can loop back to the question.`,
      country: top.name,
      numbers: [...numbersIn(f.top_vs_median), f.world_median],
      fallback: `That is ${f.top_vs_median} the world median.`,
      visual: 'map_fill',
      on_screen: `${f.top_vs_median} the median`,
    });
  }
  return slots;
}

// Rules for one line. Anything that fails falls back to the slot's template line.
export function lineProblem(line: unknown, s: Slot, topName: string): string | undefined {
  if (typeof line !== 'string' || !line.trim()) return 'empty';
  const w = wordCount(line);
  if (w > (s.role === 'hook' ? 10 : 14)) return 'too long';
  if (s.role !== 'hook' && w < 5) return 'too short';
  if (isBanned(line)) return 'banned phrase';
  if (s.country && !line.toLowerCase().includes(s.country.toLowerCase())) return 'missing country';
  if (s.role !== 'reveal' && s.role !== 'closer' && line.toLowerCase().includes(topName.toLowerCase())) return 'names the answer early';
  const allowed = new Set(s.numbers.flatMap((n) => numbersIn(n)));
  if (numbersIn(line).some((n) => !allowed.has(n))) return 'number not allowed';
  const must = s.numbers[0] ? numbersIn(s.numbers[0]) : [];
  if (must.length && !must.every((n) => numbersIn(line).includes(n))) return 'missing number';
  return undefined;
}

export function slotsUser(slots: Slot[], fixHint?: string): string {
  return `TASK: write the voiceover, one spoken line per slot. The story is already planned; you only write the lines.
Each line: one natural spoken sentence, 7 to 12 words (the hook max 9), that does exactly what its slot says.
Use only the numbers given in the slot, written exactly as given. Always name the slot's country.
${fixHint ? `FIX THIS FROM THE LAST ATTEMPT: ${fixHint}\n` : ''}SLOTS:
${slots.map((s, i) => `${i + 1}. ${s.brief}`).join('\n')}
Return JSON only: {"lines":["line for slot 1","line for slot 2", ...]} with exactly ${slots.length} lines.`;
}

export async function writePlanned(system: string, slots: Slot[], topName: string, fixHint?: string, onStep: (s: string) => void = () => {}): Promise<Script> {
  onStep(`Writing ${slots.length} planned lines`);
  const out = await chatJson<{ lines?: unknown[] }>({ temperature: 0.7, system, user: slotsUser(slots, fixHint), numPredict: 900 }).catch(() => ({ lines: [] as unknown[] }));
  const lines = Array.isArray(out.lines) ? out.lines : [];
  const fixed: string[] = [];
  const beats: Beat[] = slots.map((s, i) => {
    const problem = lineProblem(lines[i], s, topName);
    if (problem) fixed.push(`${i + 1} (${problem})`);
    // filler: planned beats repeat a pattern on purpose, so the repeat check skips them.
    return { vo: problem ? s.fallback : String(lines[i]).trim(), on_screen: s.on_screen, visual: s.visual, emphasis_words: s.country ? [s.country] : [], filler: true };
  });
  if (fixed.length) onStep(`Used the plain line for slot ${fixed.join(', ')}`);
  return { beats };
}
