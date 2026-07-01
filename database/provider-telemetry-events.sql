-- =============================================================================
-- provider_telemetry_events — flat telemetry table (all use cases)
-- =============================================================================
--
-- Pipeline:
--   winston_logs (raw, observability service) → ETL job → this table → dashboards
--
-- Correlation:
--   session_id   — chat session
--   question_id  — one user question / one request lifecycle
--
-- Put queries, Beckn bodies, host, route, GraphQL in request_payload / response_payload.
--
-- =============================================================================

BEGIN;

DROP VIEW IF EXISTS v_provider_telemetry_timeline;
DROP VIEW IF EXISTS v_provider_telemetry_flows;
DROP TABLE IF EXISTS provider_telemetry_events;

CREATE TABLE provider_telemetry_events (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    session_id              VARCHAR(128) NOT NULL,
    question_id             VARCHAR(128) NOT NULL,
    step_sequence           SMALLINT     NOT NULL,

    service_name            VARCHAR(64)  NOT NULL,
    event_type              VARCHAR(64)  NOT NULL,

    beckn_transaction_id    VARCHAR(128),
    endpoint_url            TEXT,

    http_status             SMALLINT,
    latency_ms              INTEGER,
    success                 BOOLEAN,
    error_message           TEXT,

    request_payload         JSONB,
    response_payload        JSONB,

    event_mid               VARCHAR(128),
    event_timestamp         TIMESTAMPTZ  NOT NULL,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_pte_event_mid UNIQUE (event_mid),
    CONSTRAINT chk_pte_event_type CHECK (
        event_type IN (
            'flow_start', 'beckn_inbound', 'ext_api_call',
            'internal_step', 'beckn_outbound', 'flow_end', 'error'
        )
    )
);

CREATE INDEX idx_pte_session_id       ON provider_telemetry_events (session_id);
CREATE INDEX idx_pte_question_id      ON provider_telemetry_events (question_id, step_sequence);
CREATE INDEX idx_pte_service_time     ON provider_telemetry_events (service_name, event_timestamp DESC);
CREATE INDEX idx_pte_event_type       ON provider_telemetry_events (event_type, event_timestamp DESC);
CREATE INDEX idx_pte_beckn_txn        ON provider_telemetry_events (beckn_transaction_id);
CREATE INDEX idx_pte_endpoint         ON provider_telemetry_events (endpoint_url);
CREATE INDEX idx_pte_errors           ON provider_telemetry_events (event_timestamp DESC) WHERE success = FALSE;
CREATE INDEX idx_pte_request_gin      ON provider_telemetry_events USING GIN (request_payload);
CREATE INDEX idx_pte_response_gin     ON provider_telemetry_events USING GIN (response_payload);

CREATE OR REPLACE VIEW v_provider_telemetry_flows AS
SELECT
    question_id,
    session_id,
    MAX(service_name)                                              AS service_name,
    MAX(request_payload->>'route_name')                            AS route_name,
    MAX(beckn_transaction_id)                                      AS beckn_transaction_id,
    MAX(request_payload->'beckn'->>'domain')                       AS beckn_domain,
    MAX(request_payload->'beckn'->>'action')                       AS beckn_action,
    MIN(event_timestamp) FILTER (WHERE event_type = 'flow_start')  AS flow_started_at,
    MAX(event_timestamp) FILTER (WHERE event_type = 'flow_end')    AS flow_ended_at,
    MAX(latency_ms)      FILTER (WHERE event_type = 'flow_end')    AS duration_ms,
    BOOL_AND(success)    FILTER (WHERE event_type = 'flow_end')    AS success,
    MAX(error_message)   FILTER (WHERE event_type IN ('flow_end', 'error')) AS error_message,
    COUNT(*)                                                       AS total_events,
    COUNT(*) FILTER (WHERE event_type = 'ext_api_call')            AS ext_api_count,
    SUM(latency_ms)  FILTER (WHERE event_type = 'ext_api_call')    AS ext_api_total_ms,
    (jsonb_agg(request_payload)  FILTER (WHERE event_type = 'beckn_inbound'))->0  AS beckn_request,
    (jsonb_agg(response_payload) FILTER (WHERE event_type = 'beckn_inbound'))->0  AS beckn_response,
    jsonb_agg(
        jsonb_build_object(
            'step',       step_sequence,
            'type',       event_type,
            'endpoint',   endpoint_url,
            'host',       request_payload->>'host',
            'service',    request_payload->>'downstream_service',
            'status',     http_status,
            'latency_ms', latency_ms,
            'success',    success
        )
        ORDER BY step_sequence
    ) FILTER (WHERE event_type = 'ext_api_call') AS external_api_calls
FROM provider_telemetry_events
GROUP BY question_id, session_id;

CREATE OR REPLACE VIEW v_provider_telemetry_timeline AS
SELECT
    session_id,
    question_id,
    service_name,
    step_sequence,
    event_type,
    endpoint_url,
    request_payload->>'host'                 AS host,
    request_payload->>'downstream_service'   AS downstream_service,
    request_payload->>'route_name'           AS route_name,
    request_payload->'graphql'->>'query'     AS graphql_query,
    http_status,
    latency_ms,
    success,
    error_message,
    event_timestamp
FROM provider_telemetry_events
ORDER BY event_timestamp DESC, step_sequence ASC;

COMMIT;