import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, PoolConfig } from "pg";
import { KHC_MASTER_DDL } from "./khc-master.schema";

type Values = Record<string, unknown>;

export interface ReferencePage {
  options: Values[];
  total: number;
  page: number;
}

// kind -> table. Table names come only from this map, never from request input.
const TABLES: Record<string, string> = {
  states: "khc_state",
  districts: "khc_district",
  "sub-districts": "khc_sub_district",
  villages: "khc_village",
  schemes: "khc_scheme",
  categories: "khc_category",
  "sub-categories": "khc_sub_category",
};
const DAY_MS = 24 * 60 * 60 * 1000;
const days = (name: string, fallback: number) =>
  (parseFloat(process.env[name] || "") || fallback) * DAY_MS;
// Reads trust a stored list this long. The sync runs monthly, so this is a little longer than
// a month: a late or missed run must not push every lookup back to the KHC API.
const maxAgeMs = () => days("KHC_MASTER_MAX_AGE_DAYS", 35);
// The sync re-fetches lists older than this. It must be shorter than the gap between
// sync runs (a month is 28-31 days), or a list synced last run still looks fresh and is skipped.
export const refreshAgeMs = () => days("KHC_SYNC_REFRESH_DAYS", 25);
const PAGE_SIZE = 50;

export const normalizeName = (value: string) =>
  value.toLocaleLowerCase().replace(/\s+/g, "");

/** Letters and digits only, lowercase: "A.I.F." and "aif" compare equal. */
export const looseKey = (value: string) =>
  value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export interface PlaceMatch {
  level: "state" | "district" | "sub-district" | "village";
  id: number;
  name: string;
  state: { id: number; name: string | null } | null;
  district: { id: number; name: string | null } | null;
  subDistrict: { id: number; name: string | null } | null;
}

/**
 * Postgres cache of KHC reference lists (tables: khc-master.schema.ts, created at startup).
 * Every method degrades to "not available" so callers fall back to the KHC API.
 */
