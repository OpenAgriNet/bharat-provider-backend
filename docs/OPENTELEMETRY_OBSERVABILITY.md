# OpenTelemetry Observability — Approach Document
## Vistaar Provider Backend

---

## 1. Overview

This document describes how to add distributed tracing to the Vistaar provider backend
using OpenTelemetry, and how to visualise traces in **Jaeger** (standalone) or
**Grafana + Tempo** (if Grafana is already in your stack).

### What this gives you
- Full **waterfall timeline** of every inbound Beckn request (search / init / status / confirm)
- Every **outbound HTTP call** shown as a child span — Hasura GraphQL, PM Kisan,
  PMFBY, Mandi, Weather, GFR, SMAM, SATHI — with URL, status, and duration
- **Beckn context fields** (domain, transaction_id, action) attached to each trace
  so you can search by them in the UI
- Zero changes to any existing service file — auto-instrumentation handles Express
  routes and all axios calls at the Node.js HTTP layer

---

## 2. Architecture

```
                       ┌─────────────────────────────────────────────┐
                       │         NestJS (vistaar-provider-backend)    │
                       │                                              │
  Beckn BAP ──POST──▶  │  Express Route                              │
                       │      │                                       │
                       │      │ [root span created automatically]     │
                       │      ▼                                       │
                       │  AppController / AppService                  │
                       │      │                                       │
                       │      ├──▶ HasuraService ──axios──▶ Hasura   │
                       │      │        [child span auto-created]      │
                       │      │                                       │
                       │      ├──▶ PmfbyService ──axios──▶ PMFBY API │
                       │      │        [child span auto-created]      │
                       │      │                                       │
                       │      └──▶ MandiService ──axios──▶ Mandi API │
                       │               [child span auto-created]      │
                       └───────────────┬─────────────────────────────┘
                                       │
                           BatchSpanProcessor (async, non-blocking)
                           exports every 5 seconds
                                       │
                   ┌───────────────────┴──────────────────┐
                   │                                       │
          OTLP HTTP (port 4318)              OTLP HTTP (port 4318)
                   │                                       │
            ┌──────▼──────┐                    ┌──────────▼──────────┐
            │   Jaeger     │                   │  Grafana Tempo       │
            │ (all-in-one) │                   │  (trace backend)     │
            └──────┬───────┘                   └──────────┬──────────┘
                   │                                       │
            Jaeger UI                            ┌─────────▼──────────┐
          :16686                                 │   Grafana UI        │
                                                 │   (already have)    │
                                                 └────────────────────┘
```

