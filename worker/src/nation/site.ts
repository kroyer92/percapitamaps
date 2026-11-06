// The passport page of Per Capita Nation and its small API, served at /nation/ by this worker and
// published at NATION_DOMAIN by Caddy (README, "Per Capita Nation"). This is the only public part
// of the worker. Viewers type a name and pick a country; nothing else about them is kept (privacy.md).
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from '../config.js';
import { getSetting, one, q, setSetting } from '../db.js';
import { countryTable, metricValue, type Metric } from './data.js';
import { dayNumber, dayTimes, openVoteDay, voteFor, VOTES, FLAG_COLOURS, type Census } from './census.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageDir = path.resolve(here, '../../nation-site');
const fontDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@fontsource/inter/package.json')), 'files');

// Names: letters, digits, spaces and . - ' _ @, up to 24 characters, at least one letter, no links
// and nothing from the list below (kept short: "Essex" or "Dickens" must still get in). The daily
// preview lists every name that goes on screen, and /nation remove takes one out.
const BAD = /(fuck|shit|cunt|nigg|faggot|retard|bitch|whore|slut|hitler|porn|pussy|penis|vagina|onlyfans|http|www\.|\.com|\.net|\.org|t\.me|discord\.gg)/i;
export function cleanName(raw: unknown): string | undefined {
  const name = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 24) return undefined;
  if (!/^[\p{L}\p{M}\p{N} .'_@-]+$/u.test(name) || !/\p{L}/u.test(name)) return undefined;
  if (BAD.test(name.replace(/[\s._@'-]+/g, '')) || BAD.test(name)) return undefined;
  return name;
}

async function salt(): Promise<string> {
  let s = await getSetting<string>('nation_salt');
  if (!s) { s = crypto.randomBytes(24).toString('hex'); await setSetting('nation_salt', s); }
  return s;
}
// Only a salted hash of the address is kept, and only to stop one address joining or voting many times.
async function visitor(req: express.Request): Promise<string> {
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';
  return crypto.createHash('sha256').update(`${await salt()}|${ip}`).digest('hex').slice(0, 32);
}

let recentJoins: number[] = []; // all addresses together: a ceiling against floods
const pad = (n: number) => String(n).padStart(4, '0');

// The nation as it is right now (cached for a minute): what the page shows above the form.
type Live = { at: number; body: any };
let live: Live | undefined;
async function state(): Promise<any> {
  if (live && Date.now() - live.at < 60_000) return live.body;
  const table = await countryTable();
  const counts = await q<{ iso3: string; n: number }>('SELECT iso3, count(*)::int AS n FROM nation_citizens GROUP BY iso3');
  const n = counts.reduce((a, c) => a + c.n, 0);
  const avg = (m: Metric) => {
    let s = 0, k = 0;
    for (const c of counts) { const v = metricValue(table.byIso.get(c.iso3), m); if (v !== undefined) { s += v * c.n; k += c.n; } }
    return k ? s / k : null;
  };
  const last = await one<{ day: number; census: Census }>('SELECT day, census FROM nation_days ORDER BY day DESC LIMIT 1');
  const voteDay = await openVoteDay();
  const v = voteFor(voteDay);
  const tally = await q<{ choice: number; n: number }>('SELECT choice, count(*)::int AS n FROM nation_votes WHERE day = $1 GROUP BY choice', [voteDay]);
  const st = (await getSetting<Record<string, string>>('nation_state')) ?? {};
  const flagIndex = st.flag ? VOTES[0].options.indexOf(st.flag) : -1;
  const today = dayNumber(new Date());
  const body = {
    n, homelands: counts.length,
    day: today && today >= 1 ? today : null,
    start: config.nation.start || null,
    nextCensus: today && today >= 1 ? dayTimes(new Date()).census.toISOString() : null,
    avg: { gdp: avg('gdp'), le: avg('le') },
    years: table.years,
    lastCensus: last ? { day: last.day, at: last.census.at, n: last.census.n, metric: last.census.metric, rank: last.census.rank, display: last.census.display, of: last.census.of + 1 } : null,
    vote: { day: voteDay, question: v.question, options: v.options, tally: v.options.map((_, i) => tally.find((t) => t.choice === i)?.n ?? 0) },
    decided: st,
    flag: flagIndex >= 0 ? FLAG_COLOURS[flagIndex] : null,
    countries: table.rows.map((r) => [r.iso3, r.iso2, r.name, r.gdp === undefined ? null : Math.round(r.gdp), r.le === undefined ? null : Math.round(r.le * 10) / 10]),
  };
  live = { at: Date.now(), body };
  return body;
}

async function passport(no: number) {
  const c = await one<{ no: number; name: string; iso3: string; joined_at: Date }>('SELECT no, name, iso3, joined_at FROM nation_citizens WHERE no = $1', [no]);
  if (!c) return undefined;
  const same = await one<{ n: number }>('SELECT count(*)::int AS n FROM nation_citizens WHERE iso3 = $1', [c.iso3]);
  const day = dayNumber(new Date(c.joined_at));
  return { no: c.no, number: pad(c.no), name: c.name, iso3: c.iso3, joined: new Date(c.joined_at).toISOString(), joinedDay: day && day >= 1 ? day : null, sameCountry: same?.n ?? 1 };
}

export const nationSite = express.Router();

// The page's links are relative, so it must be opened as /nation/ (with the slash).
nationSite.get('/', (req, res) => {
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, '/nation/');
  res.sendFile(path.join(pageDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
});
nationSite.use('/fonts', express.static(fontDir, { maxAge: '30d', fallthrough: false }));

nationSite.get('/api/state', async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await state());
});

nationSite.post('/api/join', async (req, res) => {
  const name = cleanName(req.body?.name);
  const iso3 = String(req.body?.iso3 ?? '').toUpperCase();
  if (!name) return res.status(400).json({ error: 'Use up to 24 letters, numbers or spaces, and no links or rude words.' });
  const table = await countryTable();
  if (!table.byIso.has(iso3)) return res.status(400).json({ error: 'Choose your home country from the list.' });
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Tick the box so we can show your name and country.' });
  const now = Date.now();
  recentJoins = recentJoins.filter((t) => now - t < 60_000);
  if (recentJoins.length >= 60) return res.status(429).json({ error: 'Lots of people are joining right now. Try again in a minute.' });
  const who = await visitor(req);
  const mine = await one<{ n: number }>(`SELECT count(*)::int AS n FROM nation_citizens WHERE ip_hash = $1 AND joined_at > now() - interval '24 hours'`, [who]);
  if ((mine?.n ?? 0) >= config.nation.joinsPerDay) return res.status(429).json({ error: 'This connection already made a few passports today. Try again tomorrow.' });
  recentJoins.push(now);
  const code = crypto.randomBytes(16).toString('hex');
  const row = await one<{ no: number }>('INSERT INTO nation_citizens (name, iso3, code, ip_hash) VALUES ($1, $2, $3, $4) RETURNING no', [name, iso3, code, who]);
  live = undefined;
  res.json({ code, passport: await passport(row!.no) });
});

nationSite.get('/api/passport/:no', async (req, res) => {
  const p = await passport(Number(req.params.no));
  if (!p) return res.status(404).json({ error: 'No citizen with that number.' });
  res.json(p);
});

nationSite.get('/api/me', async (req, res) => {
  const c = await one<{ no: number }>('SELECT no FROM nation_citizens WHERE code = $1', [String(req.query.code ?? '')]);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(await passport(c.no));
});

// Leaving deletes the row for good; the number is not given to anyone else.
nationSite.post('/api/leave', async (req, res) => {
  const gone = await one<{ no: number }>('DELETE FROM nation_citizens WHERE code = $1 RETURNING no', [String(req.body?.code ?? '')]);
  live = undefined;
  res.json({ ok: !!gone });
});

nationSite.get('/api/find', async (req, res) => {
  const s = String(req.query.q ?? '').trim().slice(0, 40);
  if (!s) return res.json([]);
  const no = Number(s.replace(/^#/, ''));
  const rows = Number.isInteger(no) && no > 0
    ? await q('SELECT no, name, iso3 FROM nation_citizens WHERE no = $1', [no])
    : await q(`SELECT no, name, iso3 FROM nation_citizens WHERE name ILIKE $1 ORDER BY no LIMIT 8`, [`%${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%`]);
  res.json(rows.map((r: any) => ({ ...r, number: pad(r.no) })));
});

// One vote per address on the open question; voting again changes it.
nationSite.post('/api/vote', async (req, res) => {
  const day = await openVoteDay();
  const v = voteFor(day);
  const choice = Number(req.body?.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= v.options.length || Number(req.body?.day) !== day) return res.status(400).json({ error: 'That vote has closed. Reload the page for the new question.' });
  await q(`INSERT INTO nation_votes (day, voter, choice) VALUES ($1, $2, $3) ON CONFLICT (day, voter) DO UPDATE SET choice = $3, at = now()`, [day, await visitor(req), choice]);
  live = undefined;
  res.json((await state()).vote);
});

// Nightly: drop what is no longer needed (privacy.md).
export async function nationHousekeeping(): Promise<void> {
  await q(`UPDATE nation_citizens SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND joined_at < now() - interval '2 days'`);
  await q(`DELETE FROM nation_votes WHERE at < now() - interval '7 days'`);
}
