# Telemetry — Async DB Storage Design

## The Core Problem with Vanilla OpenTelemetry

OpenTelemetry captures **spans** — structured records of operations. Each span has well-defined fields, but **it does NOT capture request/response bodies by default**. It only captures semantic HTTP attributes (method, URL, status code, duration). Payload bodies must be added manually as span attributes.

Additionally, OTel's default export flow is:

```
App → BatchSpanProcessor → OTLP Exporter → External Collector (Jaeger/Tempo)
```

To write into your own PostgreSQL, you need a **Custom SpanExporter** — a class that receives the batched spans and does the INSERT.

---

## What a Raw OTel Span Contains

When `auto-instrumentations-node` fires, each HTTP operation produces a span with this structure:

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "parentSpanId": "b7ad6b7169203331",
  "name": "POST /mobility/search",
  "kind": 2,
  "startTimeUnixNano": "1749470625123000000",
  "endTimeUnixNano":   "1749470625465000000",
  "attributes": {
    "http.method": "POST",
    "http.url": "http://localhost:3000/mobility/search",
    "http.route": "/mobility/search",
    "http.status_code": 200,
    "http.flavor": "1.1",
    "net.host.port": 3000,
    "net.peer.ip": "127.0.0.1"
  },
  "status": { "code": 1 },
  "resource": {
    "service.name": "vistaar-provider-backend",
    "telemetry.sdk.version": "1.x.x"
  }
}
```

And for each **outbound Axios call** (child span):

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "b7ad6b7169203331",
  "parentSpanId": "00f067aa0ba902b7",
  "name": "HTTP POST",
  "kind": 3,
  "startTimeUnixNano": "1749470625201000000",
  "endTimeUnixNano":   "1749470625319000000",
  "attributes": {
    "http.method": "POST",
    "http.url": "https://hasura.tekdinext.com/v1/graphql",
    "http.status_code": 200,
    "net.peer.name": "hasura.tekdinext.com",
    "net.peer.port": 443
  },
  "status": { "code": 1 }
}
```

### What OTel gives you natively
| Field | Captured? |
|---|---|
| Trace ID (links entire request chain) | Yes — auto |
| Span ID | Yes — auto |
| Parent Span ID | Yes — auto |
| HTTP method, URL, status | Yes — auto |
| Start time, end time, duration | Yes — auto |
| Request body / payload | **No — must add manually** |
| Response body | **No — must add manually** |
| Beckn transaction_id, domain | **No — must add manually** |

---

## Recommended Architecture: Interceptor-Driven + Custom Async DB Writer

Since you need full payloads, the cleanest design is:

```
Inbound Request
      │
      ▼
LoggingInterceptor (NestJS)     ← captures req body, context fields
      │
      │ fires EventEmitter event (non-blocking, async)
      ▼
TelemetryEventService           ← listens, builds DB row
      │
      │ pool.query INSERT (async, fire-and-forget)
      ▼
PostgreSQL telemetry_logs table

      │ (separately)
Axios global interceptors       ← captures outbound url, payload, response
      │
      │ fires EventEmitter event
      ▼
TelemetryEventService → PostgreSQL
```

The API response is sent **before** the DB write completes. The EventEmitter is synchronous (the emit call returns immediately), and the actual INSERT runs in the background. Zero added latency to the user.

---

## PostgreSQL Schema

Run this migration on your DB:

