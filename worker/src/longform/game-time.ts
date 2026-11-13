// Lays the game's lines, timers and reveals on one timeline, and derives everything that hangs on
// it: the frames the picture moves on, the sound effects, the chapters and the upload pack.
import { captionWords, FPS, type Placed } from '../timeline.js';
import { RISER_SECONDS, type SfxCue } from '../sfx.js';
import type { VoiceClip, Word } from '../voice.js';
import type { GameCaption, GameProps, GameRound, Phase, Teaser } from '../../remotion/game-types.js';
import type { ThumbProps } from '../../remotion/longform-types.js';
import { COUNT_UP, ownChips } from '../../remotion/game-schedule.js';
import { gameLines, type GameLine, type GamePlan } from './game.js';

export const TIMER = 4; // seconds the viewer gets to guess
const LAPSE = 2.5; // the years run before a then-and-now answer
const LAPSE_SHORT = 1.2; // only two years to show: one step, on the answer
const LEAD = 0.12; // silence before the first word
const GAP = 0.28; // after a line that sets no pause of its own
const STINGER = 0.45; // "ROUND 3" lands before its question
const END_IN = 0.4;
const TAIL = 1.6;
const PRE = 8; // frames a panel changes before its line starts
const TEASER_PRE = 6;
const MIN_CHAPTER = 10; // YouTube shows chapters only when every one is at least 10 seconds

export interface GameTimed {
  seconds: number;
  placed: Placed[]; // every line with its clip, for the voice track
  lines: GameCaption[];
  teasers: Teaser[];
  rounds: GameRound[];
  ending: GameProps['ending'];
  chapters: { at: number; label: string }[];
  sfx: SfxCue[];
}

const F = (sec: number) => Math.round(sec * FPS);

// `clips` are in the order of gameLines(plan). `heard`: Whisper's word timings of the finished
// voice track. Without them each line's words are spread over it by length, so a card that pops on
// a word can be a few frames off; the placement of the lines is the same either way.
export function timeGame(plan: GamePlan, clips: VoiceClip[], heard: Word[] = []): GameTimed {
  const flat = gameLines(plan);
  if (clips.length !== flat.length) throw new Error(`The game has ${flat.length} lines but ${clips.length} voice clips`);
  const placed: Placed[] = [];
  const lines: GameCaption[] = [];
  let t = LEAD;
  let k = 0;
  const say = (prefix: string, line: GameLine, cue: Record<string, number>) => {
    const clip = clips[k++];
    const voiceAt = t;
    const end = voiceAt + clip.seconds;
    const words = captionWords(line.vo, voiceAt, clip.seconds, heard);
    placed.push({ beat: { vo: line.vo, on_screen: '', visual: '' }, clip, visualAt: voiceAt, voiceAt, endAt: end });
    lines.push({ id: `${prefix}.${line.id}`, vo: line.vo, start: F(voiceAt), end: F(end), words });
    cue[line.id] = F(voiceAt);
    cue[`${line.id}.end`] = F(end);
    // A marked word that the captions somehow lack falls back to the start of its line.
    for (const [name, w] of line.marks ?? []) cue[name] = Math.min(F(end), Math.max(F(voiceAt), words[w]?.start ?? F(voiceAt)));
    t = end + (line.gap ?? GAP);
  };

  const teasers: Teaser[] = plan.open.map((o, i) => {
    const cue: Record<string, number> = {};
    const at = t;
    say('open', o.line, cue);
    cue.line = F(at);
    return { ...o.view, start: i === 0 ? 0 : F(at) - TEASER_PRE, cue };
  });

  const starts: number[] = [];
  const cues = plan.rounds.map((r) => {
    const cue: Record<string, number> = {};
    starts.push(t);
    t += STINGER;
    for (const line of r.lines) {
      say(`r${r.view.n}`, line, cue);
      if (!line.timer) continue;
      cue.timer = F(t);
      t += TIMER;
      if (!line.lapse) continue;
      const years = r.view.count?.years.length ?? 2;
      const secs = years > 2 ? LAPSE : LAPSE_SHORT;
      cue.lapse = F(t);
      // The years in between step early, so the last breath before the answer is the longest.
      for (let y = 1; y < years - 1; y++) cue[`lapse.${y}`] = F(t + (secs * 0.75 * y) / (years - 1));
      t += secs;
      cue[`lapse.${years - 1}`] = F(t);
    }
    return cue;
  });

  const endStart = t;
  t += END_IN;
  const endCue: Record<string, number> = {};
  for (const line of plan.ending.lines) say('end', line, endCue);
  if (endCue.names !== undefined) endCue.reveal = endCue.names;
  const seconds = t + TAIL;

  const rounds: GameRound[] = plan.rounds.map((r, i) => {
    const cue = cues[i];
    const start = F(starts[i]);
    const phases: Phase[] = [{ key: 'ask', from: start }];
    for (const key of ['ladder', 'extremes', 'own', 'compare'] as const) if (cue[key] !== undefined) phases.push({ key, from: cue[key] - PRE });
    phases.sort((a, b) => a.from - b.from);
    return { ...r.view, start, end: F(starts[i + 1] ?? endStart), phases, cue };
  });
  const ending: GameProps['ending'] = { start: F(endStart), cue: endCue, champions: plan.ending.champions, times: plan.ending.times };

  const marks = [
    { at: 0, label: 'Intro' },
    ...plan.rounds.map((r, i) => ({ at: starts[i], label: `Round ${r.view.n}: ${r.view.title}` })),
    { at: endStart, label: plan.ending.champions.length ? 'The last reveal' : 'Your score' },
  ];
  return { seconds, placed, lines, teasers, rounds, ending, chapters: chapters(marks, seconds), sfx: soundCues(teasers, rounds, ending) };
}

