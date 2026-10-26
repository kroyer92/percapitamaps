import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';

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
      res.on('data', (c: string) => (text += c));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, text }); });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`no answer within ${timeoutMs / 60_000} minutes`)), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

async function chatOnce(base: string, o: ChatOpts): Promise<string> {
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
  }), 15 * 60_000);
  if (status !== 200) throw new Error(`Ollama ${status}: ${raw.slice(0, 300)}`);
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).message?.content ?? '').join('');
}

// Ask the model for JSON. Tries OLLAMA_URL first and OLLAMA_FALLBACK_URL if it is down
// (for example when OLLAMA_URL points at the PC and the PC is off).
export async function chatJson<T>(o: ChatOpts): Promise<T> {
  const bases = [...new Set([config.ollamaUrl, config.ollamaFallbackUrl])];
  const errors: string[] = [];
  for (const base of bases) {
    // The model sometimes writes broken JSON (a stray quote inside a string). That is a bad draw,
    // not a broken server, so ask the same server again, up to 3 tries, before giving up.
    for (let attempt = 1; attempt <= 3; attempt++) {
      let text: string;
      try {
        text = await chatAt(base, attempt === 1 ? o : { ...o, temperature: Math.min(1, o.temperature + 0.1 * attempt) });
      } catch (e: any) {
        errors.push(e?.message ?? String(e));
        break; // server problem: try the next address
      }
      try {
        return parseJson<T>(text);
      } catch (e: any) {
        console.warn(`[llm] broken JSON on try ${attempt} of 3: ${e.message}`);
        if (attempt === 3) errors.push(`model wrote broken JSON 3 times (${e.message})`);
      }
    }
  }
  throw new Error(errors.join(' | '));
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
