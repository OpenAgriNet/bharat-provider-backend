import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { format } from "date-fns";

export interface VistaarLocationParams {
  commodityId: number;
  lat: number;
  lon: number;
  date: string;
  token: string;
}

@Injectable()
export class AgmarknetApiService {
  private readonly logger = new Logger(AgmarknetApiService.name);
  private readonly baseUrl = (
    process.env.AGMARKNET_BASE_URL || process.env.MANDI_BASE_URL || "https://api.agmarknet.gov.in"
  ).replace(/\/$/, "");
  private readonly accessName = process.env.AGMARKNET_ACCESS_NAME;
  private readonly password = process.env.AGMARKNET_PASSWORD;

  async generateToken(): Promise<string> {
    const url = `${this.baseUrl}/v1/generate-dynamic-token-agmarknet`;
    const response = await axios.post(
      url,
      { access_name: this.accessName, password: this.password },
      { timeout: 30000 },
    );
    const token = response.data?.token;
    if (!token) {
      throw new Error("Agmarknet token response missing token field");
    }
    this.logger.log("Agmarknet dynamic token generated");
    return token;
  }

  async fetchMasterData(option = 2): Promise<any[]> {
    const token = await this.generateToken();
    const url = `${this.baseUrl}/v1/fetch-agmarknet-master-data`;
    const response = await axios.get(url, {
      params: { token, option },
      timeout: 30000,
    });
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error(`Master data option=${option} did not return an array`);
    }
    return data;
  }

  async fetchVistaarLocation(params: VistaarLocationParams): Promise<any[]> {
    const url = `${this.baseUrl}/v1/fetch-agmarknet-vistaar-location`;
    const query = new URLSearchParams({
      commodity_id: String(params.commodityId),
      token: params.token,
      date: params.date,
      lat: String(params.lat),
      long: String(params.lon),
    });
    this.logger.log(
      `VISTAAR_LOCATION commodity_id=${params.commodityId} date=${params.date} lat=${params.lat} lon=${params.lon}`,
    );
    const response = await axios.get(`${url}?${query.toString()}`, { timeout: 30000 });
    return this.normalizeRecords(response.data);
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