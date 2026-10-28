import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';
import { llmEnd, llmStart, llmTokens } from './activity.js';

interface ChatOpts { temperature: number; system: string; user: string; numPredict?: number }

// "fetch failed" alone says nothing; add the address, the low-level reason and how long it ran.
function explain(e: any, base: string, started: number): Error {
  const c = e?.cause ?? (e?.code ? { code: e.code } : undefined);
  const why = c ? [c.code, c.message].filter(Boolean).join(' ') : '';
  return new Error(`${e?.message ?? e}${why ? ` (${why})` : ''} at ${base} after ${Math.round((Date.now() - started) / 1000)} s`);
}

async function chatAt(base: string, o: ChatOpts): Promise<string> {
  const started = Date.now();
  try {
    return await chatOnce(base, o);
  } catch (e) {
    throw explain(e, base, started);
  }
}

// Plain node:http instead of fetch: fetch gives up after 5 minutes without a reply, and Ollama
// sends nothing until it has read the whole prompt, which takes 6+ minutes for a big prompt on
// the CPU (WF1's ~4,900-token prompt was cut off at exactly 5m1s). Our own limit is 15 minutes.
function postStream(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (c: string) => { text += c; llmTokens(c.split('\n').filter(Boolean).length); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, text }); });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`no answer within ${timeoutMs / 60_000} minutes`)), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

async function chatOnce(base: string, o: ChatOpts): Promise<string> {
  llmStart();
  const { status, text: raw } = await postStream(`${base}/api/chat`, JSON.stringify({
    model: config.ollamaModel,
    stream: true,
    think: false,
    format: 'json',
    keep_alive: '2m',
    options: { temperature: o.temperature, num_ctx: config.ollamaNumCtx, num_predict: o.numPredict ?? 1500 },
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
  }), 15 * 60_000).finally(llmEnd);
  if (status !== 200) throw new Error(`Ollama ${status}: ${raw.slice(0, 300)}`);
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).message?.content ?? '').join('');
}

// Hosted models speak the OpenAI chat format (Gemini and Groq both offer it). Their free tiers
// answer in seconds; the VPS model takes minutes and is the last resort.
interface Hosted { name: string; url: string; key: string; model: string }
const HOSTED: Record<string, () => Hosted> = {
  gemini: () => ({ name: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: config.geminiKey, model: config.geminiModel }),
  groq: () => ({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: config.groqKey, model: config.groqModel }),
};

async function chatHosted(h: Hosted, o: ChatOpts, jsonMode = true): Promise<string> {
  llmStart();
  try {
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.key}` },
      body: JSON.stringify({
        model: h.model,
        temperature: o.temperature,
        reasoning_effort: 'low', // short, rule-following answers; thinking can't be fully off on these models
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    // Some models refuse JSON mode; the prompts ask for JSON anyway, so try once without it.
    if (res.status === 400 && jsonMode && /response_format|json/i.test(text)) return chatHosted(h, o, false);
    if (!res.ok) throw new Error(`${h.name} ${res.status}: ${text.slice(0, 300)}`);
    const content = JSON.parse(text).choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`${h.name} sent no text: ${text.slice(0, 200)}`);
    llmTokens(Math.round(content.length / 4));
    return content;
  } finally {
    llmEnd();
  }
}

// Every place to ask, in order: the hosted models that have a key, then the VPS addresses.
function routes(): { name: string; ask: (o: ChatOpts) => Promise<string> }[] {
  const out: { name: string; ask: (o: ChatOpts) => Promise<string> }[] = [];
  for (const p of config.llmProviders) {
    const h = HOSTED[p]?.();
    if (h && h.key) out.push({ name: `${h.name}:${h.model}`, ask: (o) => chatHosted(h, o) });
    // OLLAMA_URL first and OLLAMA_FALLBACK_URL if it is down (for example the PC when it is off).
    if (p === 'ollama') for (const base of new Set([config.ollamaUrl, config.ollamaFallbackUrl])) out.push({ name: `ollama:${config.ollamaModel}`, ask: (o) => chatAt(base, o) });
  }
  return out;
}

// Which models answered since the last call, so a job can record who wrote its script.
const used = new Set<string>();
export function takeModelsUsed(): string[] {
  const out = [...used];
  used.clear();
  return out;
}

// Ask for JSON. A provider that is down, out of quota or refuses goes to the next one.
export async function chatJson<T>(o: ChatOpts): Promise<T> {
  const errors: string[] = [];
  for (const r of routes()) {
    // The model sometimes writes broken JSON (a stray quote inside a string). That is a bad draw,
    // not a broken server, so ask the same one again, up to 3 tries, before moving on.
    for (let attempt = 1; attempt <= 3; attempt++) {
      let text: string;
      try {
        text = await r.ask(attempt === 1 ? o : { ...o, temperature: Math.min(1, o.temperature + 0.1 * attempt) });
      } catch (e: any) {
        console.warn(`[llm] ${r.name} failed, trying the next: ${e?.message ?? e}`);
        errors.push(e?.message ?? String(e));
        break; // server problem: try the next provider
      }
      try {
        const out = parseJson<T>(text);
        used.add(r.name);
        return out;
      } catch (e: any) {
        console.warn(`[llm] ${r.name} broken JSON on try ${attempt} of 3: ${e.message}`);
        if (attempt === 3) errors.push(`${r.name} wrote broken JSON 3 times (${e.message})`);
      }
    }
  }
  throw new Error(errors.join(' | ') || 'no language model configured (LLM_PROVIDERS)');
}

export function parseJson<T>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`Model did not return JSON: ${cleaned.slice(0, 200)}`);
  }
}

export async function embed(text: string): Promise<number[]> {
  const bases = [...new Set([config.ollamaUrl, config.ollamaFallbackUrl])];
  let lastErr: unknown;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.ollamaEmbedModel, input: text, keep_alive: '1m' }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
      const json: any = await res.json();
      return json.embeddings[0];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Free the model's RAM before rendering, so the language model and the renderer never overlap.
export async function unloadModels(): Promise<void> {
  for (const base of new Set([config.ollamaUrl, config.ollamaFallbackUrl])) {
    for (const model of [config.ollamaModel, config.ollamaEmbedModel]) {
      await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
    }
  }
}
