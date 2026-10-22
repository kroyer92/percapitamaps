// All settings come from app/.env (see the launch checklist, step 3.1).
const env = process.env;

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const FORMAT_CODES = ['MAP_REVEAL', 'COUNTDOWN', 'THEN_NOW', 'SCALE', 'GUESS'] as const;
export type Format = (typeof FORMAT_CODES)[number];

export const config = {
  port: Number(env.PORT ?? 8080),
  telegramToken: env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: env.TELEGRAM_CHAT_ID ?? '',
  pg: {
    host: env.POSTGRES_HOST ?? 'postgres',
    database: env.POSTGRES_DB ?? 'percapita',
    user: env.POSTGRES_USER ?? 'percapita',
    password: env.POSTGRES_PASSWORD ?? '',
    port: Number(env.POSTGRES_PORT ?? 5432),
  },
  mediaDomain: env.MEDIA_DOMAIN ?? '',
  mediaDir: env.MEDIA_DIR ?? '/opt/percapita/public',
  rendersDir: env.RENDERS_DIR ?? '/opt/percapita/renders',
  musicDir: env.MUSIC_DIR ?? '/opt/percapita/app/music',
  modelsDir: env.MODELS_DIR ?? '/models',
  python: env.PYTHON_BIN ?? '/opt/py/bin/python',
  bundleDir: env.REMOTION_BUNDLE ?? '/app/bundle',
  ollamaUrl: (env.OLLAMA_URL ?? 'http://ollama:11434').replace(/\/$/, ''),
  ollamaFallbackUrl: (env.OLLAMA_FALLBACK_URL ?? 'http://ollama:11434').replace(/\/$/, ''),
  ollamaModel: env.OLLAMA_MODEL ?? 'qwen3:8b',
  ollamaNumCtx: Number(env.OLLAMA_NUM_CTX ?? 6144),
  ollamaEmbedModel: env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
  renderConcurrency: Math.max(1, Number(env.RENDER_CONCURRENCY ?? 1)),
  renderThreads: Math.max(1, Number(env.RENDER_THREADS ?? 3)),
  channelName: env.CHANNEL_NAME ?? 'Per Capita Maps',
  channelHandle: env.CHANNEL_HANDLE ?? '@PerCapitaMaps',
  voiceA: env.VOICE_A || 'am_michael',
  voiceB: env.VOICE_B || 'af_heart',
  voice: env.VOICE ?? '',
  voiceRotation: env.VOICE_ROTATION ?? '',
  // A format listed twice gets double weight.
  formats: list(env.FORMATS || FORMAT_CODES.join(',')).filter((f): f is Format =>
    (FORMAT_CODES as readonly string[]).includes(f)),
  lengthTest: list(env.LENGTH_TEST),
  hookTest: list(env.HOOK_TEST),
  seriesNaming: (env.SERIES_NAMING ?? 'off').toLowerCase() === 'on',
  playlists: {
    MAP_REVEAL: env.PLAYLIST_MAP_REVEAL ?? '',
    COUNTDOWN: env.PLAYLIST_COUNTDOWN ?? '',
    THEN_NOW: env.PLAYLIST_THEN_NOW ?? '',
    SCALE: env.PLAYLIST_SCALE ?? '',
    GUESS: env.PLAYLIST_GUESS ?? '',
  } as Record<Format, string>,
  // Publishing slots in US Eastern time; the bot also shows them in LOCAL_TZ.
  publishSlots: list(env.PUBLISH_SLOTS || '13:00,19:00'),
  slotTz: env.SLOT_TZ || 'America/New_York',
  localTz: env.LOCAL_TZ || 'Europe/Copenhagen',
  youtubeApiUploads: (env.YOUTUBE_API_UPLOADS ?? 'off').toLowerCase() === 'on',
  n8nApprovedWebhook: env.N8N_APPROVED_WEBHOOK || 'http://n8n:5678/webhook/percapita-approved',
  instagramToken: env.INSTAGRAM_ACCESS_TOKEN ?? '',
  instagramUserId: env.INSTAGRAM_USER_ID ?? '',
  instagramApiVersion: env.INSTAGRAM_API_VERSION || 'v23.0',
  instagramDelayHours: Number(env.INSTAGRAM_DELAY_HOURS ?? 24),
  whisperModel: env.WHISPER_MODEL || 'small.en',
};

export const FORMAT_NAMES: Record<Format, string> = {
  MAP_REVEAL: 'Map Reveal',
  COUNTDOWN: 'Top 10 Countdown',
  THEN_NOW: 'Then vs Now',
  SCALE: 'If the World Were 100 People',
  GUESS: 'Guess the Country',
};