```sql
-- Migration: create telemetry schema
CREATE TABLE IF NOT EXISTS telemetry_logs (
  id                    BIGSERIAL PRIMARY KEY,

  -- Trace correlation (links all rows from a single inbound request)
  trace_id              VARCHAR(64)   NOT NULL,
  span_id               VARCHAR(32),
  parent_span_id        VARCHAR(32),

  -- What kind of event this row represents
  event_type            VARCHAR(50)   NOT NULL,
  -- Values: 'inbound_request' | 'inbound_response'
  --         | 'outbound_request' | 'outbound_response' | 'outbound_error'

  -- HTTP details
  http_method           VARCHAR(10),
  endpoint              TEXT,         -- '/mobility/search' for inbound; full URL for outbound
  http_status_code      SMALLINT,

  -- Timing
  event_timestamp       TIMESTAMPTZ   NOT NULL,
  duration_ms           INTEGER,      -- populated on *_response rows

  -- Payloads (JSONB for queryability)
  request_payload       JSONB,        -- full sanitised request body
  response_payload      JSONB,        -- full response body

  -- Beckn protocol fields (extracted from context for fast querying)
  beckn_transaction_id  VARCHAR(255),
  beckn_message_id      VARCHAR(255),
  beckn_domain          VARCHAR(100),
  beckn_action          VARCHAR(50),  -- 'search', 'init', 'on_search', etc.
  beckn_bap_id          VARCHAR(255),

  -- Error info
  error_message         TEXT,
  error_stack           TEXT,

  -- Meta
  service_name          VARCHAR(100)  DEFAULT 'vistaar-provider-backend',
  created_at            TIMESTAMPTZ   DEFAULT NOW()
);

-- Indexes for the common query patterns
CREATE INDEX idx_telemetry_trace_id        ON telemetry_logs (trace_id);
CREATE INDEX idx_telemetry_timestamp       ON telemetry_logs (event_timestamp DESC);
CREATE INDEX idx_telemetry_transaction_id  ON telemetry_logs (beckn_transaction_id);
CREATE INDEX idx_telemetry_domain_action   ON telemetry_logs (beckn_domain, beckn_action);
CREATE INDEX idx_telemetry_event_type      ON telemetry_logs (event_type);
```

---

## What Each Row Looks Like

### Row 1 — Inbound request hits `/mobility/search`
```json
{
  "trace_id":             "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":              "00f067aa0ba902b7",
  "parent_span_id":       null,
  "event_type":           "inbound_request",
  "http_method":          "POST",
  "endpoint":             "/mobility/search",
  "http_status_code":     null,
  "event_timestamp":      "2026-06-09T10:23:45.123Z",
  "duration_ms":          null,
  "request_payload": {
    "context": {
      "domain": "agri-schemes",
      "transaction_id": "txn-abc-123",
      "message_id": "msg-xyz-456",
      "bap_id": "beckn-bap.example.org",
      "action": "search"
    },
    "message": {
      "intent": {
        "category": { "descriptor": { "code": "schemes-agri" } },
        "item": { "descriptor": { "name": "pm-kisan" } }
      }
    }
  },
  "response_payload":     null,
  "beckn_transaction_id": "txn-abc-123",
  "beckn_message_id":     "msg-xyz-456",
  "beckn_domain":         "agri-schemes",
  "beckn_action":         "search",
  "beckn_bap_id":         "beckn-bap.example.org"
}
```

### Row 2 — Outbound call to Hasura (triggered by same request)
```json
{
  "trace_id":             "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":              "b7ad6b7169203331",
  "parent_span_id":       "00f067aa0ba902b7",
  "event_type":           "outbound_request",
  "http_method":          "POST",
  "endpoint":             "https://hasura.tekdinext.com/v1/graphql",
  "http_status_code":     null,
  "event_timestamp":      "2026-06-09T10:23:45.201Z",
  "duration_ms":          null,
  "request_payload": {
    "query": "query { Content(where: { scheme_id: { _ilike: \"pm-kisan\" } }) { id title ... } }",
    "variables": {}
  },
  "response_payload":     null,
  "beckn_transaction_id": "txn-abc-123",
  "beckn_domain":         "agri-schemes",
  "beckn_action":         "search"
}
```

### Row 3 — Hasura response received
```json
{
  "trace_id":             "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":              "b7ad6b7169203331",
  "parent_span_id":       "00f067aa0ba902b7",
  "event_type":           "outbound_response",
  "http_method":          "POST",
  "endpoint":             "https://hasura.tekdinext.com/v1/graphql",
  "http_status_code":     200,
  "event_timestamp":      "2026-06-09T10:23:45.319Z",
  "duration_ms":          118,
  "request_payload":      null,
  "response_payload": {
    "data": {
      "Content": [
        { "id": "c1", "title": "PM Kisan Scheme", "scheme_id": "pm-kisan", ... }
      ]
    }
  },
  "beckn_transaction_id": "txn-abc-123"
}
```

