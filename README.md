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
  WF6 Comments  hourly at :40 ────────────►  POST /comments/youtube   new comments → checked reply → Telegram
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
| Self-update after each merge (once) | `sudo bash /opt/percapita/app/tools/autodeploy/install.sh`: every 5 min it pulls main, rebuilds when the worker is idle, and says so in Telegram. Off: `sudo systemctl disable --now percapita-autodeploy.timer` |
| Create tables, load and check datasets | `docker compose run --rm migrate` |
| Queue the 10 launch concepts | `docker compose exec -T postgres psql -U percapita -d percapita < app/sql/seed_launch_concepts.sql` |
| One test video | `docker compose exec render-worker npm run test-render -- --concept cattle` |
| Voice samples | `docker compose exec render-worker npm run voice-test` |
| Long-form script only (no render) | `docker compose exec render-worker npm run longform -- --plan --theme money` (the map quiz; add `--classic` for the classic one) |
| Long-form thumbnail again | `docker compose exec render-worker npm run thumb -- --longform 1` |
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

## Per Capita Nation

`worker/src/nation/`: a country made of viewers. On the passport page (`worker/nation-site`, served
at `/nation/` and published at `NATION_DOMAIN`) a viewer types a name, picks a home country and gets
a citizen number. Every day at `NATION_SLOT` minus `NATION_LEAD_HOURS` (16:00 and 2 hours: 14:00 US
Eastern) the census counts the citizens and averages the World Bank figures of their home countries
(income per person on odd days, life expectancy on even days), ranks the nation among real
countries, and finds the smallest real country it hasn't passed yet. The script is written in code
from those numbers (no language model), voiced, captioned word by word from Whisper's timings, drawn
as a living island in the channel's map style (`remotion/nation/Nation.tsx`) and checked by QA. The
preview comes to Telegram and approves itself `NATION_AUTO_APPROVE_MINUTES` (60) before the slot
unless you press Reject; then WF3 uploads it like any Short (playlist `PLAYLIST_NATION`) and WF4
posts the Reel as soon as it is live (`NATION_IG_DELAY_HOURS`, default 0). The page also runs
votes, one question at a time in a fixed order (flag, capital, motto, animal, dish, sport;
`VOTES` in `census.ts`). Voting waits for villagers: it opens at `NATION_VOTE_FROM` (50) citizens,
and a question is decided at the first census where it has `NATION_VOTE_MIN` (20) votes, so it can
stay open for days. Until voting opens, the Short says "At 50 citizens, you vote on our flag". A
result is announced in that day's episode, and the flag colours appear on the island and the
passports. Episodes are jobs with format `NATION`, so
scorecards and analytics work as usual; they are left out of the format bandit and auto-tuning.

Citizens come from our own page, not from YouTube comments: the YouTube API policies don't allow
showing comment data publicly. Only the name and country are stored (privacy.md).

Setup on the server, once (all in one go, as root in `/opt/percapita`):

```
echo 'NATION_DOMAIN=nation.percapitamaps.duckdns.org' >> .env
echo 'NATION_START=2026-11-16' >> app/.env
cat >> Caddyfile <<'CADDY'

{$NATION_DOMAIN} {
  redir / /nation/
  handle /nation* {
    reverse_proxy render-worker:8080
  }
  handle {
    respond 404
  }
}
CADDY
cd app && git pull && cd .. && docker compose up -d --build
```

DuckDNS answers for every name under `percapitamaps.duckdns.org`, so the new address needs no DNS
change, and Caddy gets its certificate by itself. Only `/nation` is passed through. `NATION_START`
is Day 1; before it, the page already takes citizens (they join as founders) and the first vote.
YouTube and Instagram don't let a Short's text carry a clickable link, so the page goes in the
channel's links (YouTube Studio → Customisation → Basic info → Links) and the Instagram bio, once.

