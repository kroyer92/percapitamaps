// New viewer comments -> one Telegram message each, with the paste-ready reply (or "heart it").
// YouTube: WF6 reads the comment threads with n8n's YouTube credential every hour and posts them
// to /comments/youtube. Instagram: read here with the token WF4 already uses.
// Nothing is ever posted to YouTube or Instagram: Niko pastes the reply himself.
//
// Privacy (privacy.md): comment text never leaves the server. The model that sorts comments is the
// local one (Ollama), never a hosted API, and comment rows are deleted after 30 days.
import { config } from './config.js';
import { CATALOG } from './data/catalog.js';
import { one, q, getSetting, setSetting } from './db.js';
import type { Facts } from './facts.js';
import { chatLocalJson, unloadModels } from './llm.js';
import { ig, igToken } from './publish.js';
import { esc, say } from './telegram.js';
import { draftFor, modelPrompt, type Draft, type ModelView } from './comment-draft.js';
import * as office from './activity.js';

const MAX_PER_RUN = Number(process.env.COMMENTS_PER_RUN ?? 8);
const MAX_AGE_DAYS = 30;

export interface ViewerComment {
  platform: 'youtube' | 'instagram';
  id: string;
  video_id: string;          // YouTube video id or Instagram media id
  author: string;
  text: string;
  published_at: string;
  link: string;
}

interface JobLite { id: number; facts: Facts | null; packaging: { title?: string } | null; format: string }

// ---------- YouTube (from WF6) ----------

interface YtComment { id: string; snippet: { videoId?: string; textOriginal?: string; textDisplay?: string; authorDisplayName?: string; authorChannelId?: { value?: string }; publishedAt: string; parentId?: string } }
interface YtThread { id: string; snippet: { videoId?: string; channelId?: string; topLevelComment: YtComment; totalReplyCount?: number }; replies?: { comments?: YtComment[] } }
export interface YtPayload { channel_id?: string; threads?: YtThread[]; replies?: YtComment[] }

// The comments nobody from the channel has answered yet. A channel reply answers the thread's top
// comment, and any earlier reply whose author it names (YouTube starts replies with "@handle").
export function unansweredYoutube(p: YtPayload): ViewerComment[] {
  const own = p.channel_id ?? '';
  const extra = new Map<string, YtComment[]>();
  for (const r of p.replies ?? []) {
    const parent = r.snippet.parentId ?? '';
    extra.set(parent, [...(extra.get(parent) ?? []), r]);
  }
  const out: ViewerComment[] = [];
  for (const t of p.threads ?? []) {
    const top = t.snippet.topLevelComment;
    const videoId = t.snippet.videoId ?? top.snippet.videoId ?? '';
    if (!videoId) continue; // a comment on the channel itself, not on a video
    const byId = new Map<string, YtComment>();
    for (const c of [...(t.replies?.comments ?? []), ...(extra.get(top.id) ?? [])]) byId.set(c.id, c);
    const replies = [...byId.values()];
    const isOwn = (c: YtComment) => !!own && c.snippet.authorChannelId?.value === own;
    const ownReplies = replies.filter(isOwn);
    const answered = (c: YtComment, isTop: boolean) => ownReplies.some((r) =>
      +new Date(r.snippet.publishedAt) > +new Date(c.snippet.publishedAt) &&
      ((isTop && !isOwn(top)) || (r.snippet.textOriginal ?? '').toLowerCase().includes((c.snippet.authorDisplayName ?? '\u0000').toLowerCase())));
    const candidates: [YtComment, boolean][] = [[top, true], ...replies.map((r): [YtComment, boolean] => [r, false])];
    for (const [c, isTop] of candidates) {
      if (isOwn(c) || answered(c, isTop)) continue;
      out.push({
        platform: 'youtube',
        id: c.id,
        video_id: videoId,
        author: c.snippet.authorDisplayName ?? 'someone',
        text: c.snippet.textOriginal ?? c.snippet.textDisplay ?? '',
        published_at: c.snippet.publishedAt,
        link: `https://www.youtube.com/watch?v=${videoId}&lc=${c.id}`,
      });
    }
  }
  return out;
}

// ---------- Instagram ----------

let igUsername: string | undefined;

