// After you approve: pick the slot, write the upload pack, and (once the API audit has
// cleared) hand the upload to n8n's WF3. Also the Instagram cross-post (WF4).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, FORMAT_NAMES, isNation, type Format } from './config.js';
import { one, q, getSetting, setSetting } from './db.js';
import { buildDescription, hideAnswer, seriesTitle } from './content.js';
import { esc, say } from './telegram.js';
import { fmtIn, upcomingSlots } from './lib/time.js';
import type { JobRow } from './produce.js';
import * as office from './activity.js';
import { approveNation } from './nation/make.js';
import { jumpQueue, jumpText } from './reschedule.js';

const PLAYLIST_NAMES: Record<Format, string> = {
  MAP_REVEAL: 'Map Reveals', COUNTDOWN: 'Top 10 Countdowns', THEN_NOW: 'Then vs Now', SCALE: 'If the World Were 100 People', GUESS: 'Guess the Country',
};

export async function nextSlot(): Promise<Date> {
  const taken = new Set(
    (await q<{ slot_at: Date }>(`SELECT slot_at FROM jobs WHERE slot_at IS NOT NULL AND slot_at > now()`)).map((r) => +new Date(r.slot_at)),
  );
  const soonest = new Date(Date.now() + 60 * 60_000);
  return upcomingSlots(config.publishSlots, config.slotTz, soonest, 30).find((s) => !taken.has(+s)) ?? soonest;
}

