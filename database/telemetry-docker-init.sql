-- =============================================================================
-- Local telemetry DB bootstrap (run after Docker Postgres is up)
-- Database: vistaar_telemetry
-- =============================================================================

-- RAW layer (written by observability / telemetry-service)
CREATE TABLE IF NOT EXISTS winston_logs (
    level       VARCHAR,
    message     VARCHAR,
    meta        JSON,
    timestamp   TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_winston_logs_timestamp
    ON winston_logs (timestamp DESC);

-- ETL watermark
CREATE TABLE IF NOT EXISTS telemetry_etl_state (
    id                SMALLINT PRIMARY KEY DEFAULT 1,
    last_processed_at TIMESTAMPTZ,
    last_run_at       TIMESTAMPTZ,
    rows_inserted     BIGINT DEFAULT 0,
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO telemetry_etl_state (id, last_processed_at)
VALUES (1, '1970-01-01'::TIMESTAMPTZ)
ON CONFLICT (id) DO NOTHING;