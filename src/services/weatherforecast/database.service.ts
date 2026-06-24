import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Pool, PoolConfig, QueryResult } from "pg";

export interface CommodityRow {
  commodity_id: number;
  commodity_name: string;
  group_name: string | null;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;
  /** Dedicated pool for mandi v2 commodity cache (MANDI_DB_*), falls back to main pool */
  private mandiPool: Pool;

  constructor() {
    this.pool = this.createPool("IMD_DB", "WEATHER_DB");
    this.mandiPool = process.env.MANDI_DB_HOST
      ? this.createPool("MANDI_DB", "MANDI_DB")
      : this.pool;
  }

  private createPool(prefix: string, fallbackPrefix: string): Pool {
    const sslMode = (
      process.env[`${prefix}_SSLMODE`] ||
      process.env[`${fallbackPrefix}_SSLMODE`] ||
      process.env.IMD_DB_SSLMODE ||
      ""
    ).toLowerCase();
    const sslEnabledFromMode = ["require", "verify-ca", "verify-full", "no-verify"].includes(sslMode);
    const sslEnabled = this.parseBoolean(
      process.env[`${prefix}_SSL`] || process.env[`${fallbackPrefix}_SSL`] || process.env.IMD_DB_SSL,
      sslEnabledFromMode,
    );
    const rejectUnauthorized = this.parseBoolean(
      process.env[`${prefix}_SSL_REJECT_UNAUTHORIZED`] ||
        process.env[`${fallbackPrefix}_SSL_REJECT_UNAUTHORIZED`] ||
        process.env.IMD_DB_SSL_REJECT_UNAUTHORIZED,
      false,
    );

    const poolConfig: PoolConfig = {
      host:
        process.env[`${prefix}_HOST`] ||
        process.env[`${fallbackPrefix}_HOST`] ||
        process.env.IMD_DB_HOST ||
        process.env.WEATHER_DB_HOST,
      port: parseInt(
        process.env[`${prefix}_PORT`] ||
          process.env[`${fallbackPrefix}_PORT`] ||
          process.env.IMD_DB_PORT ||
          process.env.WEATHER_DB_PORT ||
          "5432",
      ),
      database:
        process.env[`${prefix}_NAME`] ||
        process.env[`${fallbackPrefix}_NAME`] ||
        process.env.IMD_DB_NAME ||
        process.env.WEATHER_DB_NAME,
      user:
        process.env[`${prefix}_USER`] ||
        process.env[`${fallbackPrefix}_USER`] ||
        process.env.IMD_DB_USER ||
        process.env.WEATHER_DB_USER,
      password:
        process.env[`${prefix}_PASSWORD`] ||
        process.env[`${fallbackPrefix}_PASSWORD`] ||
        process.env.IMD_DB_PASSWORD ||
        process.env.WEATHER_DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };

    if (sslEnabled) {
      poolConfig.ssl = { rejectUnauthorized };
    }

    return new Pool(poolConfig);
  }

  private commodityPool(): Pool {
    return this.mandiPool;
  }

