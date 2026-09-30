import { Injectable } from "@nestjs/common";
import { LoggerService } from "../logger/logger.service";
import { AgmarknetApiService } from "./agmarknet-api.service";

interface MarketPoint {
  name: string;
  district: string;
  state: string;
  lat: number;
  lon: number;
}

/**
 * In-memory Agmarknet market master (option=6), used only to put a distance on the
 * mandi vistaar-location falls back to. ~4k rows, refreshed daily; a failed load
 * just means no distance is reported.
 */
@Injectable()
export class MarketMasterService {
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;

  private markets: MarketPoint[] | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly agmarknetApi: AgmarknetApiService,
    private readonly logger: LoggerService,
  ) {}

  private key(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
  }

  private async ensureLoaded(logCtx: string): Promise<void> {
    if (this.markets && Date.now() - this.loadedAt < MarketMasterService.TTL_MS) return;
    if (!this.loading) {
      this.loading = this.agmarknetApi
        .fetchMasterData(6, "market_master")
        .then((rows) => {
          this.markets = rows
            .map((r) => ({
              name: this.key(r?.market_name),
              district: this.key(r?.district_name),
              state: this.key(r?.state_name),
              lat: parseFloat(r?.market_latitude),
              lon: parseFloat(r?.market_longitude),
            }))
            .filter((m) => m.name && Number.isFinite(m.lat) && Number.isFinite(m.lon));
          this.loadedAt = Date.now();
          this.logger.log(`MANDI market master loaded rows=${this.markets.length}`, logCtx);
        })
        .catch((err) => {
          this.logger.warn(
            `MANDI market master load failed error=${(err as Error).message}`,
            logCtx,
          );
        })
        .finally(() => {
          this.loading = null;
        });
    }
    await this.loading;
  }

  /** Coordinates of a market by name; district/state break ties between same-named markets. */
  async findCoordinates(
    market: string | undefined,
    district: string | undefined,
    state: string | undefined,
    logCtx: string,
  ): Promise<{ lat: number; lon: number } | null> {
    if (!market) return null;
    await this.ensureLoaded(logCtx);
    const candidates = (this.markets ?? []).filter((m) => m.name === this.key(market));
    const best =
      candidates.find(
        (m) => m.district === this.key(district) && m.state === this.key(state),
      ) ??
      candidates.find((m) => m.district === this.key(district)) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    return best ? { lat: best.lat, lon: best.lon } : null;
  }
}
