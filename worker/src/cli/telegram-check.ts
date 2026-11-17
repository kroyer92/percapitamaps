// Offline check that preview captions can never break Telegram's HTML parser again (job #84,
// "can't parse entities: Unclosed start tag at byte offset 1038"). Cuts a full-size preview caption
// at every possible length and checks each result parses. Run: npm run telegram-check
import { esc, fitHtml, htmlToPlain, isEntityError } from '../telegram.js';

/** The same rules Telegram applies to parse_mode HTML, as far as our captions go. */
function parseError(h: string): string {
  const stack: string[] = [];
  const at = (i: number) => Buffer.byteLength(h.slice(0, i));
  for (let i = 0; i < h.length; i++) {
    if (h[i] === '<') {
      const j = h.indexOf('>', i);
      if (j < 0) return `Unclosed start tag at byte offset ${at(i)}`;
      const t = h.slice(i + 1, j);
      if (t.startsWith('/')) { if (stack.pop() !== t.slice(1)) return `Unmatched end tag at byte offset ${at(i)}`; }
      else stack.push(t.split(' ')[0]);
      i = j;
    } else if (h[i] === '&' && !/^&(lt|gt|amp|quot|#\d+);/.test(h.slice(i))) return `Bad entity at byte offset ${at(i)}`;
  }
  return stack.length ? `Can't find end tag for "${stack.at(-1)}"` : '';
}

// Shaped like job #84's preview: Countdown, five hooks, two QA warnings, multi-byte · ▶ ⚠️ and a "&".
const caption = (pad: number) => [
  `<b>#84</b> · Countdown · am_michael · 31.4 s · written by ${esc('qwen3:8b, llama-3.3-70b-versatile')}`,
  `<b>Q:</b> ${esc('Which country has the highest life expectancy for women?')}`,
  `<b>Hook now:</b> ${esc("Women here live to 87.9 — and it isn't Japan.")}`,
  ...['question', 'shock stat', 'myth bust', 'challenge', 'curiosity gap'].map((t, i) => `${i === 0 ? '▶' : `${i + 1}.`} ${esc(t)}: ${esc('Women in one country now outlive everyone else by years <guess where> before #1 drops.')}`),
  `<b>Title:</b> ${esc(`Where Women Live Longest${'!'.repeat(pad)} #shorts`)}`,
  `<b>Why this video:</b> ${esc('evergreen angle')} · ${esc('Not Japan: Hong Kong & South Korea edge in.')}`,
  `<b>Source:</b> ${esc('World Bank (WDI SP.DYN.LE00.FE.IN), from UN WPP 2024 · CC BY 4.0')}`,
  esc('⚠️ Visual change every 3 s: beat 4: 3.4 s, beat 7: 3.2 s\n⚠️ Voice says the script: word error rate 6.1%; said "outlive", heard "out live"'),
].join('\n');

let oldBroken = 0, failures = 0, cases = 0;
for (let pad = 0; pad < 200; pad++) {
  const c = caption(pad);
  for (let limit = 40; limit <= 1024; limit++) {
    cases++;
    if (parseError(c.slice(0, limit))) oldBroken++;
    const fitted = fitHtml(c, limit);
    const err = parseError(fitted);
    const len = htmlToPlain(fitted).length;
    if (err || len > limit) { failures++; if (failures < 5) console.log(`FAIL pad ${pad} limit ${limit}: ${err || `${len} > ${limit}`}`); }
  }
}
const sample = caption([...Array(200).keys()].find((p) => parseError(caption(p).slice(0, 1024)).startsWith("Unclosed")) ?? 0);
console.log(`Old .slice(0, 1024) on a job #84-sized caption: ${parseError(sample.slice(0, 1024)) || 'parses'}`);
console.log(`fitHtml on the same caption: ${parseError(fitHtml(sample)) || 'parses'}`);
console.log(`${cases} cuts: the old slice broke ${oldBroken}, fitHtml broke ${failures}.`);
if (!isEntityError("Bad Request: can't parse entities: Unclosed start tag at byte offset 1038")) { console.log('FAIL: entity error not recognised'); failures++; }
process.exit(failures ? 1 : 0);