### Row 4 — Final response sent back to BAP
```json
{
  "trace_id":             "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":              "00f067aa0ba902b7",
  "parent_span_id":       null,
  "event_type":           "inbound_response",
  "http_method":          "POST",
  "endpoint":             "/mobility/search",
  "http_status_code":     200,
  "event_timestamp":      "2026-06-09T10:23:45.465Z",
  "duration_ms":          342,
  "request_payload":      null,
  "response_payload": {
    "context": { "action": "on_search", "domain": "agri-schemes", "transaction_id": "txn-abc-123" },
    "message": {
      "catalog": {
        "providers": [ { "id": "...", "items": [ ... ] } ]
      }
    }
  },
  "beckn_transaction_id": "txn-abc-123",
  "beckn_action":         "on_search"
}
```

Querying a full request trace:
```sql
SELECT event_type, endpoint, http_status_code, duration_ms, event_timestamp
FROM telemetry_logs
WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736'
ORDER BY event_timestamp ASC;
```

---

## Implementation Code

### Step 1 — TelemetryService (the async DB writer)

```ts
// src/services/telemetry/telemetry.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { EventEmitter } from 'events';

export const telemetryEmitter = new EventEmitter();
telemetryEmitter.setMaxListeners(50);

interface TelemetryEvent {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  eventType: 'inbound_request' | 'inbound_response' | 'outbound_request' | 'outbound_response' | 'outbound_error';
  httpMethod?: string;
  endpoint?: string;
  httpStatusCode?: number;
  eventTimestamp: Date;
  durationMs?: number;
  requestPayload?: object;
  responsePayload?: object;
  beckn?: {
    transactionId?: string;
    messageId?: string;
    domain?: string;
    action?: string;
    bapId?: string;
  };
  errorMessage?: string;
  errorStack?: string;
}

@Injectable()
export class TelemetryService implements OnModuleInit {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host:     process.env.TELEMETRY_DB_HOST     || process.env.IMD_DB_HOST,
      port:     parseInt(process.env.TELEMETRY_DB_PORT || process.env.IMD_DB_PORT || '5432'),
      database: process.env.TELEMETRY_DB_NAME     || process.env.IMD_DB_NAME,
      user:     process.env.TELEMETRY_DB_USER     || process.env.IMD_DB_USER,
      password: process.env.TELEMETRY_DB_PASSWORD || process.env.IMD_DB_PASSWORD,
      max: 5,  // small pool — telemetry is low-priority
      idleTimeoutMillis: 30000,
    });
  }

  onModuleInit() {
    telemetryEmitter.on('telemetry', (event: TelemetryEvent) => {
      // fire-and-forget — never awaited, never blocks request handling
      this.persist(event).catch((err) =>
        console.error('[Telemetry] DB write failed:', err.message),
      );
    });
  }

  private async persist(e: TelemetryEvent) {
    const sanitized = this.sanitize(e.requestPayload ?? e.responsePayload);
    await this.pool.query(
      `INSERT INTO telemetry_logs (
        trace_id, span_id, parent_span_id, event_type,
        http_method, endpoint, http_status_code,
        event_timestamp, duration_ms,
        request_payload, response_payload,
        beckn_transaction_id, beckn_message_id, beckn_domain, beckn_action, beckn_bap_id,
        error_message, error_stack
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
      )`,
      [
        e.traceId, e.spanId ?? null, e.parentSpanId ?? null, e.eventType,
        e.httpMethod ?? null, e.endpoint ?? null, e.httpStatusCode ?? null,
        e.eventTimestamp, e.durationMs ?? null,
        e.requestPayload  ? JSON.stringify(this.sanitize(e.requestPayload))  : null,
        e.responsePayload ? JSON.stringify(e.responsePayload) : null,
        e.beckn?.transactionId ?? null,
        e.beckn?.messageId     ?? null,
        e.beckn?.domain        ?? null,
        e.beckn?.action        ?? null,
        e.beckn?.bapId         ?? null,
        e.errorMessage ?? null,
        e.errorStack   ?? null,
      ],
    );
  }

  // Strip sensitive keys before persisting
  private sanitize(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    const BLOCKED = new Set([
      'Token', 'token', 'EncryptedRequest', 'encryptedRequest',
      'x-hasura-admin-secret', 'Authorization', 'authorization',
      'password', 'secret', 'otp', 'OTP',
    ]);
    const clean = (o: any): any => {
      if (Array.isArray(o)) return o.map(clean);
      if (typeof o !== 'object' || o === null) return o;
      return Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => !BLOCKED.has(k))
          .map(([k, v]) => [k, clean(v)]),
      );
    };
    return clean(obj);
  }
}
```