  private parseBoolean(
    value: string | undefined,
    defaultValue: boolean,
  ): boolean {
    if (value === undefined) {
      return defaultValue;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }

  async onModuleInit() {
    try {
      const client = await this.pool.connect();
      this.logger.log("IMD/Weather database connection established");
      client.release();
      if (this.mandiPool !== this.pool) {
        const mandiClient = await this.mandiPool.connect();
        this.logger.log(
          `Mandi database connection established (${process.env.MANDI_DB_NAME})`,
        );
        mandiClient.release();
      }
    } catch (error) {
      this.logger.error("Failed to connect to database", error);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
    if (this.mandiPool !== this.pool) {
      await this.mandiPool.end();
    }
    this.logger.log("Database connection pool closed");
  }

  async findNearbyStations(
    latitude: number,
    longitude: number,
    limit: number = 1,
  ): Promise<any[]> {
    try {
      this.logger.log(
        `Querying nearby stations for lat: ${latitude}, lon: ${longitude}, limit: ${limit}`,
      );

      const query =
        "SELECT * FROM find_nearby_stations($1, $2, $3) ORDER BY distance_km ASC;";
      const result: QueryResult = await this.pool.query(query, [
        latitude,
        longitude,
        limit,
      ]);

      if (result.rows && result.rows.length > 0) {
        this.logger.log(
          `Found ${result.rows.length} nearby station(s) within ${limit}km radius`,
        );
        result.rows.forEach((row, index) => {
          this.logger.log(
            `Station ${index + 1}: ID=${row.station_id}, Name=${row.station_name}, District=${row.district}, State=${row.state}, Distance=${row.distance_km}km`,
          );
        });
        return result.rows;
      } else {
        this.logger.warn(`No nearby stations found within ${limit}km radius`);
        return [];
      }
    } catch (error) {
      this.logger.error("Error querying nearby stations", error);
      throw error;
    }
  }

  /**
   * Find mandi markets at a point using get_markets_at_point(lat, lon).
   * Returns rows with statecode, state, district_name, districtcode, marketcode (commoditycode from request).
   */
  async findNearestStateForGFR(
    latitude: number,
    longitude: number,
  ): Promise<{
    state_name: string;
    state_object_id: string;
    district_name: string;
    district_object_id: string;
  } | null> {
    try {
      this.logger.log(
        `GFR: Querying nearest state for lat: ${latitude}, lon: ${longitude}`,
      );
      const query = `
          SELECT
            id,
            state_name,
            state_object_id,
            district_name,
            district_object_id,
            latitude,
            longitude,
            SQRT(
              POWER(latitude  - $1, 2) +
              POWER(longitude - $2, 2)
            ) AS distance
          FROM state_district_coordinate_mapping
          WHERE latitude  IS NOT NULL
            AND longitude IS NOT NULL
          ORDER BY distance ASC
          LIMIT 1
        `;
      const result: QueryResult = await this.pool.query(query, [
        latitude,
        longitude,
      ]);
      if (result.rows && result.rows.length > 0) {
        this.logger.log(
          `GFR: Nearest state found: ${result.rows[0].state_name}, objectId: ${result.rows[0].state_object_id}`,
        );
        return result.rows[0];
      }
      this.logger.warn(
        "GFR: No state found in state_district_coordinate_mapping",
      );
      return null;
    } catch (error) {
      this.logger.error("GFR: Error querying nearest state", error);
      throw error;
    }
  }

  /**
   * Find the nearest district for Sathi seed availability using the
   * get_sathi_nearest_district(lat, lon) PostgreSQL function.
   * Returns state_code and district_lgd_code from sathi_corrdinate_lgd_tbl.
   */
  async findSathiNearestDistrict(
    latitude: number,
    longitude: number,
  ): Promise<{ state_code: string; district_lgd_code: string; state_name: string; district_name: string } | null> {
    try {
      this.logger.log(
        `Sathi: Querying nearest district for lat: ${latitude}, lon: ${longitude}`,
      );
      const query = `SELECT * FROM get_sathi_nearest_district($1, $2) LIMIT 1;`;
      const result: QueryResult = await this.pool.query(query, [latitude, longitude]);
      if (result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        this.logger.log(
          `Sathi: Nearest district found — state: ${row.state_name} (${row.state_code}), district: ${row.district_name} (${row.district_lgd_code})`,
        );
        return {
          state_code: String(row.state_code),
          district_lgd_code: String(row.district_lgd_code),
          state_name: row.state_name ?? '',
          district_name: row.district_name ?? '',
        };
      }
      this.logger.warn('Sathi: No nearest district found in sathi_corrdinate_lgd_tbl');
      return null;
    } catch (error) {
      this.logger.error('Sathi: Error querying get_sathi_nearest_district', error);
      throw error;
    }
  }

  async findMandiMasterData(
    latitude: number,
    longitude: number,
  ): Promise<MandiMasterRow[]> {
    try {
      const query = `
                SELECT
                    state_code AS "stateCode",
                    state,
                    district_code AS "districtCode",
                    district_name AS "district",
                    market_code AS "marketCode",
                    market_name AS "marketName"
                FROM get_markets_at_point($1, $2)
            `;
      const result: QueryResult = await this.pool.query(query, [
        latitude,
        longitude,
      ]);
      const rows: MandiMasterRow[] = (result.rows || []).map((r: any) => ({
        statecode: r.stateCode ?? "",
        state: r.state ?? "",
        district_name: r.district ?? "",
        districtcode: r.districtCode ?? "",
        marketcode: r.marketCode ?? "",
        commoditycode: undefined,
      }));
      this.logger.log(
        `Mandi: get_markets_at_point found ${rows.length} row(s) for lat=${latitude}, lon=${longitude}`,
      );
      return rows;
    } catch (error) {
      this.logger.error("Error querying get_markets_at_point", error);
      throw error;
    }
  }

  async ensureCommodityTables(): Promise<void> {
    await this.commodityPool().query(`
      CREATE TABLE IF NOT EXISTS commodities (
        commodity_id   INT PRIMARY KEY,
        commodity_name VARCHAR(255) NOT NULL,
        group_name     VARCHAR(100),
        synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_commodities_name_lower ON commodities (LOWER(commodity_name));
      CREATE TABLE IF NOT EXISTS commodity_terms (
        id SERIAL PRIMARY KEY,
        commodity_id INT NOT NULL REFERENCES commodities(commodity_id) ON DELETE CASCADE,
        term VARCHAR(255) NOT NULL,
        lang VARCHAR(5) DEFAULT 'en'
      );
      CREATE INDEX IF NOT EXISTS idx_commodity_terms_term_lower ON commodity_terms (LOWER(term));
      CREATE TABLE IF NOT EXISTS cache_sync_log (
        id SERIAL PRIMARY KEY,
        source VARCHAR(50) NOT NULL,
        row_count INT,
        status VARCHAR(20),
        synced_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  async countCommodities(): Promise<number> {
    const result = await this.commodityPool().query(`SELECT COUNT(*)::int AS cnt FROM commodities`);
    return result.rows[0]?.cnt ?? 0;
  }

  async findCommodityExact(name: string): Promise<CommodityRow | null> {
    const result = await this.commodityPool().query(
      `SELECT commodity_id, commodity_name, group_name FROM commodities WHERE LOWER(commodity_name) = LOWER($1) LIMIT 1`,
      [name.trim()],
    );
    return result.rows[0] ?? null;
  }

  async findCommodityByTerm(term: string): Promise<CommodityRow | null> {
    const result = await this.commodityPool().query(
      `SELECT c.commodity_id, c.commodity_name, c.group_name
       FROM commodity_terms t
       JOIN commodities c ON c.commodity_id = t.commodity_id
       WHERE LOWER(t.term) = LOWER($1)
       LIMIT 1`,
      [term.trim()],
    );
    return result.rows[0] ?? null;
  }

  async findCommoditiesPartial(name: string, limit = 5): Promise<CommodityRow[]> {
    const q = `%${name.trim().toLowerCase()}%`;
    const result = await this.commodityPool().query(
      `SELECT commodity_id, commodity_name, group_name FROM commodities
       WHERE LOWER(commodity_name) LIKE $1
       ORDER BY commodity_name
       LIMIT $2`,
      [q, limit],
    );
    return result.rows;
  }

  async replaceCommodityMaster(
    rows: Array<{ commodity_id: number; commodity_name: string; group_name?: string }>,
    trigger = "manual",
  ): Promise<void> {
    const client = await this.commodityPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE commodity_terms, commodities RESTART IDENTITY CASCADE");
      for (const row of rows) {
        await client.query(
          `INSERT INTO commodities (commodity_id, commodity_name, group_name, synced_at)
           VALUES ($1, $2, $3, NOW())`,
          [row.commodity_id, row.commodity_name, row.group_name ?? null],
        );
        await client.query(
          `INSERT INTO commodity_terms (commodity_id, term, lang) VALUES ($1, $2, 'en')`,
          [row.commodity_id, row.commodity_name.toLowerCase()],
        );
      }
      await client.query(
        `INSERT INTO cache_sync_log (source, row_count, status) VALUES ($1, $2, 'ok')`,
        [`master_option_2:${trigger}`, rows.length],
      );
      await client.query(
        `DELETE FROM cache_sync_log
         WHERE id NOT IN (
           SELECT id FROM cache_sync_log ORDER BY synced_at DESC LIMIT 52
         )`,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface MandiMasterRow {
  statecode: string;
  state: string;
  district_name: string;
  districtcode?: string;
  marketcode: string;
  commoditycode?: string;
}

export interface CommodityTermRow {
  commodity_id: number;
  commodity_name: string;
  group_name: string | null;
  term: string;
}
