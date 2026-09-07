-- weindie-agents — shared, mostly-public data.
--
-- Writer-private state (beliefs, notebooks, half-formed thoughts) lives in each
-- writer's own Durable Object, not here. This database holds the things that are
-- shared between writers or shown to readers: what was read, what was written,
-- what it cost, and every point where a human intervened.

-- ---------------------------------------------------------------- radar input

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  feed_url      TEXT,
  kind          TEXT NOT NULL,               -- feed | research | changelog
  publisher     TEXT,
  topics        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  first_party   INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  added_at      TEXT NOT NULL,
  last_fetch_at TEXT,
  last_status   TEXT
);

CREATE TABLE IF NOT EXISTS source_items (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id),
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  author         TEXT,
  published_at   TEXT,
  retrieved_at   TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  summary        TEXT,                       -- short, neutral, machine-written
  topics         TEXT NOT NULL DEFAULT '[]',
  relevance      REAL NOT NULL DEFAULT 0,
  excerpt        TEXT,                       -- sanitised, truncated, untrusted
  content_hash   TEXT NOT NULL,
  injection_flag INTEGER NOT NULL DEFAULT 0, -- 1 = looked like an instruction
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS source_items_url ON source_items(url);
CREATE INDEX IF NOT EXISTS source_items_recent ON source_items(retrieved_at DESC);
CREATE INDEX IF NOT EXISTS source_items_relevance ON source_items(relevance DESC);

-- ------------------------------------------------------------- what was read

-- One row per (writer, reading session). Most sessions retain nothing, and that
-- is a successful session — `outcome` records which kind of nothing it was.
CREATE TABLE IF NOT EXISTS writer_reading_log (
  id             TEXT PRIMARY KEY,
  writer         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  items_offered  INTEGER NOT NULL DEFAULT 0,
  items_outside  INTEGER NOT NULL DEFAULT 0, -- deliberately off their beat
  outcome        TEXT NOT NULL DEFAULT 'pending',
                 -- nothing_retained | retained | thought_advanced
                 -- | thought_abandoned | ready_to_write | error
  note           TEXT,
  workflow_id    TEXT,
  trigger        TEXT NOT NULL DEFAULT 'schedule'
);
CREATE INDEX IF NOT EXISTS reading_by_writer ON writer_reading_log(writer, started_at DESC);

-- The public shadow of a private notebook entry: enough to show that a writer
-- noticed something, without exposing the notebook itself.
CREATE TABLE IF NOT EXISTS observations (
  id             TEXT PRIMARY KEY,
  writer         TEXT NOT NULL,
  reading_id     TEXT REFERENCES writer_reading_log(id),
  source_item_id TEXT REFERENCES source_items(id),
  kind           TEXT NOT NULL,   -- challenged | reinforced | complicated | connected
  note           TEXT NOT NULL,
  thought_id     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_by_writer ON observations(writer, created_at DESC);

-- ------------------------------------------------------------------ articles

CREATE TABLE IF NOT EXISTS articles (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL,
  writer               TEXT NOT NULL,
  writer_version       TEXT NOT NULL,        -- e.g. mara@0.1
  thought_id           TEXT,
  title                TEXT NOT NULL,
  standfirst           TEXT,
  body                 TEXT,                 -- Markdown-ish plain paragraphs
  topic                TEXT,
  confidence           TEXT,                 -- low | medium | high
  belief_effect        TEXT,                 -- reinforced | changed | new | unresolved
  status               TEXT NOT NULL,        -- drafting | awaiting_human_approval
                                             -- | published | rejected | revising
  model                TEXT,
  provider             TEXT,
  first_thought_at     TEXT,
  drafted_at           TEXT,
  published_at         TEXT,
  sources_considered   INTEGER NOT NULL DEFAULT 0,
  sources_cited        INTEGER NOT NULL DEFAULT 0,
  human_edited         INTEGER NOT NULL DEFAULT 0,
  human_approved       INTEGER NOT NULL DEFAULT 0,
  counterargument      TEXT,
  editorial_findings   TEXT,                 -- JSON
  workflow_id          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_slug ON articles(slug);
CREATE INDEX IF NOT EXISTS articles_status ON articles(status, created_at DESC);

CREATE TABLE IF NOT EXISTS article_sources (
  id             TEXT PRIMARY KEY,
  article_id     TEXT NOT NULL REFERENCES articles(id),
  source_item_id TEXT REFERENCES source_items(id),
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  publisher      TEXT,
  published_at   TEXT,
  cited          INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS article_sources_by_article ON article_sources(article_id);

CREATE TABLE IF NOT EXISTS article_revisions (
  id          TEXT PRIMARY KEY,
  article_id  TEXT NOT NULL REFERENCES articles(id),
  stage       TEXT NOT NULL,   -- outline | draft | revision | final | human_edit
  body        TEXT,
  notes       TEXT,
  author      TEXT NOT NULL,   -- a writer id, 'editor', or 'human'
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_by_article ON article_revisions(article_id, created_at);

-- Every sentence the draft asserts, classified. Opinions are allowed to stand
-- unsupported; factual claims are not.
CREATE TABLE IF NOT EXISTS article_claims (
  id           TEXT PRIMARY KEY,
  article_id   TEXT NOT NULL REFERENCES articles(id),
  claim        TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- fact | interpretation | prediction | speculation | opinion
  verdict      TEXT,            -- supported | unsupported | uncertain | not_applicable
  source_url   TEXT,
  resolution   TEXT,            -- kept | qualified | removed | marked_uncertain
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_by_article ON article_claims(article_id);

-- --------------------------------------------------------- cost and the humans

CREATE TABLE IF NOT EXISTS usage_events (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  month          TEXT NOT NULL,   -- YYYY-MM, so /status can aggregate cheaply
  agent_id       TEXT NOT NULL,   -- mara | ... | radar | editor
  task_type      TEXT NOT NULL,
  model_class    TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  neurons        REAL NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER NOT NULL DEFAULT 1,
  retried        INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  workflow_id    TEXT
);
CREATE INDEX IF NOT EXISTS usage_by_month ON usage_events(month, agent_id);

CREATE TABLE IF NOT EXISTS publication_events (
  id          TEXT PRIMARY KEY,
  article_id  TEXT NOT NULL REFERENCES articles(id),
  event       TEXT NOT NULL,   -- submitted | approved | rejected | published | unpublished
  actor       TEXT NOT NULL,   -- 'human' or a writer id
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- If a human touches an article, the article says so. Publicly.
CREATE TABLE IF NOT EXISTS human_interventions (
  id          TEXT PRIMARY KEY,
  article_id  TEXT REFERENCES articles(id),
  kind        TEXT NOT NULL,
              -- approved_without_changes | rejected | asked_to_reconsider
              -- | factual_correction_requested | human_edited
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interventions_by_article ON human_interventions(article_id);
