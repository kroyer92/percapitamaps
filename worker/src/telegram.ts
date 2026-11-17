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
  if (!json.ok) {
    // A formatting slip (a stray "<" or "&", a tag cut in half) must never cost a message: send the
    // same words again as plain text.
    const field = method === 'editMessageCaption' ? 'caption' : 'text';
    if (params.parse_mode === 'HTML' && isEntityError(json.description) && typeof params[field] === 'string') {
      console.error(`[telegram] ${method} rejected the HTML (${json.description}); sending it as plain text`);
      const { parse_mode: _drop, ...rest } = params;
      return tg<T>(method, { ...rest, [field]: htmlToPlain(params[field] as string) }, timeoutMs);
    }
    throw new Error(`Telegram ${method}: ${json.description}`);
  }
  return json.result as T;
}

export function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram's answer when parse_mode HTML can't be read ("can't parse entities: ..."). */
export function isEntityError(description: unknown): boolean {
  return /can't parse entities|unclosed start tag|can't find end tag|unsupported start tag|unexpected end tag/i.test(String(description ?? ''));
}

/** The words of an HTML message without its tags, for the plain-text retry. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/gi, '')
    .replace(/<\/?[a-z]*[^<>\s]*$/i, '') // a tag cut off at the very end; a lone "<" in text stays
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Shortens an HTML caption to Telegram's limit of `limit` visible characters (tags don't count,
 * an entity counts as one). Never cuts inside a tag or an entity, and closes any tag left open, so
 * the result always parses. A plain .slice() cut job #84's preview in the middle of a tag
 * ("Unclosed start tag at byte offset 1038") and the preview never arrived.
 */
export function fitHtml(html: string, limit = 1024): string {
  const visible = (h: string) => htmlToPlain(h).length;
  if (visible(html) <= limit) return html;
  const room = limit - 1; // leave space for the "…"
  let out = '';
  let count = 0;
  const open: string[] = [];
  const token = /<\/?([a-z][a-z0-9-]*)[^>]*>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);|[\s\S]/giuy;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html))) {
    const t = m[0];
    if (t.startsWith('<') && t.endsWith('>') && m[1]) {
      if (t.startsWith('</')) {
        const i = open.lastIndexOf(m[1].toLowerCase());
        if (i >= 0) open.splice(i, 1);
      } else if (!t.endsWith('/>')) open.push(m[1].toLowerCase());
      out += t;
      continue;
    }
    const len = t.startsWith('&') && t.length > 1 ? 1 : t.length;
    if (count + len > room) break;
    out += t;
    count += len;
  }
  // Drop tags opened right at the cut with nothing in them, then close the rest.
  out = out.replace(/(<[a-z][a-z0-9-]*[^>]*>)+$/i, (tags) => {
    for (const tag of tags.match(/<([a-z][a-z0-9-]*)/gi) ?? []) open.splice(open.lastIndexOf(tag.slice(1).toLowerCase()), 1);
    return '';
  });
  return out.replace(/\s+$/, '') + '…' + open.reverse().map((t) => `</${t}>`).join('');
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
  return sendMedia('sendVideo', 'video', file, 'video.mp4', caption, keyboard, 5 * 60_000, {
    supports_streaming: 'true', width: '1080', height: '1920',
  });
}

export async function sendPhoto(file: string, caption: string, keyboard?: Keyboard): Promise<number | undefined> {
  if (!config.telegramToken || !config.telegramChatId) {
    console.log('[telegram disabled] photo', file, caption);
    return undefined;
  }
  return sendMedia('sendPhoto', 'photo', file, 'thumb.png', caption, keyboard, 2 * 60_000);
}

async function sendMedia(
  method: 'sendVideo' | 'sendPhoto', field: string, file: string, name: string, caption: string,
  keyboard: Keyboard | undefined, timeoutMs: number, extra: Record<string, string> = {},
): Promise<number> {
  const post = async (html: boolean) => {
    const form = new FormData();
    form.set('chat_id', config.telegramChatId);
    if (html) {
      form.set('caption', fitHtml(caption, 1024));
      form.set('parse_mode', 'HTML');
    } else {
      const plain = htmlToPlain(caption);
      form.set('caption', plain.length > 1024 ? `${plain.slice(0, 1023)}…` : plain);
    }
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    if (keyboard) form.set('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
    form.set(field, await fs.openAsBlob(file), name);
    const res = await fetch(api(method), { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json()) as any;
  };
  let json = await post(true);
  if (!json.ok && isEntityError(json.description)) {
    // Never lose a preview over formatting: the same caption again, as plain text.
    console.error(`[telegram] ${method} rejected the HTML caption (${json.description}); sending it as plain text`);
    json = await post(false);
  }
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  // A caption over the limit was shortened; the full text follows as its own message so nothing at
  // the end (the QA lines) goes missing.
  if (htmlToPlain(caption).length > 1024) await say(caption).catch((e) => console.error('[telegram] full caption failed', e));
  return json.result.message_id;
}

export async function alert(text: string): Promise<void> {
  await say(`⚠️ ${esc(text)}`).catch((e) => console.error('[telegram] alert failed', e));
}