Telegram: `/nation` (citizens, vote, times), `/nation test` (a preview from the citizens so far,
never uploaded), `/nation make` (make today's episode again), `/nation remove <number>` (delete a
citizen; today's episode is made again without them).

## Telegram

Buttons on each preview: Approve, Reject, Hook 1–5. Commands: `/status`, `/produce [n]`,
`/link <job> <url>`, `/followup <job or url>`, `/tune [on|off|reset]`, `/opening`, `/longform [theme] [game|classic]`, `/nation`, `/help`.

## Weekly long-form video

`worker/src/longform/`: one 16:9 video a week on one theme (money, health, food, work, people,
energy, tech, nature; `themes.ts`). The theme is the one whose datasets earned the Shorts the most
views, skipping the last four themes used. Every line is written by code from the facts builder, so
no number can be made up. It comes in two styles:

- **Map quiz** (the default since Nov 2026; `game.ts`, `game-time.ts`, `remotion/Game.tsx`): about 9
  rounds of 35 to 45 seconds, one map each. A cold open teases the biggest surprises without naming an
  answer (America not in the top 5, "in 1960, 74 countries were under 50 years"), says how many
  countries are in the top ten on most maps, and gives the rules. Each round asks a question the
  viewer answers before a 4-second timer runs out: pick the #1 of three, then and now (how many
  countries are under a line today), how many are above a line, or higher or lower than a famous
  country. Then the answer lands with a "+1" for the viewer's score, the top five, the viewer's own
  country (US, UK, Canada, Australia, India, Germany), and one closing comparison. It ends on the
  country in the top ten on the most maps and "comment your score". Sound effects (tick, timer
  clock, riser and hit on each answer) are placed on the same frames as the picture. A map whose top
  value several countries share (100%) is left out: it has no #1 to guess.
- **Classic** (`plan.ts`, `remotion/Longform.tsx`): 8 to 10 maps, each counted down from #10 to the
  #1 in amber, with extra facts and an "every #1" recap.

If the map quiz fails, the same run makes the classic one instead and says so in Telegram, so the
weekly video still comes. `/longform [theme] [game|classic]` makes one now (the style word picks the
style for that one video); `LONGFORM_ROUNDS` sets the quiz's rounds (7 to 12, default 9) and
`LONGFORM_STYLE=classic` the default style. Both have chapters and a thumbnail (`Thumb.tsx`: the quiz
one asks "GET 9/9?" and shows no answer).

