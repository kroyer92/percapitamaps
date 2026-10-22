// The five language-model prompts from the plan (section B3). Temperatures: angle 0.7,
// script/hooks/packaging 0.6, critic 0.1.
import { config, type Format } from './config.js';

export const ANGLE_SYSTEM = `You choose stories for "${config.channelName}", a YouTube Shorts channel. Each Short reveals one surprising fact about the world, proven by a single public dataset and shown as a map or chart. You never invent numbers. You only propose angles that the listed dataset can prove or disprove. You avoid health advice, financial advice, elections, named private individuals, and tragedies. Questions are about which countries rank highest, how countries compare, or how many countries cross a line; never about the lowest-ranked countries in a way that mocks them.`;

export function angleUser(signals: string, datasets: string, recent: string, count = 8): string {
  return `Trend signals from the last 24 hours:
${signals}
Datasets you may use (id | title | unit | latest_year | countries):
${datasets}
Already published or queued (do not repeat these angles or close variants):
${recent}
Propose ${count} angles. Prefer angles where a viewer in the US or UK would confidently guess wrong. Use a trend signal when one genuinely fits; otherwise pick evergreen angles. About half should be about money, work, prices or technology.
Formats: MAP_REVEAL (world map fills in, twist revealed), COUNTDOWN (top 10 ranking), THEN_NOW (race over decades; only for datasets with a long history), SCALE (only for totals that can be split as "if the world were 100 ..."), GUESS (three options, then the answer).
Return JSON only:
{"angles":[{
 "dataset_id": "...",
 "question": "the viewer-facing question, max 12 words",
 "expected_twist": "the result you expect and why it surprises, max 25 words",
 "format": "MAP_REVEAL|COUNTDOWN|THEN_NOW|SCALE|GUESS",
 "trend_link": "the signal text it rides, or null",
 "scores": {"curiosity":1,"shareability":1,"comment_bait":1,"evergreen":1}
}]}`;
}

// Script, hooks, packaging and the critic all share this system prompt, so it starts with the
// same text every time. Ollama then reuses the already-read FACTS instead of reading them again
// for each call, which is most of the time on a CPU-only server.
export function contentSystem(facts: string): string {
  return `You write and check YouTube Shorts for "${config.channelName}". Each Short reveals one surprising fact, proven by the FACTS below. Style: plain spoken English, short sentences, present tense, no filler words, no "did you know", no "let's dive in", no emojis. The narrator is calm and confident, never hyped. Every number must be copied exactly from FACTS; a number that is not in FACTS may not be stated. Never claim causes the data doesn't show. Countries in visuals use the 3-letter "code" given in FACTS.
FACTS:
${facts}`;
}

const FORMAT_GUIDE: Record<Format, string> = {
  MAP_REVEAL: 'The world map is on screen the whole time. Use map_fill early, zoom_to/highlight (one country each) for named countries, reveal_answer for the twist.',
  COUNTDOWN: 'Count down from #10 to #1 using bar_add visuals; you may group the lower ranks in one beat. The #1 lands in the final third with reveal_answer.',
  THEN_NOW: 'A bar race runs from then_vs_now.start_year to the latest year. Use race_year:{YYYY} visuals in order. Compare where countries started with where they are now.',
  SCALE: 'A grid of 100 people (or 100 units) is on screen. Use scale_grid visuals; each beat lights up one group from if_the_world_were_100.',
  GUESS: 'Beat 2 shows the three options with visual flag_row and asks the viewer to guess. The next beat is only "Think about it." with visual pause. Then reveal_answer, then context.',
};

