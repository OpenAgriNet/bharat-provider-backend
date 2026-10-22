import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { KhcMasterService, refreshAgeMs } from "./khc-master.service";
import { KhcService, REFERENCES } from "./khc.service";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps the KHC master-data cache warm. Lists are only re-fetched when missing or stale,
 * one parent at a time, and a failed list is skipped (the old rows stay), so a run can
 * be repeated or interrupted safely.
 *   KHC_SYNC_ENABLED=false          turn the jobs off
 *   KHC_SYNC_ON_START=true          run both jobs once in the background at startup
 *   KHC_SYNC_GRIEVANCE_CRON         schemes/categories/sub-categories (default 1st of the month 02:00)
 *   KHC_SYNC_LOCATION_CRON          states..villages (default 1st of the month 03:00)
 *   KHC_VILLAGE_BATCH               sub-districts whose villages are fetched per run (default 1000);
 *                                   the rest fill in on first lookup or on later monthly runs
 *   KHC_SYNC_REFRESH_DAYS           re-fetch lists older than this (default 25, keep below the cron gap)
 *   KHC_SYNC_DELAY_MS               pause between KHC calls (default 100)
 */
@Injectable()
export class KhcMasterSyncService implements OnModuleInit {
  private readonly logger = new Logger(KhcMasterSyncService.name);

  constructor(
    private readonly khc: KhcService,
    private readonly master: KhcMasterService
  ) {}

  onModuleInit(): void {
    if (process.env.KHC_SYNC_ON_START === "true") {
      // Wait for KhcMasterService.onModuleInit to finish before using the DB.
      setTimeout(() => {
        void this.syncGrievanceTree().then(() => this.syncLocationTree());
      }, 5000);
    }
  }

  @Cron(process.env.KHC_SYNC_GRIEVANCE_CRON || "0 0 2 1 * *")
  async grievanceCron(): Promise<void> {
    await this.syncGrievanceTree();
  }

  @Cron(process.env.KHC_SYNC_LOCATION_CRON || "0 0 3 1 * *")
  async locationCron(): Promise<void> {
    await this.syncLocationTree();
  }

  /** states -> schemes -> categories -> sub-categories */
  async syncGrievanceTree(): Promise<void> {
    await this.run("grievance", async (pull) => {
      await pull("states", 0, true);
      for (const stateId of await this.master.staleParents("states", "schemes", 1000)) {
        await pull("schemes", stateId);
      }
      for (const schemeId of await this.master.staleParents("schemes", "categories", 1000)) {
        await pull("categories", schemeId);
      }
      for (const categoryId of await this.master.staleParents("categories", "sub-categories", 2000)) {
        await pull("sub-categories", categoryId);
      }
    });
  }

  /** states -> districts -> sub-districts -> villages (villages in batches) */
  async syncLocationTree(): Promise<void> {
    await this.run("location", async (pull) => {
      const batch = Math.max(1, parseInt(process.env.KHC_VILLAGE_BATCH || "1000", 10) || 1000);
      await pull("states", 0, true);
      for (const stateId of await this.master.staleParents("states", "districts", 1000)) {
        await pull("districts", stateId);
      }
      for (const districtId of await this.master.staleParents("districts", "sub-districts", 5000)) {
        await pull("sub-districts", districtId);
      }
      for (const subDistrictId of await this.master.staleParents("sub-districts", "villages", batch)) {
        await pull("villages", subDistrictId);
      }
    });
  }

  private async run(
    name: string,
    job: (pull: (kind: string, parentId: number, skipIfFresh?: boolean) => Promise<void>) => Promise<void>
  ): Promise<void> {
    if (process.env.KHC_SYNC_ENABLED === "false" || !this.master.isReady()) return;
    const release = await this.master.lockSync();
    if (!release) {
      this.logger.log(`KHC ${name} sync skipped: another run holds the lock`);
      return;
    }
    const delay = parseInt(process.env.KHC_SYNC_DELAY_MS || "100", 10) || 0;
    let fetched = 0;
    let failed = 0;
    const started = Date.now();
    const pull = async (kind: string, parentId: number, skipIfFresh = false) => {
      if (skipIfFresh && (await this.master.isFresh(kind, parentId, refreshAgeMs()))) return;
      try {
        const rows = await this.khc.fetchReferenceRows(kind, parentId || undefined);
        const reference = REFERENCES[kind];
        await this.master.store(kind, parentId, reference.id, reference.name, rows);
        fetched += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `KHC ${name} sync: ${kind} parent=${parentId} failed: ${(error as Error).message}`
        );
      }
      if (delay) await sleep(delay);
    };
    this.logger.log(`KHC ${name} sync started`);
    try {
      await job(pull);
    } catch (error) {
      this.logger.error(`KHC ${name} sync aborted: ${(error as Error).message}`);
    } finally {
      await release();
      this.logger.log(
        `KHC ${name} sync finished lists=${fetched} failed=${failed} seconds=${Math.round((Date.now() - started) / 1000)}`
      );
    }
  }
}
