# Telemetry Approach — Request / Response Observability

## Context

This backend (NestJS) serves Beckn protocol endpoints (`/mobility/search`, `/mobility/init`, `/mobility/status`, etc.) and fans out to multiple external systems:

| Upstream | How called | Key flows |
|---|---|---|
| Hasura GraphQL | `axios` in `HasuraService` | Scheme search, content fetch |
| PM Kisan Portal | `axios` in `AppService` | OTP send/verify, user details |
| PMFBY API | `axios` in `PmfbyService` | Token, farmer ID, policy/claim status |
| Soil Health Card API | `axios` in `AppService` | GraphQL token + health card fetch |
| Mandi / Weather / GFR / SMAM / SATHI | `axios` in respective services | Price, forecast, crop data |
| Vector DB (OAN index) | `axios` in `AppService` | Knowledge-advisory search |

**Goal**: For every inbound request and every outbound HTTP call, capture:
- Timestamp (when request was made)
- Full payload (request body / GraphQL variables)
- Full response (status code + body)
- Duration (ms)
- Correlation — which outbound calls were triggered by which inbound request

---

## Option Comparison

### Option A — NestJS Interceptor + Global Axios Interceptor
**Effort**: Low (1–2 days) | **New infra**: None

Add a `LoggingInterceptor` in NestJS to capture every inbound request + response, and register a single global Axios request/response interceptor in `main.ts`. Writes structured JSON to the existing Winston logger (`combined.log`).

```
Inbound POST /mobility/search
  → LoggingInterceptor logs: { endpoint, timestamp, requestBody, ... }
    → AppService calls HasuraService.findIcarContent()
        → Axios interceptor logs: { url, payload, timestamp }
        → Axios interceptor logs: { url, status, responseBody, durationMs }
  → LoggingInterceptor logs: { responseBody, totalDurationMs }
```

**Pros**: No new dependencies, uses existing Winston, works today.  
**Cons**: No UI, no cross-service tracing, log files need rotation/shipping.

---

### Option B — OpenTelemetry (OTel) with Jaeger / Grafana Tempo
**Effort**: Medium (3–5 days) | **New infra**: OTel Collector + Jaeger (or Grafana Tempo)

Use `@opentelemetry/sdk-node` with auto-instrumentation packages for Express and Axios/HTTP. Every inbound request becomes a root span; every outbound Axios call becomes a child span automatically. Spans include URL, payload attributes, status, and duration. Traces are shipped to a collector.

```
Trace: POST /mobility/search [200, 340ms]
 ├─ Span: HasuraService.findIcarContent [gql query, 120ms]
 ├─ Span: HTTP POST https://hasura.../v1/graphql [200, 118ms]
 └─ Span: AppService.handlePmKisanSearch [200ms]
```

**Pros**: Industry standard, timeline view, auto-captures everything, searchable by trace ID.  
**Cons**: Needs collector sidecar, slightly higher memory overhead.

---

### Option C — NGINX Access Logs
**Effort**: Low | **New infra**: NGINX in front of the app

NGINX can log request method, path, status, response time, and upstream address. It **cannot** log request/response bodies natively (requires the `ngx_http_lua_module` or a paid feature). The current Docker setup uses `network_mode: host` and no NGINX proxy layer, so this only adds partial visibility (no payload bodies).

**Verdict**: Useful as a complementary layer for network-level metrics but insufficient alone for payload-level telemetry.

---

## Recommended Approach

**Phase 1 (immediate)** — Option A: NestJS Interceptor + Axios interceptors.  
**Phase 2 (production hardening)** — Option B: Add OpenTelemetry on top. The interceptor logs from Phase 1 remain; OTel adds trace correlation and a Jaeger/Grafana UI.

---

## Phase 1 Implementation — Structured JSON Logging

### 1.1 Correlation ID Middleware

Create `src/middleware/correlation.middleware.ts` to stamp every inbound request with a `x-correlation-id` header (generates a UUID if not sent by caller). This ID is threaded through all downstream log entries.

```ts
// src/middleware/correlation.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    req.correlationId = req.headers['x-correlation-id'] ?? uuidv4();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  }
}
```

Register in `AppModule`:
```ts
consumer.apply(CorrelationMiddleware).forRoutes('*');
```

---

### 1.2 NestJS Logging Interceptor

Create `src/interceptors/logging.interceptor.ts`. Wraps every controller method — logs the inbound payload on entry, and logs the outbound response + duration on exit.

