import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { format } from "date-fns";

export interface AgmarknetVistaarLocationParams {
  commodity_id: string;
  token: string;
  date: string;
  lat: string;
  long: string;
}

@Injectable()
export class MandiService {
  private readonly logger = new Logger(MandiService.name);
  private readonly baseUrl = process.env.MANDI_BASE_URL;
  private readonly accessName = process.env.MANDI_ACCESS_NAME;
  private readonly password = process.env.MANDI_PASSWORD;
  private readonly token = process.env.MANDI_TOKEN;

  /**
   * Generate token from AGMARKNET QA API.
   */
  private async generateDynamicToken(): Promise<string> {
    if (!this.accessName || !this.password) {
      if (this.token) {
        this.logger.warn(
          "MANDI_TOKEN_GENERATION_SKIPPED reason=missing_access_credentials fallback=MANDI_TOKEN"
        );
        return this.token;
      }
      throw new Error("Missing MANDI_ACCESS_NAME or MANDI_PASSWORD");
    }

    const url = `${this.baseUrl}/v1/generate-dynamic-token-agmarknet`;
    const payload = {
      access_name: this.accessName,
      password: this.password,
    };

    try {
      this.logger.log(`MANDI_TOKEN_REQUEST method=POST url=${url}`);
      const response = await axios.post(url, payload, {
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      });
      const generatedToken = String(response?.data?.token || "").trim();
      if (!generatedToken) {
        throw new Error("Token missing in generate-dynamic-token-agmarknet response");
      }
      this.logger.log(
        `MANDI_TOKEN_RESPONSE status=${response.status} token_length=${generatedToken.length}`
      );
      return generatedToken;
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const msg = typeof body === "object" ? JSON.stringify(body) : body ?? err.message;
      this.logger.warn(`MANDI_TOKEN_ERROR status=${status ?? "unknown"} message=${msg}`);
      if (this.token) {
        this.logger.warn("MANDI_TOKEN_FALLBACK source=MANDI_TOKEN");
        return this.token;
      }
      throw err;
    }
  }

  /**
   * Call AGMARKNET location API: GET /v1/fetch-agmarknet-vistaar-location
   */
  async fetchAgmarknetVistaarLocation(params: AgmarknetVistaarLocationParams): Promise<any> {
    const url = `${this.baseUrl}/v1/fetch-agmarknet-vistaar-location`;
    const queryParams = new URLSearchParams({
      commodity_id: params.commodity_id,
      token: params.token,
      date: params.date,
      lat: params.lat,
      long: params.long,
    });
    const requestKey = this.getApiRequestKey(params);
    const query = queryParams.toString();
    this.logger.log(`MANDI_API_REQUEST key=${requestKey} method=GET url=${url}?${query}`);

    try {
      const response = await axios.get(`${url}?${query}`, { timeout: 15000 });
      const data = response.data;
      const records = this.normalizeApiRecords(data);
      const sample = records[0] ? JSON.stringify(records[0]).slice(0, 500) : "";
      this.logger.log(
        `MANDI_API_RESPONSE key=${requestKey} status=${response.status} records=${records.length} sample=${sample || "none"}`
      );
      return data;
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const msg = typeof body === "object" ? JSON.stringify(body) : body ?? err.message;
      this.logger.warn(`MANDI_API_ERROR key=${requestKey} status=${status ?? "unknown"} message=${msg}`);
      throw err;
    }
  }

  private getApiRequestKey(params: AgmarknetVistaarLocationParams): string {
    return [
      `lat=${params.lat || "NA"}`,
      `lon=${params.long || "NA"}`,
      `commodity=${params.commodity_id || "NA"}`,
      `date=${params.date || "NA"}`,
    ].join("|");
  }

  /**
   * Parse ISO date to dd-MM-yyyy for Agmarknet API.
   */
  private parseDateForApi(isoDate: string): string {
    try {
      const d = new Date(isoDate);
      if (Number.isNaN(d.getTime())) return format(new Date(), "dd-MM-yyyy");
      return format(d, "dd-MM-yyyy");
    } catch {
      return format(new Date(), "dd-MM-yyyy");
    }
  }

