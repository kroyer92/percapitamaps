// Code checks on the model's output. Numbers are the main thing: every number in the
// voiceover, on-screen text and title must appear in the facts.

export interface Beat { vo: string; on_screen: string; visual: string; emphasis_words?: string[] }
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

const BANNED = [/\bsubscribe\b/i, /\bfollow (us|me|for)\b/i, /did you know/i, /let'?s dive in/i, /\bsmash\b/i];

export function checkScript(script: Script, allowed: Set<string>, words: [number, number]): string[] {
  const errors: string[] = [];
  if (!script || !Array.isArray(script.beats)) return ['Output has no "beats" array.'];
  const beats = script.beats;
  if (beats.length < 6 || beats.length > 12) errors.push(`Use 7 to 11 beats (you wrote ${beats.length}).`);
  const total = beats.reduce((s, b) => s + wordCount(b.vo ?? ''), 0);
  if (total < words[0] || total > words[1]) errors.push(`Total spoken words must be ${words[0]}-${words[1]} (you wrote ${total}).`);
  beats.forEach((b, i) => {
    if (!b.vo || typeof b.vo !== 'string') { errors.push(`Beat ${i + 1} has no vo.`); return; }
    const w = wordCount(b.vo);
    if (w > 12) errors.push(`Beat ${i + 1} has ${w} spoken words; max 8.`);
    if (i === 0 && w > 10) errors.push(`The hook (beat 1) has ${w} words; max 9.`);
    if (b.on_screen && wordCount(b.on_screen) > 7) errors.push(`Beat ${i + 1} on-screen text is too long; max 6 words.`);
    for (const re of BANNED) if (re.test(b.vo) || re.test(b.on_screen ?? '')) errors.push(`Beat ${i + 1} uses a banned phrase (${re.source}).`);
    for (const n of [...numbersIn(b.vo), ...numbersIn(b.on_screen ?? '')]) {
      if (!allowed.has(n)) errors.push(`Beat ${i + 1} uses the number ${n}, which is not in FACTS. Copy numbers exactly from FACTS.`);
    }
  });
  return errors;
}

export function checkText(label: string, text: string, allowed: Set<string>): string[] {
  return numbersIn(text).filter((n) => !allowed.has(n)).map((n) => `${label} uses the number ${n}, which is not in FACTS.`);
}
