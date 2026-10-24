import { config } from './config.js';

interface ChatOpts { temperature: number; system: string; user: string; numPredict?: number }

// "fetch failed" alone says nothing; add the address, the low-level reason and how long it ran.
function explain(e: any, base: string, started: number): Error {
  const c = e?.cause;
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

async function chatOnce(base: string, o: ChatOpts): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      // Streamed: Node's fetch gives up after 5 minutes without response headers ("fetch failed"),
      // and a long answer on the CPU takes longer than that. Streaming sends headers at once.
      stream: true,
      think: false,
      format: 'json',
      keep_alive: '2m',
      options: { temperature: o.temperature, num_ctx: config.ollamaNumCtx, num_predict: o.numPredict ?? 1500 },
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let text = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) text += JSON.parse(line).message?.content ?? '';
  }
  if (buf.trim()) text += JSON.parse(buf).message?.content ?? '';
  return text;
}

// Ask the model for JSON. Tries OLLAMA_URL first and OLLAMA_FALLBACK_URL if it is down
// (for example when OLLAMA_URL points at the PC and the PC is off).
export async function chatJson<T>(o: ChatOpts): Promise<T> {
  const bases = [...new Set([config.ollamaUrl, config.ollamaFallbackUrl])];
  const errors: string[] = [];
  for (const base of bases) {
    try {
      const text = await chatAt(base, o);
      return parseJson<T>(text);
    } catch (e: any) {
      errors.push(e?.message ?? String(e));
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
