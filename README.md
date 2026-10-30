# Per Capita Maps Studio

Private tool behind the YouTube channel **Per Capita Maps** (@PerCapitaMaps). It finds a
surprising fact in open data, writes and voices a Short about it, renders the map or chart,
checks it, and sends it to Telegram for approval. The policy pages for Google's OAuth screen
(`index.md`, `privacy.md`, `terms.md`) are served from this repo by GitHub Pages.

## How it fits together

```
n8n (schedules, YouTube credentials)          render-worker (this repo, worker/)
  WF1 Discover  05:00 UTC  ───────────────►  POST /discover      trend signals → angles → topics
  WF2 Produce   07:00, 15:00 UTC ─────────►  POST /produce       facts → script → voice → video → QA → Telegram
  WF3 Approved upload (after API audit) ◄──  you tap Approve in Telegram
  WF4 Instagram hourly ───────────────────►  POST /instagram/run
  WF5 Analyze   every 6 h, Sun 18:00 ─────►  /analytics/due, /analytics/snapshot, /report/weekly
  WF0 Errors    any failure → Telegram
```

- **Numbers never come from the language model.** `worker/src/facts.ts` computes every
  figure from the World Bank or Our World in Data; the script, hooks and title may only use
  numbers that appear in those facts (`worker/src/validate.ts`), and a critic pass checks
  framing.
- **Voice:** Kokoro (Apache 2.0). **Check:** faster-whisper. **Video:** Remotion templates in
  `worker/remotion/` for the five formats (Map Reveal, Top 10 Countdown, Then vs Now,
  If the World Were 100 People, Guess the Country).
- **Datasets:** `worker/src/data/catalog.ts`. `migrate` verifies each one live (source exists,
  enough countries, license CC BY or more open) and disables any that fail.

## Server commands (run in `/opt/percapita`)

| What | Command |
| --- | --- |
| Start or update everything | `cd app && git pull && cd .. && docker compose up -d --build` |
| Create tables, load and check datasets | `docker compose run --rm migrate` |
| Queue the 10 launch concepts | `docker compose exec -T postgres psql -U percapita -d percapita < app/sql/seed_launch_concepts.sql` |
| One test video | `docker compose exec render-worker npm run test-render -- --concept cattle` |
| Voice samples | `docker compose exec render-worker npm run voice-test` |
| Re-check datasets | `docker compose exec render-worker npm run check-datasets` |
| Import n8n workflows | `docker compose exec n8n n8n import:workflow --separate --input=/import/workflows` |
| Worker logs | `docker compose logs -f render-worker` |

Settings live in `app/.env` on the server (never in git). See the launch checklist for every key.

## Language model

Scripts, hooks, titles, the critic and the idea finder use a hosted model when a key is set, and
the VPS model (Ollama) only as the last resort. Add to `app/.env`:

```
GEMINI_API_KEY=your-key-from-aistudio.google.com
GROQ_API_KEY=your-key-from-console.groq.com   # optional backup
```

Order: `LLM_PROVIDERS` (default `gemini,groq,ollama`); a provider without a key is skipped, and
one that is down or out of quota passes to the next. When a model answers "busy" (503) or "too
many requests" (429) the worker asks once more after 3 s; a model still busy, or one that gives no
answer within 90 s, rests for 10 minutes and the next one is asked. Models: `GEMINI_MODEL` (a comma list, default
`gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite`, tried in order), `GROQ_MODEL` (default `openai/gpt-oss-120b`). The Telegram preview says which
model wrote each video. Embeddings (the duplicate-topic check) stay on Ollama. Only public data,
our own scripts and trend headlines go to these models, never YouTube API data.

## Studio page