Auto-instrumented layers:
- `@opentelemetry/instrumentation-express` — every route handler → root span
- `@opentelemetry/instrumentation-http` — every axios call → child span
  (axios uses Node's `http`/`https` module underneath; no axios-specific package needed)
- `@opentelemetry/instrumentation-nestjs-core` — NestJS controller/guard context

---

## 3. What Gets Captured Automatically vs Manually

### Auto (zero code change)

| Field | Example value | Source |
|---|---|---|
| Trace ID | `4bf92f3577b34da6a3ce929d0e0e4736` | OTel SDK |
| Span ID | `00f067aa0ba902b7` | OTel SDK |
| Parent span ID | `b7ad6b7169203331` | OTel SDK |
| `http.method` | `POST` | instrumentation-http |
| `http.url` | `/mobility/search` | instrumentation-express |
| `http.target` | `https://hasura.tekdinext.com/v1/graphql` | instrumentation-http |
| `http.status_code` | `200` | instrumentation-http |
| `net.peer.name` | `hasura.tekdinext.com` | instrumentation-http |
| Start time, end time | `2026-06-09T10:23:45.123Z` | OTel SDK |
| Duration | `342 ms` | OTel SDK |
| Span kind | `SERVER` / `CLIENT` | instrumentation-express/http |
| Error flag | `ERROR` if exception thrown | OTel SDK |

### Manually added (Beckn-specific, a few lines of code)

| Field | Example value | Why |
|---|---|---|
| `beckn.transaction_id` | `txn-abc-123` | Search by Beckn transaction in Jaeger/Grafana |
| `beckn.domain` | `agri-schemes` | Filter traces by domain |
| `beckn.action` | `search` | Filter by Beckn action |
| `beckn.bap_id` | `beckn-bap.example.org` | Debug per-BAP issues |
| `outbound.payload_summary` | `scheme_id: pm-kisan` | What was queried |

---

## 4. Package Installation

```bash
npm install \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/api
```

No other changes to `package.json` needed. The auto-instrumentation package
includes express, http, nestjs-core, and ~30 other instrumentations.

---

## 5. Implementation

### 5.1 Create `src/tracing.ts`

This file **must be imported before everything else** in `main.ts`.
It starts the SDK, registers the exporter, and patches Node.js HTTP
so all downstream axios calls are auto-traced.

```ts
// src/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

const exporter = new OTLPTraceExporter({
  // Jaeger:        http://localhost:4318/v1/traces
  // Grafana Tempo: http://localhost:4318/v1/traces  (same port, different backend)
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  headers: {},
});

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'vistaar-provider-backend',
  spanProcessor: new BatchSpanProcessor(exporter, {
    maxQueueSize: 1000,
    scheduledDelayMillis: 5000,   // flush every 5 seconds — non-blocking
    exportTimeoutMillis: 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs instrumentation is very noisy (fires for every file read); disable it
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // dns is low-value; disable to reduce span volume
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

// Graceful shutdown — flush remaining spans before process exits
process.on('SIGTERM', () => sdk.shutdown());
process.on('SIGINT',  () => sdk.shutdown());
```

### 5.2 Update `src/main.ts`

Add **one line** at the very top — before any NestJS import:

```ts
// src/main.ts
import './tracing';                          // ← must be first

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';

config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // ... rest unchanged
}
bootstrap();
```

That is the only code change needed for automatic tracing of all routes and all
outbound HTTP/axios calls.

### 5.3 Add Beckn Context to Spans (optional but recommended)

To make traces searchable by Beckn `transaction_id` and `domain`, add a
NestJS interceptor. This touches **one file** and enriches every trace with
Beckn-specific attributes:

```ts
// src/interceptors/beckn-trace.interceptor.ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { trace } from '@opentelemetry/api';

@Injectable()
export class BecknTraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req  = context.switchToHttp().getRequest();
    const body = req.body ?? {};
    const ctx  = body?.context ?? {};

    const span = trace.getActiveSpan();
    if (span && ctx.transaction_id) {
      span.setAttributes({
        'beckn.transaction_id': ctx.transaction_id ?? '',
        'beckn.message_id':     ctx.message_id     ?? '',
        'beckn.domain':         ctx.domain         ?? '',
        'beckn.action':         ctx.action         ?? '',
        'beckn.bap_id':         ctx.bap_id         ?? '',
      });
    }

    return next.handle();
  }
}
```

Register globally in `main.ts` (after `NestFactory.create`):

```ts
import { BecknTraceInterceptor } from './interceptors/beckn-trace.interceptor';

// inside bootstrap():
app.useGlobalInterceptors(new BecknTraceInterceptor());
```

### 5.4 Environment Variables

Add to your `.env`:

```env
# OpenTelemetry
OTEL_SERVICE_NAME=vistaar-provider-backend
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

---

## 6. Backend Options: Jaeger vs Grafana + Tempo

### Option A — Jaeger (standalone, simplest)

Best if: you want traces only and don't need to correlate with other metrics.
Single Docker container, own UI at port 16686.

**Start Jaeger:**

```yaml
# docker-compose.jaeger.yml
services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    container_name: jaeger
    network_mode: "host"          # matches backend's network_mode: host
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    restart: always
```

```bash
docker compose -f docker-compose.jaeger.yml up -d
```

Ports used (all on localhost since network_mode: host):
- `4318` — OTLP HTTP receiver (NestJS sends here)
- `4317` — OTLP gRPC receiver (alternative)
- `16686` — Jaeger UI (open in browser)
- `14250` — gRPC model
- `9411`  — Zipkin compatible (unused here)

**Verify it's running:**
```bash
curl http://localhost:16686/api/services
# → {"data":["vistaar-provider-backend"],"total":1,"limit":0,"offset":0,"errors":null}
```

---

### Option B — Grafana + Tempo (recommended if Grafana already exists)

Best if: you already have Grafana and want one UI for everything.
Tempo is the trace storage backend; Grafana is the query + visualisation UI.

**Start Tempo:**

```yaml
# docker-compose.tempo.yml
services:
  tempo:
    image: grafana/tempo:latest
    container_name: tempo
    network_mode: "host"
    command: ["-config.file=/etc/tempo/tempo.yaml"]
    volumes:
      - ./infra/tempo.yaml:/etc/tempo/tempo.yaml
      - tempo-data:/var/tempo
    restart: always

volumes:
  tempo-data:
```

```yaml
# infra/tempo.yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: "0.0.0.0:4318"   # NestJS sends traces here
        grpc:
          endpoint: "0.0.0.0:4317"

ingester:
  trace_idle_period: 10s
  max_block_bytes: 1_000_000
  max_block_duration: 5m

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
    wal:
      path: /var/tempo/wal

compactor:
  compaction:
    block_retention: 168h    # 7 days of trace history
```

```bash
docker compose -f docker-compose.tempo.yml up -d
```

**Wire Grafana to Tempo (one-time setup):**

1. Open Grafana → **Connections → Data Sources → Add data source**
2. Choose **Tempo**
3. URL: `http://localhost:3200`
4. Click **Save & Test** → should show "Data source connected and labels found"

---

## 7. What You See in the UI

### Jaeger UI (`http://localhost:16686`)

**Search screen:**
```
Service:   [vistaar-provider-backend ▼]
Operation: [POST /mobility/search    ▼]
Tags:      beckn.domain=agri-schemes
           beckn.transaction_id=txn-abc-123
Lookback:  [Last 1 hour ▼]

[Find Traces]
```

**Trace view (after clicking a result):**
```
Trace: 4bf92f3577b34da6a3ce929d0e0e4736    Duration: 342ms   Spans: 4

▼  vistaar-provider-backend  POST /mobility/search          0ms ──────────────── 342ms
   │  http.method: POST
   │  http.url: /mobility/search
   │  http.status_code: 200
   │  beckn.transaction_id: txn-abc-123
   │  beckn.domain: agri-schemes
   │  beckn.action: search
   │
   ├─▶ vistaar-provider-backend  HTTP POST                  78ms ───── 196ms
   │      http.target: https://hasura.tekdinext.com/v1/graphql
   │      http.status_code: 200
   │      net.peer.name: hasura.tekdinext.com
   │      duration: 118ms
   │
   └─▶ vistaar-provider-backend  HTTP POST                 200ms ────────── 310ms
          http.target: https://pmkisan.gov.in/ChatbotOTP
          http.status_code: 200
          net.peer.name: pmkisan.gov.in
          duration: 110ms
```

Click any span → see all attributes + timing breakdown in the detail panel.

**Compare multiple traces:**
Jaeger lets you select 2-3 traces and show them side-by-side to compare
how the same endpoint performed on different requests.

---

### Grafana UI (Explore → Tempo)

**Search by Beckn transaction:**
```
Query type: Search
Service name: vistaar-provider-backend
Span name:    POST /mobility/search
Tags:         beckn.transaction_id = txn-abc-123

[Run query]
```

**Trace view (same waterfall, built into Grafana):**
```
Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736
Service Graph:  [vistaar-provider-backend] ──▶ [hasura.tekdinext.com]
                                           └──▶ [pmkisan.gov.in]

Timeline:
0ms      100ms     200ms     300ms     342ms
│────────────────────────────────────────────│  POST /mobility/search
         │──────────────│                       HTTP POST hasura (118ms)
                        │──────────────│         HTTP POST pmkisan (110ms)
```

**Grafana advantage — trace-to-log correlation:**
If you later add Loki (log aggregation), Grafana can show the trace
timeline on top and the log lines from the same time window below —
one click from a span to the exact log line that emitted it.

---

## 8. Trace Examples Per Flow

### `/mobility/search` → schemes-agri (Hasura)
```
POST /mobility/search                  [0 → 342ms]  SERVER
  └── HTTP POST hasura.../v1/graphql   [78 → 196ms] CLIENT
```

### `/mobility/init` → PMKISAN OTP flow
```
POST /mobility/init                    [0 → 480ms]  SERVER
  └── HTTP POST pmkisan.gov.in/ChatbotOTP  [50 → 430ms] CLIENT
```

### `/mobility/status` → PMFBY (multi-hop)
```
POST /mobility/status                  [0 → 890ms]  SERVER
  ├── HTTP POST pmfby.../api/v2/login  [20 → 180ms] CLIENT   ← get token
  ├── HTTP POST pmfby.../getFarmerId   [200 → 400ms] CLIENT  ← farmer lookup
  └── HTTP POST pmfby.../policyStatus  [420 → 870ms] CLIENT  ← actual data
```

### `/mobility/search` → mandi (DB + Vistaar API)
```
POST /mobility/search                  [0 → 610ms]  SERVER
  ├── pg  get_markets_at_point()       [10 → 90ms]  CLIENT   ← PostGIS query
  └── HTTP POST vistaar.../mandi       [100 → 580ms] CLIENT  ← price data
```

---

## 9. Full Data Flow (end-to-end)

```
1. Beckn BAP sends POST /mobility/search
        │
2. Express receives request
   → instrumentation-express creates ROOT SPAN
     traceId = 4bf92f...
     spanId  = 00f067...
        │
3. BecknTraceInterceptor fires (sync, zero-latency)
   → reads body.context.transaction_id, domain, action
   → attaches them as span attributes
        │
4. AppController.getContentFromIcar1() routes to AppService.handlePmKisanSearch()
        │
5. AppService calls HasuraService.findIcarContent()
   → HasuraService calls axios.post(hasuraUrl, { query, variables })
   → instrumentation-http creates CHILD SPAN (parentSpanId = 00f067...)
     spanId = b7ad6b...
     http.target = https://hasura.tekdinext.com/v1/graphql
        │
6. Hasura responds → child span closes (records duration, status)
        │
7. AppService builds catalog response → controller returns JSON
   → root span closes (records total duration, final status)
        │
8. BatchSpanProcessor batches spans in memory (non-blocking)
        │
9. Every 5 seconds: background flush
   → POST http://localhost:4318/v1/traces
   → Jaeger or Tempo receives and stores
        │
10. Developer opens Jaeger UI / Grafana Explore
    → searches beckn.transaction_id=txn-abc-123
    → sees full waterfall with all child spans
```

---

## 10. Directory Structure After Implementation

```
src/
├── tracing.ts                          ← NEW: OTel SDK bootstrap (import first)
├── main.ts                             ← CHANGED: add import './tracing' on line 1
├── interceptors/
│   └── beckn-trace.interceptor.ts     ← NEW: attaches Beckn fields to spans
│
├── app.module.ts                       ← unchanged
├── app.service.ts                      ← unchanged
├── app.controller.ts                   ← unchanged
└── services/
    └── ...                             ← all unchanged

infra/
└── tempo.yaml                          ← NEW: Tempo config (if using Grafana)

docker-compose.jaeger.yml               ← NEW: Jaeger option
docker-compose.tempo.yml                ← NEW: Tempo option
```

---

## 11. Step-by-Step Rollout

```
Step 1 — Install packages
  npm install @opentelemetry/sdk-node \
              @opentelemetry/auto-instrumentations-node \
              @opentelemetry/exporter-trace-otlp-http \
              @opentelemetry/api

Step 2 — Create src/tracing.ts  (section 5.1)

Step 3 — Add import './tracing' as first line of src/main.ts

Step 4 — Choose backend:
         A) Jaeger:  docker compose -f docker-compose.jaeger.yml up -d
         B) Tempo:   docker compose -f docker-compose.tempo.yml up -d
                     + add Tempo datasource in Grafana (section 6 Option B)

Step 5 — Add OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces to .env

Step 6 — Restart the NestJS app
         npm run start:dev

Step 7 — Send any Beckn request:
         curl -X POST http://localhost:3000/mobility/search -d '{ ... }'

Step 8 — View trace:
         Jaeger:  http://localhost:16686  → Service: vistaar-provider-backend
         Grafana: Explore → Tempo → Service: vistaar-provider-backend

Step 9 — (optional) Create src/interceptors/beckn-trace.interceptor.ts
         and register in main.ts to enable beckn.transaction_id search
```

---

## 12. Choosing Between Jaeger and Grafana + Tempo

| | Jaeger | Grafana + Tempo |
|---|---|---|
| Already in your stack | No — new UI | Yes — just add Tempo datasource |
| Setup effort | One docker run | One docker run + datasource config |
| Trace search | By service, operation, tags | By service, operation, tags |
| Trace timeline | Excellent | Excellent |
| Correlate with logs | No | Yes (with Loki) |
| Correlate with metrics | No | Yes (with Prometheus) |
| Long-term storage | Needs Elasticsearch/Cassandra | Local disk or S3 |
| Best for | Traces only, quick setup | Unified observability, existing Grafana |

**Decision rule:**
- Have Grafana? → Use **Grafana + Tempo**. Same UI, one less tool, future-proof.
- No Grafana at all? → Use **Jaeger all-in-one**. Fastest path to traces.

Both use port `4318` for OTLP HTTP — only `.env` changes between them.
