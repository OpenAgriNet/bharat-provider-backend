// Tables for the KHC master-data cache. Created at startup (CREATE ... IF NOT EXISTS) in
// the database the provider already uses, the same way the mandi commodity cache does.
//
// Every KHC reference list has the same shape: rows belong to a parent id and keep
//   id / name as returned by KHC, a normalized name for matching, the raw API row
//   (jsonb, so responses stay identical) and the API order (pos).
// Parents: districts <- state, sub-districts <- district, villages <- sub-district,
//          schemes <- state, categories <- scheme, sub-categories <- category.
// States have no parent (parent_id = 0). No foreign keys: lists are cached lazily and may
// arrive before their parent rows. Rows are never deleted; a missing row is is_active = FALSE.
const list = (table: string, parent: string, extra = "") => `
  CREATE TABLE IF NOT EXISTS ${table} (
    parent_id  BIGINT      NOT NULL${parent},${extra}
    id         BIGINT      NOT NULL,
    name       TEXT        NOT NULL,
    name_norm  TEXT        NOT NULL,
    raw        JSONB       NOT NULL,
    pos        INT         NOT NULL DEFAULT 0,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (parent_id, id)
  );`;

export const KHC_MASTER_DDL = `
  ${list("khc_state", " DEFAULT 0")}
  ${list("khc_district", "")}
  CREATE INDEX IF NOT EXISTS idx_khc_district_id ON khc_district (id);
  ${list("khc_sub_district", "", "\n    state_id   BIGINT,")}
  CREATE INDEX IF NOT EXISTS idx_khc_sub_district_id ON khc_sub_district (id);
  CREATE INDEX IF NOT EXISTS idx_khc_sub_district_state_name
    ON khc_sub_district (state_id, name_norm text_pattern_ops);
  ${list("khc_village", "", "\n    state_id    BIGINT,\n    district_id BIGINT,")}
  CREATE INDEX IF NOT EXISTS idx_khc_village_id ON khc_village (id);
  CREATE INDEX IF NOT EXISTS idx_khc_village_name ON khc_village (name_norm text_pattern_ops);
  CREATE INDEX IF NOT EXISTS idx_khc_village_state_name
    ON khc_village (state_id, name_norm text_pattern_ops);
  ${list("khc_scheme", "")}
  ${list("khc_category", "")}
  ${list("khc_sub_category", "")}
  CREATE TABLE IF NOT EXISTS khc_sync_state (
    kind            TEXT        NOT NULL,
    parent_id       BIGINT      NOT NULL DEFAULT 0,
    row_count       INT         NOT NULL DEFAULT 0,
    last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, parent_id)
  );
`;
