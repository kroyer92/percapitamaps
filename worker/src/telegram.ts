// Telegram Bot API helpers. The bot itself (commands and buttons) lives in bot.ts.
import fs from 'node:fs';
import { config } from './config.js';

const api = (method: string) => `https://api.telegram.org/bot${config.telegramToken}/${method}`;

export type Keyboard = { text: string; callback_data: string }[][];

export async function tg<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: any = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result as T;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function say(text: string, keyboard?: Keyboard): Promise<number | undefined> {
  if (!config.telegramToken || !config.telegramChatId) {
    console.log('[telegram disabled]', text);
    return undefined;
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    const cut = rest.lastIndexOf('\n', 4000);
    chunks.push(rest.slice(0, cut > 0 ? cut : 4000));
    rest = rest.slice(cut > 0 ? cut : 4000);
  }
  chunks.push(rest);
  let id: number | undefined;
  for (const [i, chunk] of chunks.entries()) {
    const msg = await tg('sendMessage', {
      chat_id: config.telegramChatId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard && i === chunks.length - 1 ? { inline_keyboard: keyboard } : undefined,
    });
    id = msg.message_id;
  }
  return id;
}

export async function sendVideo(file: string, caption: string, keyboard?: Keyboard): Promise<number | undefined> {
  if (!config.telegramToken || !config.telegramChatId) {
    console.log('[telegram disabled] video', file, caption);
    return undefined;
  }
  const form = new FormData();
  form.set('chat_id', config.telegramChatId);
  form.set('caption', caption.slice(0, 1024));
  form.set('parse_mode', 'HTML');
  form.set('supports_streaming', 'true');
  form.set('width', '1080');
  form.set('height', '1920');
  if (keyboard) form.set('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
  form.set('video', await fs.openAsBlob(file), 'video.mp4');
  const res = await fetch(api('sendVideo'), { method: 'POST', body: form, signal: AbortSignal.timeout(5 * 60_000) });
  const json: any = await res.json();
  if (!json.ok) throw new Error(`Telegram sendVideo: ${json.description}`);
  return json.result.message_id;
}

export async function alert(text: string): Promise<void> {
  await say(`⚠️ ${esc(text)}`).catch((e) => console.error('[telegram] alert failed', e));
}