  private parseDdMmYyyyToDate(dateStr: string): Date | null {
    if (!dateStr) return null;
    const parts = dateStr.split("-");
    if (parts.length !== 3) return null;
    const day = Number(parts[0]);
    const month = Number(parts[1]);
    const year = Number(parts[2]);
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
    const d = new Date(year, month - 1, day);
    if (
      Number.isNaN(d.getTime()) ||
      d.getDate() !== day ||
      d.getMonth() !== month - 1 ||
      d.getFullYear() !== year
    ) {
      return null;
    }
    return d;
  }

  /**
   * Normalize Agmarknet Vistaar API response to an array of price records.
   */
  private normalizeApiRecords(apiData: any): any[] {
    if (Array.isArray(apiData)) return apiData;
    if (apiData?.data && Array.isArray(apiData.data)) return apiData.data;
    if (apiData?.records && Array.isArray(apiData.records)) return apiData.records;
    if (apiData?.result && Array.isArray(apiData.result)) return apiData.result;
    if (apiData?.results && Array.isArray(apiData.results)) return apiData.results;
    if (apiData && typeof apiData === "object") return [apiData];
    return [];
  }

  private pickFirst(rec: any, keys: string[]): string {
    for (const key of keys) {
      const value = rec?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value);
      }
    }
    return "N/A";
  }

  /**
   * Build Beckn on_search catalog from location API results.
   */
  private buildMandiCatalog(
    records: any[],
    lat: number,
    lon: number,
  ): { descriptor: { name: string }; providers: any[] } {
    const items: any[] = [];
    let itemId = 0;

    for (const rec of records) {
      itemId += 1;
      const state = this.pickFirst(rec, ["State", "state", "state_name"]);
      const district = this.pickFirst(rec, ["District", "district", "district_name"]);
      const market = this.pickFirst(rec, ["Market", "market", "market_name"]);
      const commodity = this.pickFirst(rec, ["Commodity", "commodity", "commodity_name"]);
      const grade = this.pickFirst(rec, ["Grade", "grade"]);
      const group = this.pickFirst(rec, ["Group", "group"]);
      const variety = this.pickFirst(rec, ["Variety", "variety"]);

      const tags: any[] = [
        { descriptor: { code: "State" }, value: state },
        { descriptor: { code: "District" }, value: district },
        { descriptor: { code: "Market" }, value: market },
        { descriptor: { code: "Commodity" }, value: commodity },
        {
          descriptor: { code: "Modal Price" },
          value: this.pickFirst(rec, ["Modal Price", "modal_price", "modalPrice"]),
        },
        {
          descriptor: { code: "Min Price" },
          value: this.pickFirst(rec, ["Min Price", "min_price", "minPrice"]),
        },
        {
          descriptor: { code: "Max Price" },
          value: this.pickFirst(rec, ["Max Price", "max_price", "maxPrice"]),
        },
        {
          descriptor: { code: "Price Unit" },
          value: this.pickFirst(rec, ["Price Unit", "price_unit", "priceUnit"]),
        },
        {
          descriptor: { code: "Arrival Date" },
          value: this.pickFirst(rec, ["Arrival Date", "arrival_date", "arrivalDate", "date"]),
        },
      ];
      if (grade !== "N/A") tags.push({ descriptor: { code: "Grade" }, value: grade });
      if (group !== "N/A") tags.push({ descriptor: { code: "Group" }, value: group });
      if (variety !== "N/A") tags.push({ descriptor: { code: "Variety" }, value: variety });

      items.push({
        id: `mandi-${itemId}`,
        descriptor: {
          name: `${commodity} - ${market}`,
          short_desc: `${commodity} at ${market}, ${district}, ${state}`,
          images: [],
        },
        matched: true,
        category_ids: ["mandi-price"],
        fulfillment_ids: ["mandi-f1"],
        tags: [{ descriptor: { code: "price-info" }, list: tags }],
      });
    }

    if (items.length === 0) {
      return {
        descriptor: { name: "Mandi Price Discovery" },
        providers: [],
      };
    }

    const provider = {
      id: "mandi-price-discovery",
      descriptor: {
        name: "Mandi Price Discovery",
        short_desc: "Agmarknet Vistaar mandi prices for location",
        images: [],
      },
      categories: [
        { id: "mandi-price", descriptor: { code: "mandi", name: "Mandi Price Discovery" } },
      ],
      fulfillments: [
        {
          id: "mandi-f1",
          stops: [{ location: { lat: String(lat), lon: String(lon) } }],
        },
      ],
      items,
    };

    return {
      descriptor: { name: "Mandi Price Discovery" },
      providers: [provider],
    };
  }

  /**
   * Mandi search: requires fulfillment.stops[0] with location (lat, lon), time.range (start, end), and commoditycode.
   * Calls AGMARKNET token + location APIs and returns on_search catalog.
   */
  async mandiSearch(body: {
    context: any;
    message?: {
      intent?: {
        fulfillment?: {
          stops?: Array<{
            location?: { lat?: string; lon?: string; gps?: string };
            time?: { range?: { start?: string; end?: string } };
            commoditycode?: number;
          }>;
        };
      };
    };
  }): Promise<{ context: any; message?: any }> {
    const intent = body?.message?.intent;
    const fulfillment = intent?.fulfillment;
    const stop = fulfillment?.stops?.[0];
    let lat = 0;
    let lon = 0;

    if (stop?.location) {
      const location = stop.location;
      if (location.lat != null && location.lon != null) {
        lat = parseFloat(String(location.lat));
        lon = parseFloat(String(location.lon));
      } else if (location.gps) {
        const [latStr, lonStr] = (location.gps as string).split(",").map((s: string) => s.trim());
        lat = parseFloat(latStr) || 0;
        lon = parseFloat(lonStr) || 0;
      }
    }

    const timeRange = stop?.time?.range;
    const startStr = timeRange?.start;
    const endStr = timeRange?.end;
    let fromDate = startStr ? this.parseDateForApi(startStr) : "";
    let toDate = endStr ? this.parseDateForApi(endStr) : "";

    const commoditycode = stop?.commoditycode;
    const commoditycodeStr =
      commoditycode !== undefined && commoditycode !== null ? String(commoditycode) : "";

    const onSearchContext = { ...body.context, action: "on_search" };
    const emptyCatalog = () => ({
      context: onSearchContext,
      message: {
        catalog: {
          descriptor: { name: "Mandi Price Discovery" },
          providers: [],
        },
      },
    });

    if (!lat || !lon) {
      this.logger.warn("Mandi search: missing required location (lat, lon) in fulfillment.stops[0].location");
      return emptyCatalog();
    }
    if (!fromDate || !toDate) {
      this.logger.warn("Mandi search: missing required time.range.start or time.range.end in fulfillment.stops[0]");
      return emptyCatalog();
    }
    if (commoditycodeStr === "") {
      this.logger.warn("Mandi search: missing required commoditycode (number) in fulfillment.stops[0]");
      return emptyCatalog();
    }

    const fromDateObj = this.parseDdMmYyyyToDate(fromDate);
    const toDateObj = this.parseDdMmYyyyToDate(toDate);
    if (fromDateObj && toDateObj && fromDateObj.getTime() > toDateObj.getTime()) {
      this.logger.warn(
        `MANDI_DATE_RANGE_SWAPPED reason=from_gt_to original_from=${fromDate} original_to=${toDate}`
      );
      const temp = fromDate;
      fromDate = toDate;
      toDate = temp;
    }
    const apiDate = toDate || fromDate;

    try {
      let records: any[] = [];
      try {
        const token = await this.generateDynamicToken();
        const params: AgmarknetVistaarLocationParams = {
          commodity_id: commoditycodeStr,
          token,
          date: apiDate,
          lat: String(lat),
          long: String(lon),
        };
        const apiData = await this.fetchAgmarknetVistaarLocation(params);
        records = this.normalizeApiRecords(apiData);
      } catch (err: any) {
        this.logger.warn(`MANDI_LOCATION_API_CALL_FAILED message=${err?.message || "unknown"}`);
      }

      this.logger.log(
        `MANDI_LOCATION_API_RECORDS lat=${lat} lon=${lon} commodity=${commoditycodeStr} date=${apiDate} records=${records.length}`
      );

      const catalog = this.buildMandiCatalog(records, lat, lon);
      return {
        context: onSearchContext,
        message: { catalog },
      };
    } catch (err) {
      this.logger.error("Mandi search failed", err);
      throw err;
    }
  }
}
