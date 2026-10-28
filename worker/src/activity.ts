// What each part of the pipeline is doing right now, for the studio page's office. Kept in
// memory only: it is live status, and a restart clears it (the database keeps the real record).
// The studio page listens on /studio/api/live and animates one character per agent.

export const AGENTS = {
  scout: 'Scout',          // WF1: trend signals → topic ideas
  writer: 'Writer',        // script, hooks, title, fact-check
  narrator: 'Narrator',    // Kokoro voice
  editor: 'Editor',        // captions, Remotion render, mix
  checker: 'Checker',      // QA gate
  publisher: 'Publisher',  // approval, upload pack, Instagram
  analyst: 'Analyst',      // snapshots, scorecards, weekly report
} as const;
export type AgentId = keyof typeof AGENTS;
export type AgentState = 'idle' | 'working' | 'done' | 'failed' | 'waiting';

export interface Agent {
  id: AgentId;
  name: string;
  state: AgentState;
  text: string;
  job?: number;
  since: string;
  progress?: number; // 0–1 when the step reports it (the render)
  llm?: { phase: 'reading' | 'writing'; tokens: number; started: string };
}
export interface LogLine { at: string; agent: AgentId; state: AgentState; text: string; job?: number }

const now = () => new Date().toISOString();
const agents = Object.fromEntries(
  (Object.keys(AGENTS) as AgentId[]).map((id) => [id, { id, name: AGENTS[id], state: 'idle', text: 'Free', since: now() } as Agent]),
) as Record<AgentId, Agent>;
const log: LogLine[] = [];
const listeners = new Set<(event: string, data: unknown) => void>();

function emit(event: string, data: unknown) {
  for (const l of listeners) {
    try { l(event, data); } catch { /* a closed connection; it unsubscribes itself */ }
  }
}

export function set(id: AgentId, state: AgentState, text: string, job?: number): void {
  const a = agents[id];
  const changed = a.state !== state || a.text !== text;
  Object.assign(a, { state, text, job: job ?? (state === 'idle' ? undefined : a.job), since: changed ? now() : a.since });
  if (state !== 'working') { a.progress = undefined; a.llm = undefined; }
  if (changed) {
    const line: LogLine = { at: a.since, agent: id, state, text, job: a.job };
    log.push(line);
    if (log.length > 120) log.shift();
    emit('log', line);
  }
  emit('agent', a);
  // A finished agent goes back to its coffee after a while; a failure stays up longer.
  if (state === 'done' || state === 'failed') {
    const since = a.since;
    setTimeout(() => { if (a.since === since) set(id, 'idle', 'Free'); }, (state === 'done' ? 3 : 15) * 60_000).unref();
  }
}

export const working = (id: AgentId, text: string, job?: number) => set(id, 'working', text, job);
export const finished = (id: AgentId, text: string, job?: number) => set(id, 'done', text, job);
export const failed = (id: AgentId, text: string, job?: number) => set(id, 'failed', text, job);
export const waiting = (id: AgentId, text: string, job?: number) => set(id, 'waiting', text, job);

// Runs fn with the agent shown as working, then done or failed. Errors still propagate.
export async function track<T>(id: AgentId, text: string, fn: () => Promise<T>, done?: (r: T) => string, job?: number): Promise<T> {
  working(id, text, job);
  try {
    const r = await fn();
    finished(id, done ? done(r) : 'Done', job);
    return r;
  } catch (e: any) {
    failed(id, String(e?.message ?? e).slice(0, 160), job);
    throw e;
  }
}

// Progress updates come many times a second; the page only needs about one a second.
const lastTick: Partial<Record<AgentId, number>> = {};
function throttled(id: AgentId) {
  const t = Date.now();
  if (t - (lastTick[id] ?? 0) < 1000) return;
  lastTick[id] = t;
  emit('agent', agents[id]);
}

export function progress(id: AgentId, p: number): void {
  agents[id].progress = Math.max(0, Math.min(1, p));
  throttled(id);
}

// The language model is used by whichever agent is working on an LLM step (Scout or Writer).
// Ollama sends nothing while it reads the prompt (minutes on the CPU), then a token at a time.
let llmAgent: AgentId | undefined;
function llmOwner(): AgentId | undefined {
  if (llmAgent && agents[llmAgent].state === 'working') return llmAgent;
  return (['writer', 'scout', 'analyst'] as AgentId[]).find((id) => agents[id].state === 'working');
}
export function llmStart(): void {
  llmAgent = llmOwner();
  if (!llmAgent) return;
  agents[llmAgent].llm = { phase: 'reading', tokens: 0, started: now() };
  emit('agent', agents[llmAgent]);
}
export function llmTokens(n: number): void {
  const a = llmAgent && agents[llmAgent];
  if (!a?.llm) return;
  a.llm.phase = 'writing';
  a.llm.tokens += n;
  throttled(a.id);
}
export function llmEnd(): void {
  const a = llmAgent && agents[llmAgent];
  if (a) { a.llm = undefined; emit('agent', a); }
  llmAgent = undefined;
}

export function snapshot() {
  return { agents: Object.values(agents), log: [...log].reverse().slice(0, 40) };
}

export function subscribe(fn: (event: string, data: unknown) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A job failed somewhere: whichever agent was working on it shows the failure.
export function failJob(job: number, text: string): void {
  const busy = Object.values(agents).filter((a) => a.job === job && a.state === 'working');
  for (const a of busy) failed(a.id, text.slice(0, 160), job);
}