---

### Step 2 — Logging Interceptor (emits events, never awaits DB)

```ts
// src/interceptors/logging.interceptor.ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { telemetryEmitter } from 'src/services/telemetry/telemetry.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const traceId: string = req.traceId ?? uuidv4().replace(/-/g, '');
    req.traceId = traceId;

    const body = req.body ?? {};
    const beckn = {
      transactionId: body?.context?.transaction_id,
      messageId:     body?.context?.message_id,
      domain:        body?.context?.domain,
      action:        body?.context?.action,
      bapId:         body?.context?.bap_id,
    };

    // Emit inbound request — async, does not block
    telemetryEmitter.emit('telemetry', {
      traceId,
      spanId: uuidv4().replace(/-/g, '').substring(0, 16),
      eventType: 'inbound_request',
      httpMethod: req.method,
      endpoint: req.url,
      eventTimestamp: new Date(),
      requestPayload: body,
      beckn,
    });

    const start = Date.now();
    return next.handle().pipe(
      tap((responseBody) => {
        telemetryEmitter.emit('telemetry', {
          traceId,
          eventType: 'inbound_response',
          httpMethod: req.method,
          endpoint: req.url,
          httpStatusCode: 200,
          eventTimestamp: new Date(),
          durationMs: Date.now() - start,
          responsePayload: responseBody,
          beckn: {
            ...beckn,
            action: responseBody?.context?.action ?? beckn.action,
          },
        });
      }),
    );
  }
}
```

---

### Step 3 — Global Axios Interceptor (register in `main.ts`)

```ts
// inside bootstrap(), after app creation
import axios from 'axios';
import { telemetryEmitter } from './services/telemetry/telemetry.service';
import { v4 as uuidv4 } from 'uuid';

axios.interceptors.request.use((config) => {
  const spanId = uuidv4().replace(/-/g, '').substring(0, 16);
  (config as any).__spanId = spanId;
  (config as any).__startMs = Date.now();
  // traceId comes from AsyncLocalStorage or falls back to a new ID
  const traceId = (config as any).__traceId ?? uuidv4().replace(/-/g, '');

  telemetryEmitter.emit('telemetry', {
    traceId,
    spanId,
    eventType: 'outbound_request',
    httpMethod: config.method?.toUpperCase(),
    endpoint: config.url,
    eventTimestamp: new Date(),
    requestPayload: config.data
      ? (typeof config.data === 'string' ? JSON.parse(config.data) : config.data)
      : undefined,
  });
  return config;
});

axios.interceptors.response.use(
  (response) => {
    telemetryEmitter.emit('telemetry', {
      traceId: (response.config as any).__traceId ?? 'unknown',
      spanId:  (response.config as any).__spanId,
      eventType: 'outbound_response',
      httpMethod: response.config.method?.toUpperCase(),
      endpoint: response.config.url,
      httpStatusCode: response.status,
      eventTimestamp: new Date(),
      durationMs: Date.now() - ((response.config as any).__startMs ?? Date.now()),
      responsePayload: response.data,
    });
    return response;
  },
  (error) => {
    telemetryEmitter.emit('telemetry', {
      traceId: (error.config as any)?.__traceId ?? 'unknown',
      spanId:  (error.config as any)?.__spanId,
      eventType: 'outbound_error',
      httpMethod: error.config?.method?.toUpperCase(),
      endpoint: error.config?.url,
      httpStatusCode: error.response?.status,
      eventTimestamp: new Date(),
      durationMs: Date.now() - ((error.config as any)?.__startMs ?? Date.now()),
      responsePayload: error.response?.data,
      errorMessage: error.message,
    });
    return Promise.reject(error);
  },
);
```

