-- KHC master data tables (same SQL the provider runs at startup; safe to run twice).
CREATE TABLE IF NOT EXISTS khc_state (
  parent_id  BIGINT      NOT NULL DEFAULT 0,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE TABLE IF NOT EXISTS khc_district (
  parent_id  BIGINT      NOT NULL,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE INDEX IF NOT EXISTS idx_khc_district_id ON khc_district (id);
CREATE TABLE IF NOT EXISTS khc_sub_district (
  parent_id  BIGINT      NOT NULL,
  state_id   BIGINT,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE INDEX IF NOT EXISTS idx_khc_sub_district_id ON khc_sub_district (id);
CREATE INDEX IF NOT EXISTS idx_khc_sub_district_state_name
  ON khc_sub_district (state_id, name_norm text_pattern_ops);
CREATE TABLE IF NOT EXISTS khc_village (
  parent_id  BIGINT      NOT NULL,
  state_id    BIGINT,
  district_id BIGINT,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE INDEX IF NOT EXISTS idx_khc_village_id ON khc_village (id);
CREATE INDEX IF NOT EXISTS idx_khc_village_name ON khc_village (name_norm text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_khc_village_state_name
  ON khc_village (state_id, name_norm text_pattern_ops);
CREATE TABLE IF NOT EXISTS khc_scheme (
  parent_id  BIGINT      NOT NULL,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE TABLE IF NOT EXISTS khc_category (
  parent_id  BIGINT      NOT NULL,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE TABLE IF NOT EXISTS khc_sub_category (
  parent_id  BIGINT      NOT NULL,
  id         BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  name_norm  TEXT        NOT NULL,
  raw        JSONB       NOT NULL,
  pos        INT         NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, id)
);
CREATE TABLE IF NOT EXISTS khc_sync_job (
  name         TEXT        PRIMARY KEY,
  last_run_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       TEXT        NOT NULL,
  details      JSONB
);
CREATE TABLE IF NOT EXISTS khc_sync_state (
  kind            TEXT        NOT NULL,
  parent_id       BIGINT      NOT NULL DEFAULT 0,
  row_count       INT         NOT NULL DEFAULT 0,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, parent_id)
);
