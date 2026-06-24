import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../weatherforecast/database.service";
import { AgmarknetApiService } from "./agmarknet-api.service";

@Injectable()
export class CommoditySyncService implements OnModuleInit {
  private readonly logger = new Logger(CommoditySyncService.name);
  private syncInProgress = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly agmarknetApi: AgmarknetApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.isSyncDisabled()) {
      this.logger.warn("Commodity sync disabled (COMMODITY_SYNC_ENABLED=false)");
      return;
    }
    try {
      await this.databaseService.ensureCommodityTables();
      const count = await this.databaseService.countCommodities();
      if (count === 0) {
        this.logger.log("Commodity cache empty — initial sync from Agmarknet");
        await this.syncCommodityMaster("startup");
      } else {
        this.logger.log(`Commodity cache ready — ${count} rows`);
      }
    } catch (err) {
      this.logger.warn(`Commodity cache init skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Weekly refresh: truncate old commodity rows, fetch fresh master from Agmarknet, insert new.
   * Default: every Sunday at 2:00 AM (override with COMMODITY_SYNC_CRON env).
   */
  @Cron(process.env.COMMODITY_SYNC_CRON || CronExpression.EVERY_WEEK)
  async weeklyCommoditySync(): Promise<void> {
    if (this.isSyncDisabled()) return;
    this.logger.log("Weekly commodity cache refresh started");
    try {
      await this.syncCommodityMaster("weekly_cron");
    } catch (err) {
      this.logger.error(`Weekly commodity sync failed: ${(err as Error).message}`);
    }
  }

  /**
   * Full replace: DELETE all old commodities + terms, INSERT fresh rows from Agmarknet master option=2.
   */
  async syncCommodityMaster(trigger: "startup" | "weekly_cron" | "manual" = "manual"): Promise<number> {
    if (this.syncInProgress) {
      this.logger.warn(`Commodity sync already in progress — skipping (${trigger})`);
      return 0;
    }
    this.syncInProgress = true;
    try {
      const beforeCount = await this.databaseService.countCommodities();
      this.logger.log(`Commodity sync [${trigger}] — clearing ${beforeCount} old rows`);

      const master = await this.agmarknetApi.fetchMasterData(2);
      const rows = master
        .filter((r) => r?.commodity_id != null && r?.commodity_name)
        .map((r) => ({
          commodity_id: Number(r.commodity_id),
          commodity_name: String(r.commodity_name),
          group_name: r.commodity_group_name ? String(r.commodity_group_name) : undefined,
        }));

      await this.databaseService.replaceCommodityMaster(rows, trigger);
      this.logger.log(
        `Commodity sync [${trigger}] complete — replaced ${beforeCount} → ${rows.length} rows`,
      );
      return rows.length;
    } finally {
      this.syncInProgress = false;
    }
  }

  private isSyncDisabled(): boolean {
    return process.env.COMMODITY_SYNC_ENABLED === "false";
  }
}