@Injectable()
export class KhcMasterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KhcMasterService.name);
  private pool?: Pool;
  private ready = false;

  async onModuleInit(): Promise<void> {
    if (process.env.KHC_MASTER_DB_ENABLED === "false") return;
    const config = this.poolConfig();
    if (!config.host || !config.database) return;
    try {
      this.pool = new Pool(config);
      this.pool.on("error", (error) =>
        this.logger.warn(`KHC master pool error: ${error.message}`)
      );
      await this.ensureTables();
      this.ready = true;
      this.logger.log("KHC master data cache ready");
    } catch (error) {
      this.logger.warn(
        `KHC master data cache unavailable: ${(error as Error).message}`
      );
    }
  }

  /** Create the tables if missing. The lock stops parallel instances racing on first start. */
  private async ensureTables(): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('khc_master_ddl'))");
      await client.query(KHC_MASTER_DDL);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('khc_master_ddl'))")
        .catch(() => undefined);
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Connection settings. Each value is read from KHC_DB_*, then IMD_DB_*, then WEATHER_DB_*
   * (and DB_* for SSL), the same order the rest of the provider uses, so with no KHC_DB_*
   * set the cache lives in the existing database. Set KHC_DB_NAME to use another database.
   */
  private poolConfig(): PoolConfig {
    const env = (name: string, ...extra: string[]) =>
      [`KHC_DB_${name}`, `IMD_DB_${name}`, `WEATHER_DB_${name}`, ...extra]
        .map((key) => process.env[key])
        .find(Boolean);
    const flag = (value: string | undefined, fallback: boolean) =>
      value === undefined ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase());
    const sslMode = (env("SSLMODE", "DB_SSLMODE") || "").toLowerCase();
    const ssl = flag(
      env("SSL", "DB_SSL"),
      ["require", "verify-ca", "verify-full", "no-verify"].includes(sslMode)
    );
    return {
      host: env("HOST"),
      port: parseInt(env("PORT") || "5432", 10),
      database: env("NAME"),
      user: env("USER"),
      password: env("PASSWORD"),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      ssl: ssl
        ? { rejectUnauthorized: flag(env("SSL_REJECT_UNAUTHORIZED", "DB_SSL_REJECT_UNAUTHORIZED"), false) }
        : undefined,
    };
  }

  /** True when this list was stored within ageMs (default: recently enough to trust for reads). */
  async isFresh(
    kind: string,
    parentId: number,
    ageMs: number = maxAgeMs()
  ): Promise<boolean> {
    if (!this.ready || !this.pool) return false;
    try {
      const { rowCount } = await this.pool.query(
        `SELECT 1 FROM khc_sync_state
         WHERE kind = $1 AND parent_id = $2
           AND last_synced_at > NOW() - ($3 || ' milliseconds')::interval`,
        [kind, parentId, String(ageMs)]
      );
      return (rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * One page of a cached list, or null when the cache cannot answer
   * (not ready, never stored, stale unless allowStale, or a DB error).
   */
  async read(
    kind: string,
    parentId: number,
    name: string,
    page: number,
    allowStale = false
  ): Promise<ReferencePage | null> {
    const table = TABLES[kind];
    if (!table || !this.ready || !this.pool) return null;
    try {
      const stored = await this.pool.query(
        `SELECT last_synced_at > NOW() - ($3 || ' milliseconds')::interval AS fresh
         FROM khc_sync_state WHERE kind = $1 AND parent_id = $2`,
        [kind, parentId, String(maxAgeMs())]
      );
      if (!stored.rowCount || (!allowStale && !stored.rows[0].fresh)) return null;
      const needle = normalizeName(name).replace(/[\\%_]/g, "\\$&");
      const { rows } = await this.pool.query(
        `SELECT raw, COUNT(*) OVER () AS total
         FROM ${table}
         WHERE parent_id = $1 AND is_active
           AND ($2 = '' OR name_norm LIKE '%' || $2 || '%')
         ORDER BY pos
         LIMIT ${PAGE_SIZE} OFFSET $3`,
        [parentId, needle, (page - 1) * PAGE_SIZE]
      );
      if (!rows.length) {
        // An empty page past the end still needs the real total.
        const { rows: counted } = await this.pool.query(
          `SELECT COUNT(*) AS total FROM ${table}
           WHERE parent_id = $1 AND is_active
             AND ($2 = '' OR name_norm LIKE '%' || $2 || '%')`,
          [parentId, needle]
        );
        return { options: [], total: Number(counted[0].total), page };
      }
      return {
        options: rows.map((row) => row.raw as Values),
        total: Number(rows[0].total),
        page,
      };
    } catch (error) {
      this.logger.warn(
        `KHC master read failed kind=${kind}: ${(error as Error).message}`
      );
      return null;
    }
  }

  /** Every active row of one cached list in API order, or null when not cached / not trusted. */
  async readAll(
    kind: string,
    parentId: number,
    allowStale = false
  ): Promise<Values[] | null> {
    const table = TABLES[kind];
    if (!table || !this.ready || !this.pool) return null;
    try {
      const stored = await this.pool.query(
        `SELECT last_synced_at > NOW() - ($3 || ' milliseconds')::interval AS fresh
         FROM khc_sync_state WHERE kind = $1 AND parent_id = $2`,
        [kind, parentId, String(maxAgeMs())]
      );
      if (!stored.rowCount || (!allowStale && !stored.rows[0].fresh)) return null;
      const { rows } = await this.pool.query(
        `SELECT raw FROM ${table} WHERE parent_id = $1 AND is_active ORDER BY pos`,
        [parentId]
      );
      return rows.map((row) => row.raw as Values);
    } catch {
      return null;
    }
  }

  /**
   * Search cached villages (or sub-districts) by name, best match first
   * (exact, then starts-with, then contains). Without a state only exact and
   * starts-with matches are searched, so the index can be used.
   */
  async search(
    level: "village" | "sub-district",
    name: string,
    scope: { stateId?: number; districtId?: number },
    limit: number
  ): Promise<PlaceMatch[]> {
    if (!this.ready || !this.pool) return [];
    const needle = looseKey(name).replace(/[\\%_]/g, "\\$&");
    if (!needle) return [];
    const village = level === "village";
    const table = village ? "khc_village" : "khc_sub_district";
    const where = ["x.is_active"];
    const args: unknown[] = [needle];
    if (scope.stateId) {
      args.push(scope.stateId);
      where.push(`x.state_id = $${args.length}`);
    }
    if (scope.districtId) {
      args.push(scope.districtId);
      where.push(village ? `x.district_id = $${args.length}` : `x.parent_id = $${args.length}`);
    }
    where.push(scope.stateId || scope.districtId ? "x.name_norm LIKE '%' || $1 || '%'" : "x.name_norm LIKE $1 || '%'");
    args.push(limit);
    const districtId = village ? "x.district_id" : "x.parent_id";
    const subDistrict = village
      ? "sd.id AS sub_district_id, sd.name AS sub_district_name"
      : "x.id AS sub_district_id, x.name AS sub_district_name";
    const join = village ? "LEFT JOIN khc_sub_district sd ON sd.id = x.parent_id AND sd.is_active" : "";
    try {
      const { rows } = await this.pool.query(
        `SELECT x.id, x.name, x.state_id, ${districtId} AS district_id, ${subDistrict},
                st.name AS state_name, d.name AS district_name
         FROM ${table} x ${join}
         LEFT JOIN khc_state st ON st.id = x.state_id AND st.parent_id = 0
         LEFT JOIN khc_district d ON d.id = ${districtId} AND d.is_active
         WHERE ${where.join(" AND ")}
         ORDER BY CASE WHEN x.name_norm = $1 THEN 0 WHEN x.name_norm LIKE $1 || '%' THEN 1 ELSE 2 END,
                  x.name_norm
         LIMIT $${args.length}`,
        args
      );
      return rows.map((row) => ({
        level,
        id: Number(row.id),
        name: row.name,
        state: row.state_id ? { id: Number(row.state_id), name: row.state_name ?? null } : null,
        district: row.district_id ? { id: Number(row.district_id), name: row.district_name ?? null } : null,
        subDistrict: row.sub_district_id
          ? { id: Number(row.sub_district_id), name: row.sub_district_name ?? null }
          : null,
      }));
    } catch (error) {
      this.logger.warn(`KHC master search failed: ${(error as Error).message}`);
      return [];
    }
  }

  /** How many of a state's sub-districts have their villages cached. */
  async villageCoverage(stateId: number): Promise<{ total: number; loaded: number }> {
    if (!this.ready || !this.pool) return { total: 0, loaded: 0 };
    try {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(s.kind)::int AS loaded
         FROM khc_sub_district sd
         LEFT JOIN khc_sync_state s ON s.kind = 'villages' AND s.parent_id = sd.id
         WHERE sd.state_id = $1 AND sd.is_active`,
        [stateId]
      );
      return rows[0];
    } catch {
      return { total: 0, loaded: 0 };
    }
  }

  /**
   * Save the full list just fetched from KHC. Rows missing from the new list are marked
   * inactive, but not when the list shrank sharply: a partial or broken API answer
   * must not wipe good data.
   */
  async store(
    kind: string,
    parentId: number,
    idField: string,
    nameField: string,
    rows: Values[]
  ): Promise<void> {
    const table = TABLES[kind];
    if (!table || !this.ready || !this.pool) return;
    if (!rows.length) {
      // A genuinely empty list (e.g. a sub-district with no villages) is still "synced", otherwise
      // every sync would fetch it again. Existing rows are left alone.
      await this.pool
        .query(
          `INSERT INTO khc_sync_state (kind, parent_id, row_count, last_synced_at)
           VALUES ($1, $2, 0, NOW())
           ON CONFLICT (kind, parent_id) DO UPDATE SET row_count = 0, last_synced_at = NOW()`,
          [kind, parentId]
        )
        .catch(() => undefined);
      return;
    }
    const ids = rows.map((row) => Number(row[idField]));
    if (!ids.every(Number.isSafeInteger)) return;
    const names = rows.map((row) => String(row[nameField]));
    const client = await this.pool.connect().catch(() => undefined);
    if (!client) return;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${table} (parent_id, id, name, name_norm, raw, pos)
         SELECT $1, t.id, t.name, t.norm, t.raw::jsonb, t.pos
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::int[])
              AS t(id, name, norm, raw, pos)
         ON CONFLICT (parent_id, id) DO UPDATE SET
           name = EXCLUDED.name, name_norm = EXCLUDED.name_norm, raw = EXCLUDED.raw,
           pos = EXCLUDED.pos, is_active = TRUE, synced_at = NOW()`,
        [
          parentId,
          ids,
          names,
          names.map(normalizeName),
          rows.map((row) => JSON.stringify(row)),
          rows.map((_, index) => index),
        ]
      );
      if (kind === "sub-districts") {
        await client.query(
          `UPDATE khc_sub_district SET state_id = d.parent_id
           FROM (SELECT parent_id FROM khc_district WHERE id = $1 LIMIT 1) d
           WHERE khc_sub_district.parent_id = $1 AND khc_sub_district.state_id IS NULL`,
          [parentId]
        );
      } else if (kind === "villages") {
        await client.query(
          `UPDATE khc_village SET state_id = s.state_id, district_id = s.parent_id
           FROM (SELECT state_id, parent_id FROM khc_sub_district
                 WHERE id = $1 AND state_id IS NOT NULL LIMIT 1) s
           WHERE khc_village.parent_id = $1 AND khc_village.state_id IS NULL`,
          [parentId]
        );
      }
      const missing = await client.query(
        `SELECT COUNT(*) AS n FROM ${table}
         WHERE parent_id = $1 AND is_active AND NOT (id = ANY($2::bigint[]))`,
        [parentId, ids]
      );
      const gone = Number(missing.rows[0].n);
      if (gone > 0 && rows.length >= gone * 0.5) {
        await client.query(
          `UPDATE ${table} SET is_active = FALSE
           WHERE parent_id = $1 AND is_active AND NOT (id = ANY($2::bigint[]))`,
          [parentId, ids]
        );
      } else if (gone > 0) {
        this.logger.warn(
          `KHC ${kind} parent=${parentId} shrank sharply (${gone} missing, ${rows.length} returned); old rows kept`
        );
      }
      await client.query(
        `INSERT INTO khc_sync_state (kind, parent_id, row_count, last_synced_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (kind, parent_id) DO UPDATE
         SET row_count = EXCLUDED.row_count, last_synced_at = NOW()`,
        [kind, parentId, rows.length]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.logger.warn(
        `KHC master store failed kind=${kind}: ${(error as Error).message}`
      );
    } finally {
      client.release();
    }
  }

  /** Ids of a parent table whose child list is missing or due for a refresh, oldest first. */
  async staleParents(
    parentKind: string,
    childKind: string,
    limit: number
  ): Promise<number[]> {
    const table = TABLES[parentKind];
    if (!table || !this.ready || !this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `SELECT p.id FROM (SELECT DISTINCT id FROM ${table} WHERE is_active) p
         LEFT JOIN khc_sync_state s ON s.kind = $1 AND s.parent_id = p.id
         WHERE s.last_synced_at IS NULL
            OR s.last_synced_at < NOW() - ($2 || ' milliseconds')::interval
         ORDER BY s.last_synced_at NULLS FIRST, p.id
         LIMIT $3`,
        [childKind, String(refreshAgeMs()), limit]
      );
      return rows.map((row) => Number(row.id));
    } catch {
      return [];
    }
  }

  /** When a sync job last finished (ok or partial), so a restart does not repeat it. */
  async lastJobRun(name: string): Promise<{ at: Date; status: string } | null> {
    if (!this.ready || !this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        "SELECT last_run_at, status FROM khc_sync_job WHERE name = $1 AND status IN ('ok', 'partial')",
        [name]
      );
      return rows[0] ? { at: rows[0].last_run_at, status: rows[0].status } : null;
    } catch {
      return null;
    }
  }

  async recordJobRun(name: string, status: "ok" | "partial" | "aborted", details: Values): Promise<void> {
    if (!this.ready || !this.pool) return;
    await this.pool
      .query(
        `INSERT INTO khc_sync_job (name, last_run_at, status, details)
         VALUES ($1, NOW(), $2, $3::jsonb)
         ON CONFLICT (name) DO UPDATE SET last_run_at = NOW(), status = $2, details = $3::jsonb`,
        [name, status, JSON.stringify(details)]
      )
      .catch((error) =>
        this.logger.warn(`KHC sync job record failed: ${(error as Error).message}`)
      );
  }

  /** Try to take the cluster-wide sync lock; returns a release function or null. */
  async lockSync(): Promise<(() => Promise<void>) | null> {
    if (!this.ready || !this.pool) return null;
    const client = await this.pool.connect().catch(() => undefined);
    if (!client) return null;
    try {
      const { rows } = await client.query(
        "SELECT pg_try_advisory_lock(hashtext('khc_master_sync')) AS ok"
      );
      if (!rows[0].ok) {
        client.release();
        return null;
      }
    } catch {
      client.release();
      return null;
    }
    return async () => {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('khc_master_sync'))")
        .catch(() => undefined);
      client.release();
    };
  }
}
