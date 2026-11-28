// The weekly "what is winning" scan (from 28 Nov 2026). Finds map and country Shorts from the last
// 14 days that did far better than their own channel usually does, the method of the open-source
// youtube-outlier-finder: a video's views divided by the median views of that channel's latest
// uploads. The daily idea finder (hot.ts) then borrows their TOPICS for the argue-about slot,
// never their videos or wording.
//
// It runs on its own plain API key (YT_RESEARCH_KEY, or /ytkey in Telegram) from a separate free
// Google Cloud project, so the audited upload project keeps only the calls it was approved for.
// Cost: about 650 of the free 10,000 daily quota units, once a week.
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { say } from './telegram.js';

const API = 'https://www.googleapis.com/youtube/v3';
const QUERIES = [
  'countries map', 'every country where', 'only countries that', 'which country has the most',
  'country comparison', 'geography facts countries',
];
const SCAN_DAYS = 14;
const EVERY_DAYS = 6; // weekly, with a day of slack so a missed run catches up
const MIN_VIEWS = 20_000;
const MIN_RATIO = 3; // at least 3x the channel's usual views
const KEEP = 12;

export interface Winner { title: string; views: number; ratio: number; channel: string; url: string; published: string }
export interface ScanResult { at: string; winners: Winner[]; error?: string }

export async function researchKey(): Promise<string> {
  return (await getSetting<{ key: string }>('yt_research_key'))?.key || config.ytResearchKey;
}

async function api(path: string, params: Record<string, string>, key: string): Promise<any> {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${body?.error?.message ?? 'no detail'}`);
  return body;
}

// "PT1M5S" -> 65
export function isoSeconds(d: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : Infinity;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// Pure part: rank candidates by views over their channel's usual views.
export function pickWinners(videos: { id: string; title: string; views: number; seconds: number; channelId: string; channel: string; published: string }[], usual: Map<string, number>, ownChannel = ''): Winner[] {
  const seen = new Set<string>();
  return videos
    .filter((v) => v.seconds <= 180 && v.views >= MIN_VIEWS && v.channel !== ownChannel)
    .map((v) => ({ v, ratio: v.views / Math.max(1_000, usual.get(v.channelId) ?? 0) }))
    .filter((x) => x.ratio >= MIN_RATIO)
    .sort((a, b) => b.ratio - a.ratio)
    .filter((x) => !seen.has(x.v.id) && seen.add(x.v.id))
    .slice(0, KEEP)
    .map(({ v, ratio }) => ({ title: v.title, views: v.views, ratio: Math.round(ratio * 10) / 10, channel: v.channel, url: `https://youtube.com/shorts/${v.id}`, published: v.published }));
}

export async function runScan(key: string): Promise<ScanResult> {
  const after = new Date(Date.now() - SCAN_DAYS * 86_400_000).toISOString();
  const ids = new Set<string>();
  for (const q of QUERIES) {
    const r = await api('search', { part: 'id', type: 'video', videoDuration: 'short', order: 'viewCount', publishedAfter: after, maxResults: '25', relevanceLanguage: 'en', q }, key);
    for (const it of r.items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
  }
  const videos: { id: string; title: string; views: number; seconds: number; channelId: string; channel: string; published: string }[] = [];
  for (const part of chunks([...ids], 50)) {
    const r = await api('videos', { part: 'snippet,statistics,contentDetails', id: part.join(',') }, key);
    for (const v of r.items ?? []) {
      videos.push({
        id: v.id, title: v.snippet?.title ?? '', views: Number(v.statistics?.viewCount ?? 0), seconds: isoSeconds(v.contentDetails?.duration),
        channelId: v.snippet?.channelId ?? '', channel: v.snippet?.channelTitle ?? '', published: v.snippet?.publishedAt ?? '',
      });
    }
  }
  // Each candidate channel's usual views: the median of its 15 latest uploads.
  const channels = [...new Set(videos.filter((v) => v.views >= MIN_VIEWS && v.seconds <= 180).map((v) => v.channelId))];
  const usual = new Map<string, number>();
  for (const part of chunks(channels, 50)) {
    const r = await api('channels', { part: 'contentDetails', id: part.join(',') }, key);
    for (const c of r.items ?? []) {
      const uploads = c.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) continue;
      try {
        const pl = await api('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '15' }, key);
        const latest = (pl.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
        if (!latest.length) continue;
        const st = await api('videos', { part: 'statistics', id: latest.join(',') }, key);
        usual.set(c.id, median((st.items ?? []).map((v: any) => Number(v.statistics?.viewCount ?? 0))));
      } catch (e: any) {
        console.warn(`[scan] channel ${c.id}: ${e.message}`);
      }
    }
  }
  return { at: new Date().toISOString(), winners: pickWinners(videos, usual, config.channelName) };
}

export async function lastScan(): Promise<ScanResult | undefined> {
  return getSetting<ScanResult>('winner_scan');
}

// Called by the daily idea finder: scans when the last scan is a week old. Without a key it asks
// for one in Telegram once a week (a Google account is needed to make one, so that step is yours).
export async function scanIfDue(): Promise<ScanResult | undefined> {
  const last = await lastScan();
  if (last && Date.now() - +new Date(last.at) < EVERY_DAYS * 86_400_000) return last;
  const key = await researchKey();
  if (!key) {
    const asked = await getSetting<{ at: string }>('yt_research_key_asked');
    if (!asked || Date.now() - +new Date(asked.at) > 7 * 86_400_000) {
      await setSetting('yt_research_key_asked', { at: new Date().toISOString() });
      await say(KEY_STEPS);
    }
    return last;
  }
  try {
    const res = await runScan(key);
    await setSetting('winner_scan', res);
    console.log(`[scan] ${res.winners.length} winning map Shorts: ${res.winners.slice(0, 3).map((w) => w.title).join(' | ')}`);
    return res;
  } catch (e: any) {
    console.error('[scan] failed:', e.message);
    // Keep the older winners; try again tomorrow.
    return last;
  }
}

export const KEY_STEPS = [
  '🔑 <b>One step to switch on the weekly winner scan</b> (finds the map Shorts that are winning right now, so half our videos borrow their topics). It needs a free YouTube key from a Google account, which only you can create:',
  '1. Open console.cloud.google.com on your phone, signed in with any Google account, and create a new project (any name).',
  '2. Search "YouTube Data API v3" and press Enable.',
  '3. Go to Credentials, press Create credentials, then API key, and copy it.',
  '4. Paste it here as <code>/ytkey PASTE_KEY</code>. The bot checks it and deletes your message.',
  'Until then the new topic slot still runs, from its own list of topics.',
].join('\n');

// /ytkey: checked with one cheap call (1 quota unit) before it is stored.
export async function setResearchKey(key: string): Promise<string> {
  try {
    await api('videos', { part: 'id', id: 'jNQXAC9IVRw' }, key);
  } catch (e: any) {
    return `⚠️ That key did not work (${String(e.message).replace(/[<>&]/g, '')}). Check that "YouTube Data API v3" is enabled in the same project, then paste it again.`;
  }
  await setSetting('yt_research_key', { key, at: new Date().toISOString() });
  await setSetting('winner_scan', null);
  return '✅ Key saved. The winner scan runs with tomorrow\'s idea search and then once a week. Nothing else to do.';
}
