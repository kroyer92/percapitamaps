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

// Meta's answer when the token may not read comments ((#10) / (#200) / "permission").
export function igPermissionError(msg: string): boolean {
  return /\(#(10|200|190)\)|permission|scope|not authorized/i.test(msg);
}

export function igFixText(msg: string): string {
  if (!igPermissionError(msg)) return `Instagram said: ${msg.slice(0, 200)}`;
  return [
    'The Instagram token is not allowed to read comments (it lacks <code>instagram_business_manage_comments</code>).',
    'Fix, once: developers.facebook.com → your app → Instagram → API setup with Instagram login → add the permission <code>instagram_business_manage_comments</code> → Generate token for @PerCapitaMaps.',
    'Put the new token in <code>/opt/percapita/app/.env</code> as INSTAGRAM_ACCESS_TOKEN, then run:',
    `<code>cd /opt/percapita && docker compose exec postgres psql -U percapita -d percapita -c "DELETE FROM settings WHERE key='instagram_token';" && docker compose up -d</code>`,
  ].join('\n');
}

// Every Reel on the account from the last 30 days, not only the ones WF4 posted (a Reel posted
// by hand, or one WF4 marked failed that still went up, gets its comments read too). The jobs
// table is the fallback when the account's media list can't be read.
async function recentMedia(token: string): Promise<{ id: string; permalink?: string; count?: number }[]> {
  const byId = new Map<string, { id: string; permalink?: string; count?: number }>();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  try {
    const res = await ig(`${config.instagramUserId}/media`, { fields: 'id,permalink,timestamp,comments_count', limit: '50', access_token: token }, 'GET');
    for (const m of res.data ?? []) {
      if (+new Date(m.timestamp) < cutoff) continue;
      byId.set(m.id, { id: m.id, permalink: m.permalink, count: m.comments_count });
    }
  } catch (e: any) {
    console.warn('[comments] Instagram media list failed, using the jobs table:', e.message);
  }
  const jobs = await q<{ ig_media_id: string }>(
    `SELECT ig_media_id FROM jobs WHERE ig_media_id IS NOT NULL AND ig_due_at > now() - interval '${MAX_AGE_DAYS} days'`);
  for (const j of jobs) if (!byId.has(j.ig_media_id)) byId.set(j.ig_media_id, { id: j.ig_media_id });
  return [...byId.values()];
}

// Pure: the comments and replies on one Reel that the account has not answered yet.
export function unansweredInstagram(mediaId: string, permalink: string, data: any[], own: string | undefined): ViewerComment[] {
  const out: ViewerComment[] = [];
  const isOwn = (x: any) => !!own && x.username === own;
  for (const c of data ?? []) {
    const replies: any[] = c.replies?.data ?? [];
    const answered = (x: any) => replies.some((r) => isOwn(r) && +new Date(r.timestamp) > +new Date(x.timestamp) && (x === c || String(r.text ?? '').includes(`@${x.username}`)));
    for (const x of [c, ...replies]) {
      if (isOwn(x) || answered(x)) continue;
      out.push({ platform: 'instagram', id: x.id, video_id: mediaId, author: x.username ?? 'someone', text: x.text ?? '', published_at: x.timestamp, link: permalink });
    }
  }
  return out;
}

async function instagramComments(): Promise<ViewerComment[]> {
  if (!config.instagramToken || !config.instagramUserId) return [];
  const token = await igToken();
  const out: ViewerComment[] = [];
  const errors: string[] = [];
  let read = 0;
  try {
    igUsername ??= (await ig('me', { fields: 'username', access_token: token }, 'GET')).username as string;
  } catch (e: any) {
    errors.push(String(e.message ?? e));
  }
  const media = errors.length ? [] : await recentMedia(token);
  for (const m of media) {
    if (m.count === 0) continue; // nothing to read, saves a call
    try {
      const permalink = m.permalink ?? (await ig(m.id, { fields: 'permalink', access_token: token }, 'GET')).permalink ?? '';
      const res = await ig(`${m.id}/comments`, { fields: 'id,text,username,timestamp,replies{id,text,username,timestamp}', limit: '50', access_token: token }, 'GET');
      out.push(...unansweredInstagram(m.id, permalink, res.data ?? [], igUsername));
      read++;
    } catch (e: any) {
      // One deleted or broken Reel must not hide the comments on all the others.
      errors.push(String(e.message ?? e));
      console.warn(`[comments] Instagram media ${m.id}:`, e.message);
    }
  }
  console.log(`[comments] Instagram: ${media.length} Reels, ${read} read, ${out.length} unanswered, ${errors.length} errors`);
  if (read > 0 || !errors.length) {
    await setSetting('ig_comments_error', null);
    return out;
  }
  // Nothing could be read. Say why with the exact fix, again once a day while it stays broken.
  const msg = errors[0];
  const prev = await getSetting<{ msg: string; at: string } | string | null>('ig_comments_error');
  const last = prev && typeof prev === 'object' ? prev : undefined;
  if (!last || last.msg !== msg || Date.now() - +new Date(last.at) > 86_400_000) {
    await setSetting('ig_comments_error', { msg, at: new Date().toISOString() });
    await say(`⚠️ <b>Instagram comments are not coming through.</b> YouTube comments still do.\n${igFixText(esc(msg))}`);
  }
  return out;
}

// ---------- shared ----------

async function jobFor(c: ViewerComment): Promise<JobLite | undefined> {
  const col = c.platform === 'youtube' ? 'youtube_video_id' : 'ig_media_id';
  return one<JobLite>(`SELECT id, facts, packaging, format FROM jobs WHERE ${col} = $1`, [c.video_id]);
}

async function askModel(c: ViewerComment, title: string, facts: Facts | undefined, u: any, hide: boolean): Promise<ModelView | undefined> {
  try {
    return await chatLocalJson<ModelView>({ temperature: 0.2, numPredict: 200, ...modelPrompt(c.text, title, facts, u, hide) });
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
    const hide = job?.format !== 'SCALE'; // every quiz format: the top of the ranking is the answer
    const model = await askModel(c, job?.packaging?.title ?? '', u ? facts : undefined, u, hide);
    usedModel ||= !!model;
    const d = draftFor(c.text, u ? facts : undefined, u, model, hide);
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