async function instagramComments(): Promise<ViewerComment[]> {
  if (!config.instagramToken || !config.instagramUserId) return [];
  const media = await q<{ ig_media_id: string }>(
    `SELECT ig_media_id FROM jobs WHERE ig_status = 'posted' AND ig_media_id IS NOT NULL AND ig_due_at > now() - interval '${MAX_AGE_DAYS} days'`);
  if (!media.length) return [];
  const token = await igToken();
  try {
    igUsername ??= (await ig('me', { fields: 'username', access_token: token }, 'GET')).username as string;
    const out: ViewerComment[] = [];
    for (const m of media) {
      const info = await ig(m.ig_media_id, { fields: 'permalink', access_token: token }, 'GET');
      const res = await ig(`${m.ig_media_id}/comments`, { fields: 'id,text,username,timestamp,replies{id,text,username,timestamp}', limit: '50', access_token: token }, 'GET');
      for (const c of res.data ?? []) {
        const replies: any[] = c.replies?.data ?? [];
        const own = (x: any) => x.username === igUsername;
        const answeredBy = (x: any) => replies.some((r) => own(r) && +new Date(r.timestamp) > +new Date(x.timestamp) && (x === c || String(r.text ?? '').includes(`@${x.username}`)));
        for (const x of [c, ...replies]) {
          if (own(x) || answeredBy(x)) continue;
          out.push({ platform: 'instagram', id: x.id, video_id: m.ig_media_id, author: x.username ?? 'someone', text: x.text ?? '', published_at: x.timestamp, link: info.permalink ?? '' });
        }
      }
    }
    await setSetting('ig_comments_error', null);
    return out;
  } catch (e: any) {
    // Usually a token without the comments permission. Say it once, not every hour.
    const msg = String(e.message ?? e);
    if ((await getSetting<string | null>('ig_comments_error')) !== msg) {
      await setSetting('ig_comments_error', msg);
      await say(`⚠️ Instagram comments can't be read: ${esc(msg.slice(0, 200))}\nYouTube comments still come through. Paste this message to Claude in the project chat to get the exact fix.`);
    }
    return [];
  }
}

// ---------- shared ----------

async function jobFor(c: ViewerComment): Promise<JobLite | undefined> {
  const col = c.platform === 'youtube' ? 'youtube_video_id' : 'ig_media_id';
  return one<JobLite>(`SELECT id, facts, packaging, format FROM jobs WHERE ${col} = $1`, [c.video_id]);
}

async function askModel(c: ViewerComment, title: string, facts: Facts | undefined, u: any): Promise<ModelView | undefined> {
  try {
    return await chatLocalJson<ModelView>({ temperature: 0.2, numPredict: 200, ...modelPrompt(c.text, title, facts, u) });
  } catch (e: any) {
    console.warn('[comments] local model unavailable, sorting by rules:', e.message);
    return undefined;
  }
}

export function telegramText(c: ViewerComment, job: JobLite | undefined, d: Draft): string {
  const where = c.platform === 'instagram' ? 'Instagram' : 'YouTube';
  const video = job ? `#${job.id} ${esc(job.packaging?.title ?? '')}` : 'a video that is not linked to a job';
  const lines = [
    `💬 <b>${where} comment</b> on ${video}`,
    `<i>${esc(c.author)}:</i> ${esc(c.text.slice(0, 700))}`,
    '',
  ];
  if (d.reply) lines.push(`<b>${esc(d.action)}</b> (tap to copy):`, `<code>${esc(d.reply)}</code>`);
  else lines.push(`<b>${esc(d.action)}</b>`);
  if (c.link) lines.push('', `<a href="${esc(c.link)}">Open the comment</a>`);
  return lines.join('\n');
}

// Keep the stored comments within the privacy policy's 30 days.
async function purge(): Promise<void> {
  await q(`DELETE FROM comments WHERE published_at < now() - interval '${MAX_AGE_DAYS + 1} days'`);
}

async function handle(list: ViewerComment[]): Promise<{ sent: number; waiting: number }> {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const fresh: ViewerComment[] = [];
  for (const c of list) {
    if (!c.text.trim() || +new Date(c.published_at) < cutoff) continue;
    if (await one('SELECT 1 FROM comments WHERE platform = $1 AND id = $2', [c.platform, c.id])) continue;
    fresh.push(c);
  }
  // Newest first: early replies help a Short most. The rest wait for the next hourly run.
  fresh.sort((a, b) => +new Date(b.published_at) - +new Date(a.published_at));
  const now = fresh.slice(0, MAX_PER_RUN);
  let usedModel = false;
  for (const c of now) {
    const job = await jobFor(c);
    const facts = job?.facts ?? undefined;
    const u = facts ? CATALOG.find((d) => d.id === facts.dataset_id) : undefined;
    const model = await askModel(c, job?.packaging?.title ?? '', u ? facts : undefined, u);
    usedModel ||= !!model;
    const d = draftFor(c.text, u ? facts : undefined, u, model);
    await say(telegramText(c, job, d));
    await q(
      `INSERT INTO comments (platform, id, video_id, job_id, author, text, published_at, kind, action, reply)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [c.platform, c.id, c.video_id, job?.id ?? null, c.author, c.text, c.published_at, d.kind, d.action, d.reply ?? null],
    );
  }
  if (usedModel) await unloadModels(); // free the RAM before the next render
  return { sent: now.length, waiting: fresh.length - now.length };
}

export async function checkComments(p: YtPayload): Promise<{ sent: number; waiting: number }> {
  await purge();
  const list = [...unansweredYoutube(p), ...(await instagramComments())];
  const r = await handle(list);
  if (r.sent) office.finished('analyst', `Drafted replies to ${r.sent} comment${r.sent === 1 ? '' : 's'}`);
  console.log(`[comments] ${list.length} unanswered, ${r.sent} sent to Telegram, ${r.waiting} waiting for the next run`);
  return r;
}