```ts
// src/interceptors/logging.interceptor.ts
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { LoggerService } from 'src/services/logger/logger.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const correlationId = req.correlationId ?? 'unknown';
    const start = Date.now();

    this.logger.log('INBOUND_REQUEST', JSON.stringify({
      correlationId,
      type: 'inbound_request',
      method: req.method,
      url: req.url,
      timestamp: new Date().toISOString(),
      body: req.body,         // full request payload
      headers: {              // sanitised — omit auth secrets
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
      },
    }));

    return next.handle().pipe(
      tap((responseBody) => {
        this.logger.log('INBOUND_RESPONSE', JSON.stringify({
          correlationId,
          type: 'inbound_response',
          url: req.url,
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          responseBody,       // full on_search / on_status etc payload
        }));
      }),
    );
  }
}
```

Register globally in `main.ts`:
```ts
app.useGlobalInterceptors(new LoggingInterceptor(app.get(LoggerService)));
```

---

### 1.3 Global Axios Interceptor (Outbound Calls)

Add once in `main.ts` after `NestFactory.create`. This captures **every** axios call across all services (HasuraService, PmfbyService, MandiService, etc.) without touching each service individually.

```ts
// in bootstrap(), after app creation
import axios from 'axios';

axios.interceptors.request.use((config) => {
  (config as any).metadata = { startTime: Date.now() };
  const correlationId = (config.headers as any)['x-correlation-id'] ?? 'none';
  logger.log('OUTBOUND_REQUEST', JSON.stringify({
    type: 'outbound_request',
    correlationId,
    url: config.url,
    method: config.method?.toUpperCase(),
    timestamp: new Date().toISOString(),
    payload: config.data,   // full payload sent to external API / Hasura
    headers: {
      'content-type': config.headers?.['Content-Type'],
      // do NOT log admin secrets or auth tokens
    },
  }));
  return config;
});

axios.interceptors.response.use(
  (response) => {
    const durationMs = Date.now() - ((response.config as any).metadata?.startTime ?? Date.now());
    logger.log('OUTBOUND_RESPONSE', JSON.stringify({
      type: 'outbound_response',
      url: response.config.url,
      method: response.config.method?.toUpperCase(),
      statusCode: response.status,
      durationMs,
      timestamp: new Date().toISOString(),
      responseBody: response.data,  // full response from external API
    }));
    return response;
  },
  (error) => {
    logger.error('OUTBOUND_ERROR', JSON.stringify({
      type: 'outbound_error',
      url: error.config?.url,
      statusCode: error.response?.status,
      errorMessage: error.message,
      responseBody: error.response?.data,
      timestamp: new Date().toISOString(),
    }));
    return Promise.reject(error);
  },
);
```

---

### 1.4 What Gets Captured Per Log Entry

#### Inbound Request (`type: inbound_request`)
| Field | Example |
|---|---|
| `correlationId` | `a1b2c3d4-...` |
| `method` | `POST` |
| `url` | `/mobility/search` |
| `timestamp` | `2026-06-09T10:23:45.123Z` |
| `body.context.domain` | `agri-schemes` |
| `body.context.transaction_id` | `txn-xyz` |
| `body.message.intent` | full Beckn intent object |

#### Inbound Response (`type: inbound_response`)
| Field | Example |
|---|---|
| `correlationId` | `a1b2c3d4-...` (links to request) |
| `durationMs` | `342` |
| `responseBody.context.action` | `on_search` |
| `responseBody.message.catalog` | full catalog |

#### Outbound Request (`type: outbound_request`)
| Field | Example |
|---|---|
| `url` | `https://hasura.tekdinext.com/v1/graphql` |
| `method` | `POST` |
| `timestamp` | `2026-06-09T10:23:45.201Z` |
| `payload.query` | GraphQL query string |
| `payload.variables` | `{ usecase: "schemes-agri" }` |

#### Outbound Response (`type: outbound_response`)
| Field | Example |
|---|---|
| `url` | `https://hasura.tekdinext.com/v1/graphql` |
| `statusCode` | `200` |
| `durationMs` | `118` |
| `responseBody.data` | Hasura result / external API result |

---

### 1.5 Log Format Sample (`combined.log`)

