// After you approve: pick the slot, write the upload pack, and (once the API audit has
// cleared) hand the upload to n8n's WF3. Also the Instagram cross-post (WF4).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, FORMAT_NAMES, type Format } from './config.js';
import { one, q, getSetting, setSetting } from './db.js';
import { buildDescription, seriesTitle } from './content.js';
import { esc, say } from './telegram.js';
import { fmtIn, upcomingSlots } from './lib/time.js';
import type { JobRow } from './produce.js';
import * as office from './activity.js';

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
  const slot = await nextSlot();
  const series = config.seriesNaming
    ? ((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE format = $1 AND series_no IS NOT NULL`, [job.format]))?.n ?? 0) + 1
    : null;
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
    await say(`✅ Approved #${id}. Uploading through the YouTube API, scheduled for ${when}.`);
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

async function handToN8n(job: JobRow, packaging: JobRow['packaging'] & { description: string }, slot: Date): Promise<void> {
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
    playlist_id: config.playlists[job.format] || null,
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
  const publishedAt = job.slot_at && +new Date(job.slot_at) > Date.now() - 6 * 3600_000 ? new Date(job.slot_at) : new Date();
  await q(
    `UPDATE jobs SET status = 'published', youtube_video_id = $2, youtube_url = $3, published_at = $4,
       ig_due_at = $4::timestamptz + make_interval(hours => $5), updated_at = now() WHERE id = $1`,
    [id, videoId, url ?? `https://youtube.com/shorts/${videoId}`, publishedAt, config.instagramDelayHours],
  );
  await q(`UPDATE datasets SET last_used_at = now() WHERE id = (SELECT dataset_id FROM topics WHERE id = $1)`, [job.topic_id]);
  await q(`UPDATE topics SET status = 'done' WHERE id = $1`, [job.topic_id]);
  office.finished('publisher', `#${id} is live on YouTube`, id);
  return `🔗 Linked #${id} to ${videoId}. Analytics will track it${config.instagramToken ? `, and Instagram posts it ${config.instagramDelayHours} hours after it goes live` : ''}.`;
}

// ---------- Instagram (WF4) ----------

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
  if (json.error) throw new Error(`Instagram: ${json.error.message}`);
  return json;
}

export async function instagramDue(): Promise<{ posted: number[]; failed: string[]; skipped?: string }> {
  if (!config.instagramToken || !config.instagramUserId) return { posted: [], failed: [], skipped: 'INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID not set in app/.env' };
  const due = await q<JobRow & { ig_due_at: Date }>(`SELECT * FROM jobs WHERE ig_due_at <= now() AND ig_status IS NULL AND video_path IS NOT NULL ORDER BY ig_due_at LIMIT 3`);
  const posted: number[] = [];
  const failed: string[] = [];
  const token = await igToken();
  for (const job of due) {
    office.working('publisher', `Posting #${job.id} to Instagram`, job.id);
    const name = `${crypto.randomBytes(12).toString('hex')}.mp4`;
    const file = path.join(config.mediaDir, 'ig', name);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(job.video_path!, file);
      const caption = [job.packaging.ig_caption, '', job.facts.source_line, '', (job.packaging.ig_hashtags ?? []).join(' ')].join('\n');
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
      await q(`UPDATE jobs SET ig_status = 'failed' WHERE id = $1`, [job.id]);
      failed.push(`#${job.id}: ${e.message}`);
      office.failed('publisher', `Instagram refused #${job.id}: ${e.message}`, job.id);
    } finally {
      await fs.rm(file, { force: true });
    }
  }
  return { posted, failed };
}