// Chapters for the description. One shorter than 10 seconds would make YouTube drop them all, so a
// short one joins its neighbour: a short intro becomes part of round 1, a short ending part of the
// last round.
export function chapters(marks: { at: number; label: string }[], seconds: number): { at: number; label: string }[] {
  const out = marks.map((m) => ({ ...m }));
  if (out.length > 1 && out[1].at < MIN_CHAPTER) out.splice(0, 2, { at: 0, label: out[1].label });
  for (let i = out.length - 1; i > 0; i--) {
    const end = out[i + 1]?.at ?? seconds;
    if (end - out[i].at < MIN_CHAPTER) out.splice(i, 1);
  }
  return out;
}

// Where the sounds go, from the same frames the picture uses.
function soundCues(teasers: Teaser[], rounds: GameRound[], ending: GameProps['ending']): SfxCue[] {
  const out: SfxCue[] = [{ sound: 'hit', at: 0 }];
  const s = (frame: number) => frame / FPS;
  const tick = (...frames: (number | undefined)[]) => { for (const f of frames) if (f !== undefined) out.push({ sound: 'tick', at: s(f) }); };
  const whoosh = (frame: number | undefined, lead = 0.1) => { if (frame !== undefined) out.push({ sound: 'whoosh', at: s(frame) - lead }); };
  // A riser into the answer and a hit on it.
  const land = (frame: number | undefined) => { if (frame !== undefined) out.push({ sound: 'riser', at: s(frame) - RISER_SECONDS }, { sound: 'hit', at: s(frame) }); };
  // A number running up: quick ticks.
  const run = (frame: number | undefined) => { if (frame !== undefined) for (let i = 0; i < 8; i++) tick(frame + i * 4); };

  teasers.forEach((t, i) => {
    const q = t.cue;
    if (i > 0) whoosh(q.line);
    if (t.kind === 'rank' && q.hit !== undefined) for (let j = 0; j < 5; j++) tick(q.hit - 14 + j * 4);
    else if (t.kind === 'rules') tick(q['rule.0'], q['rule.1'], q['rule.2']);
    else if (t.kind === 'promise') {
      for (let j = 0; j < (t.promise?.cards ?? 1); j++) tick((q.cards ?? q.line) + j * 5);
      tick(q.hit);
    }
    else if (t.kind === 'count') run(q.hit);
    else tick(q.hit);
  });

  for (const r of rounds) {
    const q = r.cue;
    whoosh(r.start, 0);
    run(q['then.count']);
    tick(q['duel.ref'], q['duel.target'], q['opt.0'], q['opt.1'], q['opt.2']);
    // A clock on the timer: a tick every half second, so the wait never falls silent.
    if (q.timer !== undefined) for (let i = 0; i < TIMER * 2; i++) out.push({ sound: 'tick', at: s(q.timer) + i / 2 });
    if (q.lapse !== undefined) {
      tick(q.lapse);
      for (let y = 1; q[`lapse.${y + 1}`] !== undefined; y++) tick(q[`lapse.${y}`]);
    }
    land(q.reveal);
    if (r.kind === 'how_many') run(q.reveal);
    tick(q.point);
    if (q.ladder !== undefined) {
      if (q['ladder.1'] !== undefined) whoosh(q['ladder.1'], 0.2); // the map flies to #1
      tick(q['ladder.1'], q['ladder.2'], q['ladder.3'], q['ladder.4'], q['ladder.5']);
    }
    whoosh(q['ext.high'], 0.25);
    whoosh(q['ext.low'], 0.25);
    if (q.own !== undefined) {
      whoosh(q.own);
      tick(...ownChips(r).map((c) => c.at));
    }
    if (q.compare !== undefined) {
      whoosh(q.compare);
      tick(q['compare.mid'], q['compare.low']);
      if (r.lowIso) whoosh(q['compare.low'], 0.25); // the map flies to the lowest country
    }
  }

  const q = ending.cue;
  whoosh(ending.start, 0);
  if (ending.champions.length) {
    ending.champions.forEach((_, i) => tick((q['final.cards'] ?? q.final) + i * 5));
    tick(q['final.hit']);
    land(q.reveal);
    ending.champions.forEach((_, i) => { if (i > 0) tick(q[`champ.${i}`]); });
  }
  whoosh(q.score);
  whoosh(q['score.ask'], 0.2);
  return out.filter((c) => c.at >= 0).sort((a, b) => a.at - b.at);
}