---

## Trace Propagation (linking outbound Axios calls to the inbound trace)

The tricky part is passing the `traceId` from the inbound request into the Axios calls (which happen inside services, not the interceptor). The cleanest Node.js solution is `AsyncLocalStorage`:

```ts
// src/services/telemetry/trace-context.ts
import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContext {
  traceId: string;
  spanId: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();
```

In `LoggingInterceptor`, wrap the handler call:
```ts
return new Observable((subscriber) => {
  traceStorage.run({ traceId, spanId }, () => {
    next.handle().pipe(tap(...)).subscribe(subscriber);
  });
});
```

In the Axios request interceptor, read it:
```ts
const ctx = traceStorage.getStore();
const traceId = ctx?.traceId ?? uuidv4().replace(/-/g, '');
(config as any).__traceId = traceId;
(config as any).__parentSpanId = ctx?.spanId;
```

This ensures every outbound Hasura/PM Kisan call has the same `trace_id` as the inbound request, so you can reconstruct the full flow from a single SQL query.

---

## Querying Your Data

### Full flow for one request
```sql
SELECT event_type, endpoint, http_status_code, duration_ms, event_timestamp,
       request_payload, response_payload
FROM telemetry_logs
WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736'
ORDER BY event_timestamp ASC;
```

### All calls made for a Beckn transaction
```sql
SELECT event_type, endpoint, http_status_code, duration_ms
FROM telemetry_logs
WHERE beckn_transaction_id = 'txn-abc-123'
ORDER BY event_timestamp ASC;
```

### Slow outbound calls (> 2 seconds)
```sql
SELECT endpoint, AVG(duration_ms) AS avg_ms, COUNT(*) AS calls
FROM telemetry_logs
WHERE event_type = 'outbound_response' AND duration_ms > 2000
GROUP BY endpoint
ORDER BY avg_ms DESC;
```

### All errors in the last hour
```sql
SELECT event_timestamp, endpoint, http_status_code, error_message, request_payload
FROM telemetry_logs
WHERE event_type = 'outbound_error'
  AND event_timestamp > NOW() - INTERVAL '1 hour'
ORDER BY event_timestamp DESC;
```

### Hasura call payload + response together
```sql
SELECT
  req.event_timestamp  AS requested_at,
  req.request_payload  AS graphql_query_sent,
  res.http_status_code AS hasura_status,
  res.duration_ms      AS hasura_duration_ms,
  res.response_payload AS hasura_response
FROM telemetry_logs req
JOIN telemetry_logs res
  ON req.trace_id = res.trace_id
  AND req.span_id  = res.span_id
  AND req.event_type = 'outbound_request'
  AND res.event_type = 'outbound_response'
WHERE req.endpoint LIKE '%hasura%'
ORDER BY req.event_timestamp DESC
LIMIT 20;
```

---

## Summary — What Gets Stored vs What Doesn't

| Data point | Stored | Where |
|---|---|---|
| Inbound Beckn payload (full) | Yes | `request_payload` JSONB |
| Outbound API payload (full) | Yes | `request_payload` JSONB |
| Hasura GraphQL query + variables | Yes | `request_payload` JSONB |
| Hasura response data | Yes | `response_payload` JSONB |
| External API response | Yes | `response_payload` JSONB |
| Final on_search / on_status response | Yes | `response_payload` JSONB |
| Timing for every leg | Yes | `duration_ms` |
| Trace linking all legs | Yes | `trace_id` (same for all rows in one request) |
| PM Kisan Token / admin secret | Never — sanitized out | — |
| OTP values | Never — sanitized out | — |

---

## Environment Variables to Add

```env
# Telemetry DB — can reuse existing DB or point to a separate one
TELEMETRY_DB_HOST=your-postgres-host
TELEMETRY_DB_PORT=5432
TELEMETRY_DB_NAME=vistaar_telemetry
TELEMETRY_DB_USER=telemetry_user
TELEMETRY_DB_PASSWORD=telemetry_password
```
