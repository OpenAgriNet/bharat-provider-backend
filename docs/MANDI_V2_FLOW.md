# Mandi v2 — vistaar-location + Postgres commodity cache

## Endpoint

`POST /mobility/search`

## Routing

| Condition | Route |
|-----------|-------|
| `category = price-discovery` + `item.descriptor.name` (no commoditycode) | `mandi-location` (v2) |
| `category = price-discovery` + `item.code = mandi` + `commoditycode` | `mandi` (legacy) |

All mandi requests use `context.domain = schemes:vistaar` (same as other Vistaar use cases). Routing is by payload shape, not domain.

## Request (v2)

```json
{
  "context": { "domain": "schemes:vistaar", "action": "search" },
  "message": {
    "intent": {
      "category": { "descriptor": { "code": "price-discovery" } },
      "item": { "descriptor": { "name": "apple" } },
      "fulfillment": {
        "end": {
          "location": {
            "descriptor": { "name": "Delhi" },
            "gps": "28.6328027,77.2197713"
          }
        }
      },
      "tags": [{ "code": "date", "value": "24-06-2026" }]
    }
  }
}
```

## Response (compact on_search)

```json
{
  "context": { "action": "on_search", "domain": "schemes:vistaar" },
  "message": {
    "catalog": {
      "commodity": "Apple",
      "commodity_id": 17,
      "location": "Delhi",
      "date": "24-06-2026",
      "prices": [
        { "market": "APMC Azadpur", "modal": 13000, "min": 10000, "max": 16000, "unit": "Rs./Qtl" }
      ]
    }
  }
}
```

## Env vars

```
AGMARKNET_BASE_URL=https://api.agmarknet.gov.in
AGMARKNET_ACCESS_NAME=...
AGMARKNET_PASSWORD=...
IMD_DB_HOST=...
IMD_DB_PORT=5432
IMD_DB_USER=...
IMD_DB_PASSWORD=...
IMD_DB_NAME=weather_service
```

## Postgres

Tables created on startup: `commodities`, `commodity_terms`, `cache_sync_log`

Migration SQL: `database/migrations/001_mandi_commodity_cache.sql`

Commodity master syncs from Agmarknet `master-data?option=2`:
- **On first boot** if cache is empty
- **Weekly cron** (default Sunday 2 AM) — truncates old rows, inserts fresh data

### Cache sync env vars

```env
COMMODITY_SYNC_ENABLED=true          # set false to disable all sync
COMMODITY_SYNC_CRON=0 2 * * 0        # optional — default: every Sunday 2 AM
```

Sync log keeps last 52 entries in `cache_sync_log`; older log rows are deleted after each sync.

## Services

| File | Role |
|------|------|
| `beckn-context.service.ts` | Parse Beckn intent |
| `commodity-resolver.service.ts` | String → commodity_id |
| `agmarknet-api.service.ts` | Token + vistaar-location |
| `catalog-compact.service.ts` | Max 5 price rows |
| `commodity-sync.service.ts` | Postgres cache refresh |