An office you can open in the browser: a wall TV with the road to YPP and the qualifying date at
the current pace, a whiteboard of the next videos and why each was picked, an office floor
where the crew (Scout, Writer, Narrator, Editor, Checker, Publisher, Analyst) are small robots:
they walk to their desk when their step starts, carry the script, voice and video to the next
desk, wait at your inbox for your OK, and go for coffee when free, and monitors for video performance, earnings (locked until YPP) and the
experiment lab. It is served by the render worker at `/studio/` (no extra container, about one
database read every 30 seconds) and is read-only. Add `?demo` to the address to see it with
example numbers and a video moving through the office. The robots and furniture are three.js
models in `tools/office-art`, rendered to PNGs in `worker/studio/office/art` (see its README).

Setup on the server, once:

1. Add `STUDIO_DOMAIN=studio.percapitamaps.duckdns.org` to `/opt/percapita/.env`.
2. `docker compose exec caddy caddy hash-password` and type a password; copy the hash it prints.
3. Add this block to `/opt/percapita/Caddyfile`, with the hash pasted in:

   ```
   {$STUDIO_DOMAIN} {
     basic_auth {
       niko PASTE_THE_HASH_HERE
     }
     redir / /studio/
     handle /studio* {
       reverse_proxy render-worker:8080
     }
     handle {
       respond 404
     }
   }
   ```

   Only `/studio` is passed through, so the worker's other endpoints stay private.
4. Pull, rebuild and restart: `cd app && git pull && cd .. && docker compose up -d --build`, then
   re-import the workflows (WF5 now also fetches the channel totals for the wall TV).

## Telegram

Buttons on each preview: Approve, Reject, Hook 1–5. Commands: `/status`, `/produce [n]`,
`/link <job> <url>`, `/followup <job or url>`, `/tune [on|off|reset]`, `/opening`, `/help`.

## Automatic analysis

At 24 h, 72 h and 7 days after each upload, WF5 pulls the YouTube numbers and the retention curve,
the worker adds the Instagram Reel's insights, and `worker/src/scorecard.ts` scores the video:

- **Stages:** stayed (engaged ÷ views, the API's stand-in for "viewed vs swiped away"), watched
  (average % viewed), shares and subs per 1,000 engaged views; on Instagram skip rate, watch time
  and share rate. Bands follow the per-video metric targets doc until 10 videos have the same
  snapshot, then the channel's own bottom 20% / median / top 20%.
- **Telegram message per snapshot:** Winner / Average / Loser / Too early, the steepest 2-second
  drop in the retention curve and the script beat on screen then, and one fix for the first stage
  that misses. Winners get a "Make 2 follow-ups" button.
- **Sunday auto-tuning** (`worker/src/tune.ts`): HOOK_TEST and LENGTH_TEST options that earn more
  engaged views get picked more often, at most 20 points a week, never under 10%. `/tune off`
  goes back to the plain rotation, `/tune reset` to even weights.
- **Map Reveal opening test** (from 2 Nov 2026, `worker/src/opening.ts`): every other Map Reveal
  opens on a famous country ranked 2nd to 15th ("America? Only 6th richest."), whose rank flies into
  a strip of slots #1 to #5 where #1 stays "?" until the reveal; the rest keep the classic opening.
  `/opening`, the weekly report and the Studio lab compare stayed at 72 h, and say "too early" until
  each opening has 5 measured videos; then a lead of 10 points decides. `MR_OPENING=rank_strip` or
  `classic` in `.env` gives every Map Reveal one opening. Try it with
  `npm run test-render -- --concept cattle --opening rank_strip`.
- **Weekly export for Claude** (`ANALYSIS_EXPORT=on`, `ANALYSIS_EXPORT_TOKEN` of 24+ random
  characters): writes `public/analysis/<token>.json`. Keep it off until the YouTube API audit is
  approved and `privacy.md` allows it.

Instagram insights need the `instagram_business_manage_insights` permission on the token; without
it the message says so and only YouTube is scored.

## Licenses of what it uses

Remotion (free for individuals and teams up to 3), Kokoro-82M (Apache 2.0), faster-whisper (MIT),
Natural Earth via world-atlas (public domain), country-flag-icons (MIT), Inter (OFL).
Data: World Bank WDI (CC BY 4.0), Our World in Data (CC BY 4.0), with sources named in every video.
