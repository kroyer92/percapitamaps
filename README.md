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

## Telegram

Buttons on each preview: Approve, Reject, Hook 1–5. Commands: `/status`, `/produce [n]`,
`/link <job> <url>`, `/followup <job or url>`, `/help`.

## Licenses of what it uses

Remotion (free for individuals and teams up to 3), Kokoro-82M (Apache 2.0), faster-whisper (MIT),
Natural Earth via world-atlas (public domain), country-flag-icons (MIT), Inter (OFL).
Data: World Bank WDI (CC BY 4.0), Our World in Data (CC BY 4.0), with sources named in every video.