export function scriptUser(question: string, format: Format, words: [number, number], twist?: string, fixHint?: string): string {
  return `TASK: write the voiceover script.
QUESTION: ${question}
FORMAT: ${format}. ${FORMAT_GUIDE[format]}
${twist ? `EXPECTED TWIST (from the planner; if FACTS don't support it, build the story around what FACTS actually show): ${twist}\n` : ''}Write a script of 7 to 11 beats.
Rules:
- Total spoken words between ${words[0]} and ${words[1]}.
- Beat 1 is the hook: max 9 words, starts mid-thought, and creates a gap only the ending closes. It must NOT name the #1 country or its value.
- Do not name, zoom to or highlight the #1 country, or say its value, before the final third. Build up to it, then name it clearly with its value near the end.
- No beat longer than 8 spoken words. Every beat names a visual change.
- By beat 3, state what most people would guess, so the twist has something to break.
- Every beat adds a new fact or contrast. Never repeat or rephrase an earlier beat.
- The last beat is a sharp final fact or contrast, not a summary. Never "that's the list", "now you know" or similar. It must lead naturally back into beat 1 when the video loops, and must not say "subscribe" or "follow".
- On-screen text is max 6 words per beat and never repeats the voiceover word for word.
- Write numbers as digits exactly as they appear in FACTS (for example "2,389 hours", "$64,000", "71.2%").
- A country visual takes exactly one code from FACTS, for example zoom_to:NZL. Never a list.
${fixHint ? `- FIX THESE PROBLEMS FROM THE LAST ATTEMPT: ${fixHint}\n` : ''}Return JSON only:
{"beats":[{"vo":"...","on_screen":"...","visual":"one of: map_fill, zoom_to:{code}, highlight:{code}, bar_add:{code}, race_year:{YYYY}, counter:{rank}, scale_grid, flag_row, pause, reveal_answer","emphasis_words":["..."]}],
 "loop_check":"one sentence on how the last beat flows into the first"}`;
}

export function hooksUser(question: string, hook: string): string {
  return `TASK: write the first line. The first 1.5 seconds decide whether a viewer swipes. Never name the #1 country or its value; the ending reveals it.
QUESTION: ${question}
CURRENT HOOK: ${hook}
Write 5 alternative opening lines, max 9 words each, one per type:
1 CONTRADICTION: breaks a belief most viewers hold.
2 DIRECT_QUESTION: a question the viewer instantly answers in their head, wrongly.
3 RANK_TEASE: points at the #1 without naming it.
4 YOU: puts the viewer's own country or life in the frame.
5 STAKES: a number or contrast that sounds wrong but is in FACTS.
Then pick the one to test first and say why in max 15 words.
Return JSON only:
{"hooks":[{"type":"CONTRADICTION","text":"..."},{"type":"DIRECT_QUESTION","text":"..."},{"type":"RANK_TEASE","text":"..."},{"type":"YOU","text":"..."},{"type":"STAKES","text":"..."}],"test_first":1,"reason":"..."}`;
}

export function packagingUser(question: string, hook: string, sourceLine: string): string {
  return `TASK: write the metadata. Titles are searchable phrases people actually type, not clickbait.
QUESTION: ${question}
HOOK: ${hook}
SOURCE LINE: ${sourceLine}
Return JSON only:
{
 "title": "max 60 characters; contains a search phrase people type (for example 'countries ranked by', 'which country has the most'); no ALL CAPS words; no hashtags",
 "summary": "one sentence restating the surprise",
 "hashtags": ["#shorts", "two more lowercase topic hashtags like #maps #geography"],
 "pinned_comment": "one question that invites a specific answer (their country, their guess), max 20 words",
 "ig_caption": "2 short lines, no hashtags",
 "ig_hashtags": ["5 lowercase hashtags"],
 "search_tags": ["8 tags, phrases people search"]
}`;
}

export function criticUser(beats: string, packaging: string): string {
  return `TASK: you are now a strict fact-checking editor. Approve nothing that could mislead a viewer.
SCRIPT: ${beats}
PACKAGING: ${packaging}
Check and return JSON only:
{
 "verdict": "pass" | "fail",
 "issues": [
  {"type":"number_not_in_facts|causal_claim|misleading_framing|advice|sensitive|hook_too_long|dead_beat|repetition|loop_broken","beat":1,"detail":"..."}
 ],
 "fix_hint": "one sentence for the writer if verdict is fail"
}
Fail if: any number is not in FACTS; any sentence implies a cause the data doesn't show; the title or hook promises something the video doesn't deliver; any advice about health, money, or law; the hook is over 9 words. Minor style issues are not a reason to fail.`;
}

export const FOLLOWUP_SYSTEM = ANGLE_SYSTEM;