It runs by itself on Saturday from 21:00 (LOCAL_TZ) in the same work lane as the Shorts, takes about
an hour, and arrives in Telegram with the thumbnail, a link to watch it, and Approve/Reject. With
`YOUTUBE_API_UPLOADS=on`, Approve hands it to WF3 (job id `L<n>`), which uploads it scheduled for Sunday
11:00 US Eastern with title, description and chapters, tags, comment and thumbnail (`thumbnails.set`;
if YouTube refuses the thumbnail, Telegram says how to add it by hand), adds it to `PLAYLIST_LONGFORM`
if set, and reports back, which links it. Telegram then lists the Shorts whose "Related video" could
point to it (not in YouTube's API, so optional). With uploads off, Approve sends the steps to upload by
hand and `/link L1 <url>` records it. `LONGFORM_AUTO=off` in `app/.env` stops the weekly run. Files: `renders/longform-N.mp4`, a
download copy under `public/longform/` (deleted after 14 days; renders after 30).

**Its own scorecard** (`longform/score.ts`): WF5 measures each long-form as job `L<n>` at 72 hours,
7 days and 28 days after it goes public (the due list puts them first; n8n passes the id through
unchanged). Once a window has settled (3 days after it, as Analytics lags), Telegram gets: still
watching at 0:30 (target 60%), how much of the video an average view covers (target 30%), watch
hours, and the chapter that loses viewers fastest, with a **Your move** line. No single video changes
anything: the Sunday report has a "Weekly long video" section, and once 3 quiz videos have 7-day
numbers it compares them with the classic ones. Only if the classic kept viewers clearly better (5
points on both numbers) does it offer a button, "Use the classic long-form", which switches the style.
Rows are in `longform_metrics`; the analysis export lists them under `longforms`.

## Automatic analysis

At 24 h, 72 h and 7 days after each upload, WF5 pulls the YouTube numbers and the retention curve,
the worker adds the Instagram Reel's insights, and `worker/src/scorecard.ts` scores the video:

- **Stages:** stayed (engaged ÷ views, the API's stand-in for "viewed vs swiped away"), watched
  (average % viewed), shares and subs per 1,000 engaged views; on Instagram skip rate, watch time
  and share rate. Bands follow the per-video metric targets doc until 10 videos have the same
  snapshot, then the channel's own bottom 20% / median / top 20%.
- **Telegram message per snapshot:** Winner / Average / Loser / Too early, the steepest 2-second
  drop in the retention curve and the script beat on screen then, why it scored that way, and a
  closing **Your move** line: the exact action, or "nothing for you to do" with the reason and the
  date of the next scorecard. One video never changes the recipe, and nothing touches what a running
  test measures. Winners get 2 follow-ups queued automatically (once per video).
- **Sunday report** opens with **Your move** (exact /link lines, a tap, or "Nothing this week"),
  **Done for you** and **Waiting on data**, then a channel call: the first funnel stage most
  measured videos fail (5+ videos with 300+ views), which either waits on the running test or says
  to forward the report to Claude for the code change.
- **Sunday auto-tuning** (`worker/src/tune.ts`): HOOK_TEST and LENGTH_TEST options that earn more
  engaged views get picked more often, at most 20 points a week, never under 10%. `/tune off`
  goes back to the plain rotation, `/tune reset` to even weights.
- **Map Reveal opening test** (from 2 Nov 2026, `worker/src/opening.ts`): every other Map Reveal
  opens on a famous country ranked 2nd to 15th ("America? Only 6th richest."), whose rank flies into
  a strip of slots #1 to #5 where #1 stays "?" until the reveal; the rest keep the classic opening.
  Topics without such a country, and rank strip videos moved to another hook, sit the test out.
  `/opening`, the weekly report and the Studio lab compare stayed at 72 h, and say "too early" until
  each opening has 5 measured videos; then a lead of 10 points decides, or, without one, whichever
  is ahead at 10 videos each. With a verdict the message carries a "Use … only" button that applies
  it (settings key `mr_opening`, no restart). `MR_OPENING=rank_strip` or `classic` in `.env` also
  gives every Map Reveal one opening. Try it with
  `docker compose exec render-worker npm run test-render -- --concept cattle --opening rank_strip`.
- **Weekly export for Claude** (`ANALYSIS_EXPORT=on`, `ANALYSIS_EXPORT_TOKEN` of 24+ random
  characters): writes `public/analysis/<token>.json`. Keep it off until the YouTube API audit is
  approved and `privacy.md` allows it.

Instagram insights need the `instagram_business_manage_insights` permission on the token; without
it the message says so and only YouTube is scored.

## Comment replies

Every hour WF6 reads the newest 100 comment threads on the channel (and all replies in busy
threads, such as the pinned comment) and hands them to the worker. For each comment nobody from
the channel has answered yet, Telegram gets one message: the comment, the one thing to do, and
the reply text to paste (tap the grey text to copy it, then "Open the comment"). At most 8 per
run (`COMMENTS_PER_RUN`), newest first; the rest come an hour later. Instagram comments come the
same way, from every Reel on the account in the last 30 days (also ones posted by hand). The token
needs `instagram_business_manage_comments`; while Instagram can't be read, Telegram says why and
gives the exact fix once a day, and one broken or deleted Reel never hides the others.

- **Numbers only from the video's own data.** A comment that names countries ("what about
  Vietnam?", "as a German…", "I guessed Qatar") gets their rank and value from the same ranking
  the video showed, in Niko's format: opener, `Same World Bank data (2024): …`, highest first,
  then the US (or the world median) to compare, no final full stop. A country missing from the
  data gets "isn't in this 2024 data", never a guess. Try it on the server:
  `docker compose exec render-worker npm run comments-try -- wb_100_dollars "What about Vietnam?"`
- **Never the answer.** Every format except SCALE is a quiz, so a reply never names the top 3
  countries or their rank or value (a commenter who names one gets "Iceland makes the top 3").
  The model never sees them, and a model reply that names them or talks about "highest" is
  thrown away.
- **Slang and confusion.** Short forms are written out before anything reads the comment (fym,
  wdym = "what do you mean", idk, ngl, tbh…), so they are never taken for a name. "What do you
  mean by index points", "what is HDI" or "I'm so confused" get a plain explanation of what the
  number measures (fixed text per dataset in `MEANING`, or built from its title and unit).
- **Critical or political comments** get "Fair point." and one neutral line on what the map
  counts, no rebuttal. Praise: "Heart it. No reply needed." Spam: remove it.
- **The model only sorts.** The VPS model (Ollama) labels each comment and may word a reply to a
  general question; a reply with any number that is not in the video's facts, an emoji or a
  promise of a future video is thrown away for a fixed one. Comments never go to Gemini or Groq
  (YouTube API data stays on the server), and rows in `comments` are deleted after 30 days.
- **Nothing is posted.** Replies stay manual until the YouTube API audit is approved.

## Licenses of what it uses

Remotion (free for individuals and teams up to 3), Kokoro-82M (Apache 2.0), faster-whisper (MIT),
Natural Earth via world-atlas (public domain), country-flag-icons (MIT), Inter (OFL).
Data: World Bank WDI (CC BY 4.0), Our World in Data (CC BY 4.0), with sources named in every video.
