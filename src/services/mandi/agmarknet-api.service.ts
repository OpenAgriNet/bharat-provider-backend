import { Injectable } from "@nestjs/common";
import axios from "axios";
import { format } from "date-fns";
import { LoggerService } from "../logger/logger.service";

export interface VistaarLocationParams {
  commodityId: number;
  lat: number;
  lon: number;
  date: string;
  token: string;
}

@Injectable()
export class AgmarknetApiService {
  private readonly baseUrl = (
    process.env.AGMARKNET_BASE_URL || process.env.MANDI_BASE_URL || "https://api.agmarknet.gov.in"
  ).replace(/\/$/, "");
  private readonly accessName = process.env.AGMARKNET_ACCESS_NAME;
  private readonly password = process.env.AGMARKNET_PASSWORD;

  constructor(private readonly logger: LoggerService) {}

  async generateToken(logCtx: string): Promise<string> {
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
    this.logger.log("MANDI Agmarknet token generated", logCtx);
    return token;
  }

  async fetchMasterData(option = 2, trigger = "sync"): Promise<any[]> {
    const logCtx = `[commoditySync][txn:${trigger}]`;
    const token = await this.generateToken(logCtx);
    const url = `${this.baseUrl}/v1/fetch-agmarknet-master-data`;
    this.logger.log(`MANDI fetching master data option=${option}`, logCtx);

    const response = await axios.get(url, {
      params: { token, option },
      timeout: 30000,
    });
    const data = response.data;
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
    const url = `${this.baseUrl}/v1/fetch-agmarknet-vistaar-location`;
    const query = new URLSearchParams({
      commodity_id: String(params.commodityId),
      token: params.token,
      date: params.date,
      lat: String(params.lat),
      long: String(params.lon),
    });
    this.logger.log(
      `MANDI calling vistaar-location commodity_id=${params.commodityId} date=${params.date} lat=${params.lat} lon=${params.lon}`,
      logCtx,
    );

    const response = await axios.get(`${url}?${query.toString()}`, { timeout: 30000 });
    const records = this.normalizeRecords(response.data);
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