export function gameProps(plan: GamePlan, timed: GameTimed, handle: string): GameProps {
  return {
    durationInFrames: Math.ceil(timed.seconds * FPS), handle, themeName: plan.theme.name, timer: TIMER * FPS,
    lines: timed.lines, teasers: timed.teasers, rounds: timed.rounds, ending: timed.ending,
  };
}

// The thumbnail asks; it never shows an answer (the first map's #1 in amber would give round 1 away).
export function gameThumbProps(plan: GamePlan): ThumbProps {
  return quizThumb(plan.theme.name, plan.rounds.length, plan.rounds[0].facts.map);
}
export function quizThumb(themeName: string, rounds: number, map: Record<string, number>): ThumbProps {
  return { line1: 'MAP QUIZ', line2: themeName.toUpperCase(), line3: `GET ${rounds}/${rounds}?`, map, quiz: true };
}

function clock(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function gamePackaging(plan: GamePlan, timed: GameTimed, n: number, musicCredit?: string) {
  const theme = plan.theme;
  const total = plan.rounds.length;
  // Titles are written for 10 rounds; a week with another number says how many there are.
  const fix = (t: string) => t.replace(/\b10\b/, String(total));
  const titles = theme.quiz.map(fix);
  const sources = [...new Map(plan.rounds.map((r) => [r.dataset_id, `${r.facts.title}: ${r.facts.source_line.replace(/^Data: /, '')} ${r.facts.source_url}`])).values()];
  const description = [
    `A map quiz with real numbers: ${total} rounds on ${theme.name.toLowerCase()}. Guess before the timer runs out, keep your score, and see where your own country lands.`,
    '',
    ...timed.chapters.map((c) => `${clock(c.at)} ${c.label}`),
    '',
    'Sources (latest year with data; territories under 300,000 people left out):',
    ...sources.map((s) => `• ${s}`),
    musicCredit ? `\nMusic: ${musicCredit}` : '',
    '',
    'Spotted a mistake? Say so in the comments. Corrections get pinned.',
    '',
    '#maps #geography #quiz',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: titles[(n - 1) % titles.length], title_options: titles, description,
    tags: [...new Set([...theme.tags, 'map quiz', 'geography quiz', 'guess the country'])],
    pinned_comment: `How many did you get out of ${total}? Comment your score.`,
  };
}

// The script as text, for the Telegram preview, the logs and `npm run longform -- --plan`.
export function gameScript(plan: GamePlan): string {
  return [
    'COLD OPEN', ...plan.open.map((o) => `  ${o.line.vo}`),
    ...plan.rounds.flatMap((r) => ['', `ROUND ${r.view.n} · ${r.view.tag} · ${r.view.title} (${r.view.yearText})`, ...r.lines.map((l) => `  ${l.vo}${l.timer ? `  [${TIMER} s timer]` : ''}`)]),
    '', 'ENDING', ...plan.ending.lines.map((l) => `  ${l.vo}`),
  ].join('\n');
}
