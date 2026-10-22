// The writing half of production: script, hooks, packaging and the critic, with code checks
// between every step. No database access here, so test-render can use it directly.
import { config, FORMAT_NAMES, type Format } from './config.js';
import { chatJson } from './llm.js';
import { factsForLlm, type Facts } from './facts.js';
import * as P from './prompts.js';
import { allowedNumbers, checkScript, checkText, isBanned, numbersIn, wordCount, type Script } from './validate.js';

export interface Hook { type: string; text: string }
export interface Packaging {
  title: string;
  summary: string;
  hashtags: string[];
  pinned_comment: string;
  ig_caption: string;
  ig_hashtags: string[];
  search_tags: string[];
  description?: string;
}
export interface Critic { verdict: string; issues: { type: string; beat?: number; detail: string }[]; fix_hint?: string }

export interface Content {
  script: Script;
  originalHook: string;
  hooks: Hook[];
  chosenHook: number; // index into hooks; -1 means the script's own first line
  hookType: string;
  packaging: Packaging;
  critic: Critic;
}

export class NeedsHuman extends Error {
  constructor(message: string, public detail?: unknown) { super(message); }
}

export function wordsFor(band?: string): [number, number] {
  const m = band?.match(/^(\d+)-(\d+)$/);
  const [lo, hi] = m ? [Number(m[1]), Number(m[2])] : [22, 40];
  return [Math.round(lo * 2.7), Math.round(hi * 2.7)];
}

async function writeScript(question: string, format: Format, factsText: string, allowed: Set<string>, words: [number, number], twist?: string, fixHint?: string): Promise<Script> {
  let hint = fixHint;
  let last: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const script = await chatJson<Script>({ temperature: 0.6, system: P.SCRIPT_SYSTEM, user: P.scriptUser(question, format, factsText, words, twist, hint), numPredict: 2000 });
    const errors = checkScript(script, allowed, [Math.round(words[0] * 0.9), Math.round(words[1] * 1.1)]);
    if (!errors.length) return script;
    last = errors;
    hint = [fixHint, ...errors].filter(Boolean).join(' ');
  }
  throw new NeedsHuman('The script failed the code checks three times.', last);
}

export function buildDescription(p: Packaging, facts: Facts, musicCredit?: string): string {
  return [
    p.summary,
    '',
    `Source: ${facts.source_line.replace(/^Data: /, '')} ${facts.source_url}`,
    `Method: latest year with data for ${facts.countries_count} countries; regional aggregates and territories under 300,000 people removed.`,
    musicCredit ? `Music: ${musicCredit}` : '',
    '',
    'Spotted a mistake? Say so in the comments. Corrections get pinned.',
    '',
    p.hashtags.join(' '),
  ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n').trim();
}

export function seriesTitle(title: string, format: Format, n?: number): string {
  if (!config.seriesNaming || !n) return title;
  return `${title} | ${FORMAT_NAMES[format].replace('If the World Were 100 People', '100 People')} #${n}`;
}

export async function generateContent(opts: {
  question: string;
  format: Format;
  facts: Facts;
  twist?: string;
  lengthBand?: string;
  hookType?: string;
}): Promise<Content> {
  const { question, format, facts } = opts;
  const llmFacts = factsForLlm(facts, format);
  const factsText = JSON.stringify(llmFacts, null, 1);
  const allowed = allowedNumbers(llmFacts, question);
  const words = wordsFor(opts.lengthBand);

  let fixHint: string | undefined;
  for (let round = 0; round < 2; round++) {
    const script = await writeScript(question, format, factsText, allowed, words, opts.twist, fixHint);
    const originalHook = script.beats[0].vo;

    // Hooks: keep only the ones that pass the same number and length checks.
    const h = await chatJson<{ hooks: Hook[]; test_first: number }>({ temperature: 0.6, system: P.HOOKS_SYSTEM, user: P.hooksUser(question, originalHook, factsText) });
    const hooks = (h.hooks ?? []).filter((x) => x?.text && wordCount(x.text) <= 10 && !isBanned(x.text) && numbersIn(x.text).every((n) => allowed.has(n))).slice(0, 5);
    let chosen = -1;
    if (opts.hookType) chosen = hooks.findIndex((x) => x.type === opts.hookType);
    if (chosen < 0 && hooks.length) chosen = Math.max(0, Math.min(hooks.length - 1, (h.test_first ?? 1) - 1));
    if (chosen >= 0) script.beats[0].vo = hooks[chosen].text;
    if (wordCount(question) <= 9) script.beats[0].on_screen = question;

    const pk = await chatJson<Packaging>({ temperature: 0.6, system: P.PACKAGING_SYSTEM, user: P.packagingUser(question, script.beats[0].vo, factsText, facts.source_line) });
    pk.title = (pk.title ?? question).replace(/#\S+/g, '').trim().slice(0, 70);
    pk.hashtags = (pk.hashtags ?? ['#shorts', '#maps', '#geography']).slice(0, 3);
    pk.search_tags = (pk.search_tags ?? []).slice(0, 10);
    pk.ig_hashtags = (pk.ig_hashtags ?? []).slice(0, 5);
    // A title or summary with a number that isn't in the facts falls back to the question.
    if (checkText('title', pk.title, allowed).length) pk.title = question.slice(0, 70);
    if (!pk.summary || checkText('summary', pk.summary, allowed).length) pk.summary = question;

    const critic = await chatJson<Critic>({ temperature: 0.1, system: P.CRITIC_SYSTEM, user: P.criticUser(factsText, JSON.stringify(script.beats), JSON.stringify(pk)) });
    if (critic.verdict === 'pass') {
      return { script, originalHook, hooks, chosenHook: chosen, hookType: chosen >= 0 ? hooks[chosen].type : 'SCRIPT', packaging: pk, critic };
    }
    fixHint = critic.fix_hint || critic.issues?.map((i) => i.detail).join(' ');
    if (round === 1) throw new NeedsHuman('The fact-check critic failed the script twice.', critic);
  }
  throw new NeedsHuman('unreachable');
}
