-- Mandi v2: commodity master cache for string → commodity_id resolution
-- Run against the same Postgres DB used by IMD_DB_* (weather_service)

CREATE TABLE IF NOT EXISTS commodities (
    commodity_id   INT PRIMARY KEY,
    commodity_name VARCHAR(255) NOT NULL,
    group_name     VARCHAR(100),
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commodities_name_lower
    ON commodities (LOWER(commodity_name));

CREATE TABLE IF NOT EXISTS commodity_terms (
    id            SERIAL PRIMARY KEY,
    commodity_id  INT NOT NULL REFERENCES commodities(commodity_id) ON DELETE CASCADE,
    term          VARCHAR(255) NOT NULL,
    lang          VARCHAR(5) DEFAULT 'en'
);

CREATE INDEX IF NOT EXISTS idx_commodity_terms_term_lower
    ON commodity_terms (LOWER(term));

CREATE TABLE IF NOT EXISTS cache_sync_log (
    id         SERIAL PRIMARY KEY,
    source     VARCHAR(50) NOT NULL,
    row_count  INT,
    status     VARCHAR(20),
    synced_at  TIMESTAMPTZ DEFAULT NOW()
);