```json
{"level":"info","message":"INBOUND_REQUEST","context":"{\"correlationId\":\"a1b2c3\",\"type\":\"inbound_request\",\"method\":\"POST\",\"url\":\"/mobility/search\",\"timestamp\":\"2026-06-09T10:23:45.123Z\",\"body\":{\"context\":{\"domain\":\"agri-schemes\",\"transaction_id\":\"txn-abc\"},\"message\":{\"intent\":{\"category\":{\"descriptor\":{\"code\":\"schemes-agri\"}}}}}}","timestamp":"2026-06-09T10:23:45.124Z"}

{"level":"info","message":"OUTBOUND_REQUEST","context":"{\"type\":\"outbound_request\",\"url\":\"https://hasura.../v1/graphql\",\"method\":\"POST\",\"timestamp\":\"2026-06-09T10:23:45.200Z\",\"payload\":{\"query\":\"query { Content(where: ...) }\",\"variables\":{}}}","timestamp":"2026-06-09T10:23:45.201Z"}

{"level":"info","message":"OUTBOUND_RESPONSE","context":"{\"type\":\"outbound_response\",\"url\":\"https://hasura.../v1/graphql\",\"statusCode\":200,\"durationMs\":118,\"responseBody\":{\"data\":{\"Content\":[...]}}}","timestamp":"2026-06-09T10:23:45.320Z"}

{"level":"info","message":"INBOUND_RESPONSE","context":"{\"correlationId\":\"a1b2c3\",\"type\":\"inbound_response\",\"url\":\"/mobility/search\",\"durationMs\":342,\"responseBody\":{\"context\":{\"action\":\"on_search\"},\"message\":{\"catalog\":{...}}}}","timestamp":"2026-06-09T10:23:45.466Z"}
```

Querying logs for a single flow:
```bash
grep '"correlationId":"a1b2c3"' combined.log | jq .
```

---

### 1.6 Security — What NOT to Log

Never log these fields even if present in payload:
- `x-hasura-admin-secret` / `HASURA_GRAPHQL_ADMIN_SECRET`
- `PM_KISSAN_TOKEN` / `Token` field in PM Kisan requests
- `Authorization` header values
- Encrypted payloads (`EncryptedRequest` content)
- OTP values

Strip them in the interceptors before writing to log.

---

## Phase 2 — OpenTelemetry (Distributed Tracing)

### Install

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

### Tracing Bootstrap (`src/tracing.ts`)

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const exporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
});

const sdk = new NodeSDK({
  serviceName: 'vistaar-provider-backend',
  traceExporter: exporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

Import before NestJS in `main.ts`:
```ts
import './tracing'; // must be first import
```

### What auto-instrumentation captures
- Every Express route handler → root span with HTTP method, path, status
- Every `axios` call → child span with URL, method, status, duration
- Every outbound HTTP → auto-correlated to parent trace

### Collector + UI Options

| Tool | Setup | UI |
|---|---|---|
| **Jaeger** (simplest) | `docker run -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one` | `http://localhost:16686` |
| **Grafana Tempo + Grafana** | `docker-compose` with Tempo + Grafana | Grafana Explore → Trace view |
| **Signoz** (all-in-one) | `docker-compose` from signoz.io | Full dashboard + logs |

### Adding Payload to Spans (optional, for Hasura/PM Kisan)

```ts
import { trace } from '@opentelemetry/api';

// Inside HasuraService.queryDb():
const span = trace.getActiveSpan();
span?.setAttribute('hasura.query', query.substring(0, 500)); // truncate large queries
span?.setAttribute('hasura.namespace', this.nameSpace);
```

---

## Decision Matrix

| Requirement | Phase 1 (Interceptor) | Phase 2 (OTel) | NGINX |
|---|---|---|---|
| Inbound request payload | Yes | Yes | No |
| Inbound response payload | Yes | Partial (as span attributes) | No |
| Outbound call payload | Yes | Partial (as span attributes) | No |
| Outbound response body | Yes | Partial | No |
| Request timing | Yes | Yes | Yes |
| Correlation across calls | Manual (correlationId) | Auto (trace propagation) | No |
| UI / search | No (grep logs) | Yes (Jaeger/Grafana) | Yes (access log) |
| New infra required | No | Yes (collector) | Yes (NGINX proxy) |
| Code changes | Interceptor + Axios hook | Tracing bootstrap only | nginx.conf |

---

## Suggested Rollout

1. **Today**: Implement Phase 1 (`CorrelationMiddleware` + `LoggingInterceptor` + Axios global interceptor). No new dependencies, works with existing Winston + `combined.log`.
2. **Next sprint**: Add log rotation (`winston-daily-rotate-file`) so `combined.log` doesn't grow unboundedly.
3. **Production**: Stand up a Jaeger or SigNoz container on the same server, add Phase 2 OTel bootstrap. Both layers coexist — structured logs for payload detail, traces for flow visualisation.
