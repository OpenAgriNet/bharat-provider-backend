import { Injectable, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../weatherforecast/database.service";
import { LoggerService } from "../logger/logger.service";
import { AgmarknetApiService } from "./agmarknet-api.service";

@Injectable()
export class CommoditySyncService implements OnModuleInit {
  private syncInProgress = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly agmarknetApi: AgmarknetApiService,
    private readonly logger: LoggerService,
  ) {}

  private logCtx(trigger: string): string {
    return `[commoditySync][txn:${trigger}]`;
  }

  async onModuleInit(): Promise<void> {
    if (this.isSyncDisabled()) {
      this.logger.warn(
        "MANDI commodity sync disabled COMMODITY_SYNC_ENABLED=false",
        this.logCtx("startup"),
      );
      return;
    }
    try {
      await this.databaseService.ensureCommodityTables();
      const count = await this.databaseService.countCommodities();
      if (count === 0) {
        this.logger.log(
          "MANDI commodity cache empty starting initial sync",
          this.logCtx("startup"),
        );
        await this.syncCommodityMaster("startup");
      } else {
        this.logger.log(
          `MANDI commodity cache ready rows=${count}`,
          this.logCtx("startup"),
        );
      }
    } catch (err) {
      this.logger.warn(
        `MANDI commodity cache init skipped error=${(err as Error).message}`,
        this.logCtx("startup"),
      );
    }
  }

  /**
   * Weekly refresh: truncate old commodity rows, fetch fresh master from Agmarknet, insert new.
   * Default: every Sunday at 2:00 AM (override with COMMODITY_SYNC_CRON env).
   */
  @Cron(process.env.COMMODITY_SYNC_CRON || CronExpression.EVERY_WEEK)
  async weeklyCommoditySync(): Promise<void> {
    if (this.isSyncDisabled()) return;
    this.logger.log(
      "MANDI weekly commodity cache refresh started",
      this.logCtx("weekly_cron"),
    );
    try {
      await this.syncCommodityMaster("weekly_cron");
    } catch (err) {
      this.logger.error(
        `MANDI weekly commodity sync failed error=${(err as Error).message}`,
        undefined,
        this.logCtx("weekly_cron"),
      );
    }
  }

  /**
   * Full replace: DELETE all old commodities + terms, INSERT fresh rows from Agmarknet master option=2.
   */
  async syncCommodityMaster(trigger: "startup" | "weekly_cron" | "manual" = "manual"): Promise<number> {
    const logCtx = this.logCtx(trigger);
    if (this.syncInProgress) {
      this.logger.warn(
        `MANDI commodity sync already in progress trigger=${trigger}`,
        logCtx,
      );
      return 0;
    }
    this.syncInProgress = true;
    try {
      const beforeCount = await this.databaseService.countCommodities();
      this.logger.log(
        `MANDI commodity sync started trigger=${trigger} clearing_rows=${beforeCount}`,
        logCtx,
      );

      const master = await this.agmarknetApi.fetchMasterData(2, trigger);
      const rows = master
        .filter((r) => r?.commodity_id != null && r?.commodity_name)
        .map((r) => ({
          commodity_id: Number(r.commodity_id),
          commodity_name: String(r.commodity_name),
          group_name: r.commodity_group_name ? String(r.commodity_group_name) : undefined,
        }));

      await this.databaseService.replaceCommodityMaster(rows, trigger);
      this.logger.log(
        `MANDI commodity sync complete trigger=${trigger} replaced=${beforeCount} inserted=${rows.length}`,
        logCtx,
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