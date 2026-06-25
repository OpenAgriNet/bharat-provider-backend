import { Injectable } from "@nestjs/common";
import axios, { AxiosError } from "axios";
import { format } from "date-fns";
import { LoggerService } from "../logger/logger.service";

export interface VistaarLocationParams {
  commodityId: number;
  lat: number;
  lon: number;
  date: string;
}

@Injectable()
export class AgmarknetApiService {
  private readonly baseUrl = (
    process.env.AGMARKNET_BASE_URL || ""
  ).replace(/\/$/, "");
  private readonly accessName = process.env.AGMARKNET_ACCESS_NAME;
  private readonly password = process.env.AGMARKNET_PASSWORD;

  /** Cached token — reused across requests until Agmarknet rejects it. */
  private cachedToken: string | null = null;
  private tokenRefreshPromise: Promise<string> | null = null;

  /** Serialize Agmarknet calls so concurrent requests do not race on token refresh. */
  private agmarknetChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly logger: LoggerService) {}

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.agmarknetChain.then(fn, fn);
    this.agmarknetChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertCredentials(): void {
    if (!this.accessName || !this.password) {
      throw new Error(
        "Agmarknet auth not configured: set AGMARKNET_ACCESS_NAME and AGMARKNET_PASSWORD",
      );
    }
  }

  private isTokenRejected(err: unknown): boolean {
    const ax = err as AxiosError<{ error?: string }>;
    const status = ax?.response?.status;
    const msg = String(ax?.response?.data?.error ?? ax?.message ?? "").toLowerCase();
    return (
      status === 403 ||
      msg.includes("token expired") ||
      msg.includes("inactive") ||
      msg.includes("invalid token") ||
      msg.includes("invalid or already used")
    );
  }

  private isNoDataResponse(err: unknown): boolean {
    const ax = err as AxiosError<{ message?: string; success?: boolean }>;
    if (ax?.response?.status !== 400) return false;
    const msg = String(ax?.response?.data?.message ?? "").toLowerCase();
    return msg.includes("no data");
  }

  private async requestNewToken(logCtx: string): Promise<string> {
    this.assertCredentials();
    const url = `${this.baseUrl}/v1/generate-dynamic-token-agmarknet`;
    this.logger.log("MANDI calling Agmarknet generate-dynamic-token", logCtx);

    const response = await axios.post(
      url,
      { access_name: this.accessName, password: this.password },
      { timeout: 30000 },
    );
    const token = response.data?.token;
    if (!token) {
      throw new Error("Agmarknet token response missing token field");
    }
    this.cachedToken = token;
    this.logger.log("MANDI Agmarknet token generated", logCtx);
    return token;
  }

  private invalidateToken(): void {
    this.cachedToken = null;
  }

  /** Return cached token, or fetch a new one. Concurrent callers share one refresh. */
  private async getToken(logCtx: string, forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken) {
      return this.cachedToken;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.requestNewToken(logCtx).finally(() => {
      this.tokenRefreshPromise = null;
    });
    return this.tokenRefreshPromise;
  }

  private async getWithAuth(
    path: string,
    params: Record<string, string>,
    logCtx: string,
    label: string,
  ): Promise<any> {
    return this.runSerialized(async () => {
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const forceRefresh = attempt > 1;
        if (forceRefresh) {
          this.invalidateToken();
          this.logger.warn(`MANDI token expired generating new token attempt=${attempt}`, logCtx);
        }

        const token = await this.getToken(logCtx, forceRefresh);
        const query = new URLSearchParams({ ...params, token });
        const url = `${this.baseUrl}${path}?${query.toString()}`;

        this.logger.log(`MANDI calling ${label} attempt=${attempt}`, logCtx);

        try {
          const response = await axios.get(url, { timeout: 30000 });
          return response.data;
        } catch (err) {
          if (this.isNoDataResponse(err)) {
            this.logger.warn(`MANDI ${label} no data available`, logCtx);
            return [];
          }
          if (this.isTokenRejected(err) && attempt < maxAttempts) {
            this.logger.warn(`MANDI ${label} token rejected will refresh and retry`, logCtx);
            continue;
          }
          throw err;
        }
      }

      throw new Error(`MANDI ${label} failed after token refresh`);
    });
  }

  async fetchMasterData(option = 2, trigger = "sync"): Promise<any[]> {
    const logCtx = `[commoditySync][txn:${trigger}]`;
    const data = await this.getWithAuth(
      "/v1/fetch-agmarknet-master-data",
      { option: String(option) },
      logCtx,
      `master-data option=${option}`,
    );
    if (!Array.isArray(data)) {
      throw new Error(`Master data option=${option} did not return an array`);
    }
    this.logger.log(`MANDI master data fetched rows=${data.length}`, logCtx);
    return data;
  }

  async fetchVistaarLocation(
    params: VistaarLocationParams,
    logCtx: string,
  ): Promise<any[]> {
    const data = await this.getWithAuth(
      "/v1/fetch-agmarknet-vistaar-location",
      {
        commodity_id: String(params.commodityId),
        date: params.date,
        lat: String(params.lat),
        long: String(params.lon),
      },
      logCtx,
      `vistaar-location commodity_id=${params.commodityId} date=${params.date} lat=${params.lat} lon=${params.lon}`,
    );
    const records = this.normalizeRecords(data);
    this.logger.log(`MANDI vistaar-location returned rows=${records.length}`, logCtx);
    return records;
  }

  normalizeRecords(data: any): any[] {
    if (Array.isArray(data)) return data;
    if (data?.data && Array.isArray(data.data)) return data.data;
    if (data?.records && Array.isArray(data.records)) return data.records;
    return [];
  }

  todayDdMmYyyy(): string {
    return format(new Date(), "dd-MM-yyyy");
  }

  parseDateTag(value: string | undefined): string {
    if (!value) return this.todayDdMmYyyy();
    if (/^\d{2}-\d{2}-\d{4}$/.test(value)) return value;
    try {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return format(d, "dd-MM-yyyy");
    } catch {
      /* fall through */
    }
    return this.todayDdMmYyyy();
  }
}