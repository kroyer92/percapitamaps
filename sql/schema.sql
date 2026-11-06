-- Per Capita Maps pipeline schema. Safe to run more than once.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS datasets (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  unit          text NOT NULL,
  topic         text NOT NULL,
  grp           text,
  spec          jsonb NOT NULL,             -- the full catalog entry (worker/src/data/catalog.ts)
  license       text NOT NULL,
  decimals      int  NOT NULL DEFAULT 0,
  additive      boolean NOT NULL DEFAULT false,
  threshold     jsonb,
  min_countries int  NOT NULL DEFAULT 100,
  enabled       boolean NOT NULL DEFAULT true,
  resolved_ref  jsonb,
  source_url    text,
  latest_year   int,
  countries     int,
  verified_at   timestamptz,
  check_error   text,
  last_used_at  timestamptz
);

CREATE TABLE IF NOT EXISTS topics (
  id             bigserial PRIMARY KEY,
  dataset_id     text NOT NULL REFERENCES datasets(id),
  question       text NOT NULL,
  expected_twist text,
  format         text NOT NULL,
  hook_hint      text,
  trend_link     text,
  scores         jsonb,
  priority       numeric NOT NULL DEFAULT 0,
  fail_count     int NOT NULL DEFAULT 0,
  angle_hash     text NOT NULL,
  embedding      vector(768),
  source         text NOT NULL DEFAULT 'discover',   -- launch | discover | followup
  concept_key    text,
  status         text NOT NULL DEFAULT 'idea',       -- idea | producing | done | failed | skipped
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, angle_hash)
);
CREATE INDEX IF NOT EXISTS topics_status_priority ON topics (status, priority DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id                  bigserial PRIMARY KEY,
  topic_id            bigint REFERENCES topics(id),
  status              text NOT NULL DEFAULT 'producing',
  format              text NOT NULL,
  voice               text,
  length_band         text,
  hook_type           text,
  facts               jsonb,
  script              jsonb,
  hooks               jsonb,
  packaging           jsonb,
  critic              jsonb,
  chosen_hook         int,
  video_path          text,
  render              jsonb,
  qa                  jsonb,
  attempts            int NOT NULL DEFAULT 0,
  error               text,
  telegram_message_id bigint,
  slot_at             timestamptz,
  series_no           int,
  youtube_video_id    text UNIQUE,
  youtube_url         text,
  published_at        timestamptz,
  ig_due_at           timestamptz,
  ig_status           text,
  ig_media_id         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);
-- Map Reveal opening test (from 2 Nov 2026): rank_strip | classic; null for other formats.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS opening text;

CREATE TABLE IF NOT EXISTS metrics (
  job_id         bigint NOT NULL REFERENCES jobs(id),
  win            text NOT NULL,              -- 24h | 72h | 7d
  captured_at    timestamptz NOT NULL DEFAULT now(),
  views          bigint,
  engaged_views  bigint,
  avg_view_pct   numeric,
  avg_view_sec   numeric,
  likes          bigint,
  shares         bigint,
  comments       bigint,
  subs_gained    bigint,
  raw            jsonb,
  PRIMARY KEY (job_id, win)
);
-- Retention curve, the Instagram Reel's insights and the scorecard verdict for each snapshot.
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS curve jsonb;  -- [[elapsed ratio, audience watch ratio], ...]
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS ig jsonb;     -- {views, reach, likes, saved, shares, avg_watch_sec, skip_rate, error}
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS score jsonb;  -- what scorecard.ts decided

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Viewer comments already sent to Telegram with a draft reply (comments.ts). Rows are deleted
-- 31 days after the comment was written (privacy.md).
CREATE TABLE IF NOT EXISTS comments (
  platform     text NOT NULL,              -- youtube | instagram
  id           text NOT NULL,
  video_id     text NOT NULL,
  job_id       bigint REFERENCES jobs(id),
  author       text,
  text         text,
  published_at timestamptz NOT NULL,
  kind         text,                       -- question | correction | critical | praise | spam | other
  action       text,
  reply        text,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, id)
);

-- The weekly long-form video (worker/src/longform). One row per video; `n` is its number.
CREATE TABLE IF NOT EXISTS longforms (
  n            serial PRIMARY KEY,
  theme        text NOT NULL,
  status       text NOT NULL DEFAULT 'making',   -- making | ready | approved | uploading | rejected | failed | published
  datasets     text[],
  packaging    jsonb,                            -- title, title_options, description, tags, pinned_comment
  chapters     jsonb,                            -- [{at: seconds, label}]
  related      jsonb,                            -- Shorts whose "Related video" should point here
  seconds      numeric,
  video_path   text,
  thumb_path   text,
  public_files jsonb,                            -- {video, thumb}: names under MEDIA_DIR/longform
  error        text,
  youtube_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE longforms ADD COLUMN IF NOT EXISTS upload_tries int NOT NULL DEFAULT 0;  -- times sent to WF3
ALTER TABLE longforms ADD COLUMN IF NOT EXISTS publish_at timestamptz;              -- the slot it goes public
ALTER TABLE longforms ADD COLUMN IF NOT EXISTS related_sent boolean NOT NULL DEFAULT false;  -- Related video list sent

-- Per Capita Nation (worker/src/nation): viewers join on the passport page and become numbered
-- citizens; a daily census Short shows the nation's size and ranks. Only the name a viewer types
-- and the country they pick are stored (privacy.md). Leaving deletes the row; numbers are not reused.
CREATE TABLE IF NOT EXISTS nation_citizens (
  no         serial PRIMARY KEY,                -- the citizen number on the passport
  name       text NOT NULL,
  iso3       text NOT NULL,
  code       text NOT NULL UNIQUE,              -- secret kept in the viewer's browser: show or leave
  ip_hash    text,                              -- salted hash, only to limit sign-ups; cleared after 2 days
  joined_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nation_citizens_iso ON nation_citizens (iso3);

-- Votes on the page's open question (nation/census.ts, VOTES: one question at a time, in order).
-- One vote per address per question; the rows go once the question is decided.
CREATE TABLE IF NOT EXISTS nation_votes (
  topic    text NOT NULL,                     -- the question's key: flag, capital, ...
  voter    text NOT NULL,                     -- salted hash of the address
  choice   int NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, voter)
);

-- One row per daily episode: the census it shows and the Short (a jobs row with format NATION).
CREATE TABLE IF NOT EXISTS nation_days (
  day        int PRIMARY KEY,
  census_at  timestamptz NOT NULL,
  census     jsonb NOT NULL,
  slot_at    timestamptz NOT NULL,
  job_id     bigint REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
