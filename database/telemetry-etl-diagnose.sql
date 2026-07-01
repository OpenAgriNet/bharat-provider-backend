-- Run this alone if ETL still fails — shows the FIRST real error cause.
ROLLBACK;

SELECT 'winston_logs exists' AS check_name,
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'winston_logs') AS ok;

SELECT 'provider_telemetry_events exists' AS check_name,
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'provider_telemetry_events') AS ok;

SELECT 'direction column removed' AS check_name,
       NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'provider_telemetry_events' AND column_name = 'direction'
       ) AS ok;

SELECT COUNT(*) AS telemetry_log_rows
FROM winston_logs
WHERE message IS NOT NULL
  AND left(btrim(message), 1) = '{'
  AND message LIKE '%ekstep.telemetry%';

SELECT id, timestamp, (message::json)->>'id' AS batch_id,
       json_array_length((message::json)->'events') AS event_count
FROM winston_logs
WHERE message IS NOT NULL
  AND left(btrim(message), 1) = '{'
  AND (message::json)->>'id' = 'ekstep.telemetry'
ORDER BY timestamp DESC
LIMIT 5;

SELECT * FROM telemetry_etl_state;