export async function approve(id: number): Promise<void> {
  const job = await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  if (!job) return;
  if (job.status !== 'awaiting_approval') {
    await say(`#${id} is already ${job.status}.`);
    return;
  }
  // Per Capita Nation episodes keep their own daily slot and packaging (nation/make.ts).
  if (isNation(job.format)) return approveNation(job);
  const topic = await one<{ question: string; source: string }>('SELECT question, source FROM topics WHERE id = $1', [job.topic_id]);
  // A pinned Short takes the next normal slot and the queue moves back one slot (reschedule.ts).
  const jump = topic?.source === 'pinned' ? await jumpQueue(id) : undefined;
  const slot = jump?.slot ?? (await nextSlot());
  const series = config.seriesNaming
    ? ((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE format = $1 AND series_no IS NOT NULL`, [job.format]))?.n ?? 0) + 1
    : null;
  // Jobs written before the packaging check existed can still name the answer.
  hideAnswer(job.packaging, job.facts, job.format, topic?.question ?? job.facts.title);
  const title = seriesTitle(job.packaging.title, job.format, series ?? undefined);
  const description = buildDescription(job.packaging, job.facts, job.render?.music?.credit);
  const packaging = { ...job.packaging, title, description };
  await q(`UPDATE jobs SET status = 'approved', slot_at = $2, series_no = $3, packaging = $4, updated_at = now() WHERE id = $1`, [id, slot, series, packaging]);
  await q(`UPDATE datasets SET last_used_at = now() WHERE id = (SELECT dataset_id FROM topics WHERE id = $1)`, [job.topic_id]);
  await q(`UPDATE topics SET status = 'done' WHERE id = $1`, [job.topic_id]);

  const when = `${fmtIn(slot, config.slotTz)} US Eastern = <b>${fmtIn(slot, config.localTz)} your time</b>`;
  office.finished('publisher', `Approved #${id} for ${fmtIn(slot, config.localTz)} your time${config.youtubeApiUploads ? ', uploading' : ', upload pack sent'}`, id);
  const playlist = config.playlists[job.format] ? PLAYLIST_NAMES[job.format] : `${PLAYLIST_NAMES[job.format]} (no ID in app/.env yet)`;
  if (config.youtubeApiUploads) {
    await handToN8n(job, packaging, slot);
    await say(`✅ Approved #${id}. Uploading through the YouTube API, scheduled for ${when}.${jump ? jumpText(jump) : ''}`);
    return;
  }
  await say([
    `✅ <b>Approved #${id}</b> · ${FORMAT_NAMES[job.format]}`,
    `Schedule it for ${when}. The video is in the preview above (tap it, then ⋮ → Save).`,
    '',
    '<b>Title</b>', `<code>${esc(title)}</code>`,
    '', '<b>Description</b>', `<pre>${esc(description)}</pre>`,
    '', '<b>Tags</b>', `<code>${esc(job.packaging.search_tags.join(', '))}</code>`,
    '', '<b>Comment to post and pin</b>', `<code>${esc(job.packaging.pinned_comment)}</code>`,
    '', `<b>Playlist:</b> ${esc(playlist)}`,
    `<b>Altered content:</b> No`,
    '', `When it's uploaded, send: <code>/link ${id} </code>followed by the video URL`,
  ].join('\n'));
}

export async function handToN8n(job: JobRow, packaging: JobRow['packaging'] & { description: string }, slot: Date, playlist?: string | null): Promise<void> {
  const name = `${crypto.randomBytes(12).toString('hex')}.mp4`;
  await fs.mkdir(path.join(config.mediaDir, 'yt'), { recursive: true });
  await fs.copyFile(job.video_path!, path.join(config.mediaDir, 'yt', name));
  const body = {
    job_id: job.id,
    file_url: `https://${config.mediaDomain}/yt/${name}`,
    title: packaging.title,
    description: packaging.description,
    tags: packaging.search_tags,
    publish_at: slot.toISOString(),
    playlist_id: playlist !== undefined ? playlist : config.playlists[job.format] || null,
    pinned_comment: packaging.pinned_comment,
    category_id: '27',
  };
  const res = await fetch(config.n8nApprovedWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`n8n WF3 webhook answered ${res.status}. Is WF3 active?`);
}

export function parseVideoId(text: string): string | undefined {
  const m = text.match(/(?:youtu\.be\/|shorts\/|[?&]v=|live\/|embed\/)([A-Za-z0-9_-]{11})/) ?? text.match(/^([A-Za-z0-9_-]{11})$/);
  return m?.[1];
}

export async function linkVideo(id: number, videoId: string, url?: string): Promise<string> {
  const job = await one<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  if (!job) return `No job #${id}.`;
  // Uploads are scheduled for the pack's slot, so that is when it went live, also when an older
  // video is linked days later (its 24h/72h/7d windows then line up with the real publish time).
  const publishedAt = job.slot_at ? new Date(job.slot_at) : new Date();
  const igDelay = isNation(job.format) ? config.nation.igDelayHours : config.instagramDelayHours;
  await q(
    `UPDATE jobs SET status = 'published', youtube_video_id = $2, youtube_url = $3, published_at = $4,
       ig_due_at = $4::timestamptz + make_interval(hours => $5), updated_at = now() WHERE id = $1`,
    [id, videoId, url ?? `https://youtube.com/shorts/${videoId}`, publishedAt, igDelay],
  );
  await q(`UPDATE datasets SET last_used_at = now() WHERE id = (SELECT dataset_id FROM topics WHERE id = $1)`, [job.topic_id]);
  await q(`UPDATE topics SET status = 'done' WHERE id = $1`, [job.topic_id]);
  office.finished('publisher', `#${id} is live on YouTube`, id);
  return `🔗 Linked #${id} to ${videoId}. Analytics will track it${config.instagramToken ? `, and Instagram posts it ${igDelay} hours after it goes live` : ''}.`;
}

// ---------- Instagram (WF4) ----------

// Where a token is stored: settings 'instagram_token' wins over INSTAGRAM_ACCESS_TOKEN in app/.env,
// so a token sent with /igtoken in Telegram takes over with no SSH and no restart.
export async function igToken(): Promise<string> {
  const stored = await getSetting<{ token: string; refreshed_at: string }>('instagram_token');
  let token = stored?.token || config.instagramToken;
  const age = stored ? Date.now() - +new Date(stored.refreshed_at) : Infinity;
  if (token && age > 20 * 86_400_000) {
    // Long-lived tokens last 60 days; refresh well before that.
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
    const json: any = await res.json();
    if (json.access_token) {
      token = json.access_token;
      await setSetting('instagram_token', { token, refreshed_at: new Date().toISOString() });
    } else if (!stored) {
      await setSetting('instagram_token', { token, refreshed_at: new Date().toISOString() });
    }
  }
  return token;
}

export async function ig(pathPart: string, params: Record<string, string>, method = 'POST'): Promise<any> {
  const url = new URL(`https://graph.instagram.com/${config.instagramApiVersion}/${pathPart}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, signal: AbortSignal.timeout(60_000) });
  const json: any = await res.json();
  if (json.error) throw Object.assign(new Error(`Instagram: ${json.error.message}`), { igCode: json.error.code });
  return json;
}

// The token itself is dead (password change, security check, expiry): code 190 / OAuthException.
// Nothing can be posted until a new one arrives, so posts wait instead of being marked failed.
export function igTokenDead(e: any): boolean {
  return e?.igCode === 190 || /Error validating access token|session has been invalidated|access token has expired|Invalid OAuth access token|Cannot parse access token/i.test(String(e?.message ?? e));
}

export const IG_TOKEN_STEPS = [
  'Get a new token (works on your phone, takes 2 minutes):',
  '1. Open the Instagram app once and finish any security check it shows.',
  '2. Open <b>developers.facebook.com/apps</b> in the phone browser (turn on "Desktop site" if the menu is cut off) → your app → <b>Instagram</b> → <b>API setup with Instagram login</b>.',
  '3. Under <b>Generate access tokens</b>, tap <b>Generate token</b> next to @PerCapitaMaps (if the account is gone from the list, tap <b>Add account</b> first), log in to Instagram, copy the token.',
  '4. Paste it here as <code>/igtoken PASTE_TOKEN</code>.',
  'The bot checks it, deletes your message (so the token is not left in the chat) and posts the waiting Reels right away.',
].join('\n');

type TokenBroken = { msg: string; since: string; alerted_at?: string };

async function markTokenBroken(msg: string): Promise<void> {
  const prev = await getSetting<TokenBroken | null>('ig_token_broken');
  const now = new Date().toISOString();
  const state: TokenBroken = prev ? { ...prev, msg } : { msg, since: now };
  // Tell once, then once a day while it stays broken (WF4 runs hourly).
  if (!state.alerted_at || Date.now() - +new Date(state.alerted_at) > 86_400_000) {
    const waiting = await q<{ id: number }>(`SELECT id FROM jobs WHERE ig_due_at <= now() AND (ig_status IS NULL OR ig_status = 'failed') AND ig_due_at > now() - interval '7 days' AND video_path IS NOT NULL ORDER BY id`);
    await say([
      '⚠️ <b>Instagram token stopped working.</b> Instagram posting, comments and insights are paused; YouTube is not affected.',
      `Instagram said: ${esc(msg.slice(0, 200))}`,
      waiting.length ? `Waiting to post: ${waiting.map((w) => `#${w.id}`).join(', ')}. They go up by themselves once the new token is in.` : 'Nothing is lost: posts wait and go up by themselves once the new token is in.',
      '',
      IG_TOKEN_STEPS,
    ].join('\n'));
    state.alerted_at = now;
  }
  await setSetting('ig_token_broken', state);
}

// The token works again: put the posts that failed while it was broken (and any other failed
// post from the last 7 days) back in line. The caption check in instagramDue stops a repost of
// one that did go up.
async function tokenRecovered(): Promise<number[]> {
  const prev = await getSetting<TokenBroken | null>('ig_token_broken');
  if (!prev) return [];
  await setSetting('ig_token_broken', null);
  await setSetting('ig_comments_error', null);
  const back = await q<{ id: number }>(
    `UPDATE jobs SET ig_status = NULL WHERE ig_status = 'failed' AND ig_media_id IS NULL AND video_path IS NOT NULL
       AND ig_due_at > now() - interval '7 days' RETURNING id`,
  );
  return back.map((b) => b.id).sort((a, b) => a - b);
}

// Check a token: who it belongs to, or throws Meta's error.
export async function igWhoAmI(token: string): Promise<{ id?: string; user_id?: string; username?: string }> {
  return ig('me', { fields: 'id,user_id,username', access_token: token }, 'GET');
}

// Recent Reels' captions, to never post the same video twice when a retry follows a post that
// did go up after all.
async function recentCaptions(token: string): Promise<{ id: string; caption: string }[]> {
  try {
    const res = await ig(`${config.instagramUserId}/media`, { fields: 'id,caption', limit: '30', access_token: token }, 'GET');
    return (res.data ?? []).map((m: any) => ({ id: String(m.id), caption: String(m.caption ?? '') }));
  } catch (e) {
    if (igTokenDead(e)) throw e;
    return [];
  }
}

let igRunning: Promise<IgRun> | undefined;
type IgRun = { posted: number[]; failed: string[]; skipped?: string; recovered?: number[] };

// One run at a time: WF4's hourly call and /igtoken can arrive together.
export function instagramDue(): Promise<IgRun> {
  igRunning ??= instagramDueInner().finally(() => { igRunning = undefined; });
  return igRunning;
}

async function instagramDueInner(): Promise<IgRun> {
  if (!config.instagramToken || !config.instagramUserId) return { posted: [], failed: [], skipped: 'INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID not set in app/.env' };
  const posted: number[] = [];
  const failed: string[] = [];
  const token = await igToken();
  let captions: { id: string; caption: string }[];
  try {
    await igWhoAmI(token);
    captions = await recentCaptions(token);
  } catch (e: any) {
    if (!igTokenDead(e)) throw e;
    await markTokenBroken(String(e.message ?? e).replace(/^Instagram: /, ''));
    return { posted, failed, skipped: 'token dead, posts wait' };
  }
  const recovered = await tokenRecovered();
  if (recovered.length) await say(`✅ Instagram token works again. Posting ${recovered.map((id) => `#${id}`).join(', ')} now (up to 3 per hour).`);
  const due = await q<JobRow & { ig_due_at: Date }>(`SELECT * FROM jobs WHERE ig_due_at <= now() AND ig_status IS NULL AND video_path IS NOT NULL ORDER BY ig_due_at LIMIT 3`);
  for (const job of due) {
    const caption = [job.packaging.ig_caption, '', job.facts.source_line, '', (job.packaging.ig_hashtags ?? []).join(' ')].join('\n');
    const own = (job.packaging.ig_caption ?? '').trim();
    const already = own.length >= 20 ? captions.find((c) => c.caption.trim().startsWith(own)) : undefined;
    if (already) {
      await q(`UPDATE jobs SET ig_status = 'posted', ig_media_id = $2 WHERE id = $1`, [job.id, already.id]);
      continue;
    }
    office.working('publisher', `Posting #${job.id} to Instagram`, job.id);
    const name = `${crypto.randomBytes(12).toString('hex')}.mp4`;
    const file = path.join(config.mediaDir, 'ig', name);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(job.video_path!, file);
      const container = await ig(`${config.instagramUserId}/media`, { media_type: 'REELS', video_url: `https://${config.mediaDomain}/ig/${name}`, caption, share_to_feed: 'true', access_token: token });
      let status = 'IN_PROGRESS';
      for (let i = 0; i < 40 && status !== 'FINISHED'; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        status = (await ig(container.id, { fields: 'status_code', access_token: token }, 'GET')).status_code;
        if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${status}`);
      }
      if (status !== 'FINISHED') throw new Error('Instagram took more than 10 minutes to process the video');
      const media = await ig(`${config.instagramUserId}/media_publish`, { creation_id: container.id, access_token: token });
      await q(`UPDATE jobs SET ig_status = 'posted', ig_media_id = $2 WHERE id = $1`, [job.id, media.id]);
      posted.push(job.id);
      office.finished('publisher', `#${job.id} is live on Instagram`, job.id);
    } catch (e: any) {
      if (igTokenDead(e)) {
        // Not this video's fault: it stays in line and goes up once the token is replaced.
        await markTokenBroken(String(e.message ?? e).replace(/^Instagram: /, ''));
        office.failed('publisher', `Instagram token stopped working; #${job.id} waits`, job.id);
        break;
      }
      await q(`UPDATE jobs SET ig_status = 'failed' WHERE id = $1`, [job.id]);
      failed.push(`#${job.id}: ${e.message}`);
      office.failed('publisher', `Instagram refused #${job.id}: ${e.message}`, job.id);
    } finally {
      await fs.rm(file, { force: true });
    }
  }
  return { posted, failed, recovered };
}

// /igtoken <token> from Telegram: check it, store it (it wins over app/.env), post what waits.
export async function setIgToken(token: string): Promise<string> {
  token = token.trim();
  if (token.length < 40 || /\s/.test(token)) return 'That does not look like a token. Copy the whole token and send <code>/igtoken PASTE_TOKEN</code>.';
  let me: { id?: string; user_id?: string; username?: string };
  try {
    me = await igWhoAmI(token);
  } catch (e: any) {
    return `❌ Instagram refused that token, nothing changed.\n${esc(String(e.message ?? e).slice(0, 200))}\n\n${IG_TOKEN_STEPS}`;
  }
  const ids = [me.id, me.user_id].filter(Boolean).map(String);
  if (config.instagramUserId && !ids.includes(String(config.instagramUserId))) {
    return `❌ That token is for @${esc(me.username ?? '?')}, not the account the pipeline posts to (INSTAGRAM_USER_ID ${esc(config.instagramUserId)}). Nothing changed. Generate the token next to @PerCapitaMaps.`;
  }
  await setSetting('instagram_token', { token, refreshed_at: new Date().toISOString() });
  // Make sure the next run sees a change, also when no run noticed the old token was dead yet.
  if (!(await getSetting<TokenBroken | null>('ig_token_broken'))) await setSetting('ig_token_broken', { msg: 'replaced with /igtoken', since: new Date().toISOString(), alerted_at: new Date().toISOString() });
  return `✅ New Instagram token saved for @${esc(me.username ?? '?')}. It renews itself every 20 days. Posting the waiting Reels now.`;
}

// Once (25 Nov 2026): #97 and any post after Instagram's security check were marked failed before
// posts learned to wait for a new token. Mark the token as broken so they are retried the moment a
// working token is seen (and the steps arrive in Telegram if it is still dead).
export async function igTokenSweep(): Promise<void> {
  if (await getSetting<boolean>('ig_token_sweep_2026_11_25')) return;
  await setSetting('ig_token_sweep_2026_11_25', true);
  const failed = await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE ig_status = 'failed' AND ig_media_id IS NULL AND ig_due_at > now() - interval '7 days'`);
  if (failed?.n && !(await getSetting<TokenBroken | null>('ig_token_broken'))) {
    await setSetting('ig_token_broken', { msg: 'session invalidated (25 Nov security check)', since: new Date().toISOString() });
  }
}
