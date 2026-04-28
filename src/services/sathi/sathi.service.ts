import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { DatabaseService } from "../weatherforecast/database.service";

@Injectable()
export class SathiService {
  private readonly logger = new Logger(SathiService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  private getBaseUrl(): string {
    return (
      this.configService.get<string>("SATHI_SEED_BASE_URL") ||
      process.env.SATHI_SEED_BASE_URL
    );
  }

  private getApiKey(): string {
    return (
      this.configService.get<string>("SATHI_API_KEY") ||
      process.env.SATHI_API_KEY
    );
  }

  /**
   * Helper: read a flat tag value by code from item.tags.
   * Each tag has `descriptor.code` and a top-level `value`.
   */
  private getTagValue(tags: any[], code: string): string {
    return (
      tags?.find((tag: any) => tag?.descriptor?.code === code)?.value ?? ""
    );
  }

  async getSeedAvailability(body: any): Promise<any> {
    const context = body?.context;
    const intent = body?.message?.intent;
    const itemTags: any[] = intent?.item?.tags ?? [];

    // ── Extract fields from intent.item.tags ─────────────────────────────
    const cropCode = this.getTagValue(itemTags, "crop_code");
    const stateCodeFromPayload = this.getTagValue(itemTags, "state_code");
    const districtCodeFromPayload = this.getTagValue(itemTags, "district_code");

    // ── Extract lat/lon from the location tag inside item.tags ────────────
    const locationTag = itemTags.find((tag: any) => tag?.location);
    const lat: number = locationTag?.location?.lat ?? null;
    const lon: number = locationTag?.location?.lon ?? null;

    this.logger.log(
      `[SATHI] cropCode=${cropCode}, stateCode=${stateCodeFromPayload}, districtCode=${districtCodeFromPayload}, lat=${lat}, lon=${lon}`,
    );

    // ── Step 1: DB lookup for nearest district via lat/lon ────────────────
    let stateCode = stateCodeFromPayload;
    let districtCode = districtCodeFromPayload;
    let dbStateName = "";
    let dbDistrictName = "";

    if (lat !== null && lon !== null) {
      try {
        const nearest = await this.databaseService.findSathiNearestDistrict(
          lat,
          lon,
        );
        if (nearest) {
          this.logger.log(
            `[SATHI] DB nearest district: state=${nearest.state_name}(${nearest.state_code}), district=${nearest.district_name}(${nearest.district_lgd_code})`,
          );
          dbStateName = nearest.state_name;
          dbDistrictName = nearest.district_name;
          // Use DB-resolved codes only if payload did not supply them
          if (!stateCode) stateCode = nearest.state_code;
          if (!districtCode) districtCode = nearest.district_lgd_code;
        }
      } catch (err) {
        this.logger.warn(
          `[SATHI] DB lookup failed, falling back to payload codes. Error: ${err.message}`,
        );
      }
    }

    // ── Step 2: Call Sathi seed availability API ──────────────────────────
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();

    let apiData: any[] = [];
    let apiStatus = "Failed";
    let apiMessage = "";

    try {
      const response = await axios.request({
        method: "post",
        url: `${baseUrl}/inv-apis/stock/getSeedAvailability`,
        headers: { "Content-Type": "application/json" },
        data: {
          cropCode,
          seedClass: "CERTIFIED I",
          stateCode,
          districtCode,
          apiKey,
        },
        timeout: 15000,
      });

      this.logger.log(
        `[SATHI] API response status: ${response.data?.statusCode}, message: ${response.data?.message}`,
      );

      apiData = response.data?.data ?? [];
      apiStatus =
        response.data?.statusCode === 200 ? "Success" : "Failed";
      apiMessage = response.data?.message ?? "";
    } catch (error) {
      this.logger.error(
        `[SATHI] API call failed: ${error.message}`,
        error.response?.data ?? "",
      );
      apiMessage = error.message;
    }

    // ── Step 3: Build Beckn on_search catalog ────────────────────────────
    const providers = apiData.map((seed: any) => {
      const dealers = seed.available_at ?? [];
      return {
        id: seed.variety_id ?? "",
        descriptor: {
          name: seed.variety_name ?? "",
          code: seed.variety_id ?? "",
        },
        items: [
          {
            id: seed.lot_number ?? "",
            descriptor: {
              name: seed.crop_name ?? "",
              code: seed.crop_id ?? "",
            },
            tags: [
              {
                descriptor: { code: "seed-details", name: "Seed Details" },
                list: [
                  {
                    descriptor: { code: "lot-number", name: "Lot Number" },
                    value: seed.lot_number ?? "",
                  },
                  {
                    descriptor: {
                      code: "bag-weight-kg",
                      name: "Bag Weight (kg)",
                    },
                    value: String(seed.bag_weight_kg ?? ""),
                  },
                  {
                    descriptor: { code: "seed-class", name: "Seed Class" },
                    value: seed.seed_class ?? "",
                  },
                  {
                    descriptor: { code: "crop-id", name: "Crop ID" },
                    value: seed.crop_id ?? "",
                  },
                  {
                    descriptor: { code: "crop-name", name: "Crop Name" },
                    value: seed.crop_name ?? "",
                  },
                  {
                    descriptor: {
                      code: "total-bags",
                      name: "Total Bags Available",
                    },
                    value: String(seed.total_bags ?? ""),
                  },
                  {
                    descriptor: {
                      code: "total-quintals",
                      name: "Total Quintals Available",
                    },
                    value: String(seed.total_quintals ?? ""),
                  },
                ],
              },
              {
                descriptor: {
                  code: "dealer-list",
                  name: "Available Dealers",
                },
                list: dealers.map((dealer: any) => ({
                  descriptor: {
                    code: dealer.dealer_id ?? "",
                    name: dealer.dealer_name ?? "",
                  },
                  value: JSON.stringify({
                    dealer_id: dealer.dealer_id,
                    dealer_name: dealer.dealer_name,
                    district: dealer.district,
                    state: dealer.state,
                    contact_number: dealer.contact_number,
                    bags: dealer.bags,
                    quintals: dealer.quintals,
                  }),
                })),
              },
            ],
          },
        ],
      };
    });

    return {
      context: {
        ...context,
        action: "on_search",
        timestamp: new Date().toISOString(),
      },
      message: {
        catalog: {
          descriptor: {
            name: "Sathi Seed Availability",
            code: "sathi-seed",
          },
          tags: [
            {
              descriptor: {
                code: "search-context",
                name: "Search Context",
              },
              list: [
                {
                  descriptor: { code: "status", name: "Status" },
                  value: apiStatus,
                },
                {
                  descriptor: { code: "message", name: "Message" },
                  value: apiMessage,
                },
                {
                  descriptor: { code: "crop-code", name: "Crop Code" },
                  value: cropCode,
                },
                {
                  descriptor: { code: "state-code", name: "State Code" },
                  value: stateCode,
                },
                {
                  descriptor: {
                    code: "district-code",
                    name: "District Code",
                  },
                  value: districtCode,
                },
                {
                  descriptor: { code: "state-name", name: "State Name" },
                  value: dbStateName,
                },
                {
                  descriptor: {
                    code: "district-name",
                    name: "District Name",
                  },
                  value: dbDistrictName,
                },
              ],
            },
          ],
          providers,
        },
      },
    };
  }
}
