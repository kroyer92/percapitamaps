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
