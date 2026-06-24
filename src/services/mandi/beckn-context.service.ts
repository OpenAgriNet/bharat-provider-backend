import { Injectable } from "@nestjs/common";
import { AgmarknetApiService } from "./agmarknet-api.service";

export interface MandiLocationIntent {
  commodityName: string;
  lat: number;
  lon: number;
  locationName: string;
  date: string;
}

@Injectable()
export class BecknContextService {
  constructor(private readonly agmarknetApi: AgmarknetApiService) {}

  parseMandiLocationIntent(body: any): MandiLocationIntent | null {
    const intent = body?.message?.intent;
    if (!intent) return null;

    const commodityName = intent?.item?.descriptor?.name?.trim();
    if (!commodityName) return null;

    let lat = 0;
    let lon = 0;
    let locationName = "";

    const endLoc = intent?.fulfillment?.end?.location;
    const stopLoc = intent?.fulfillment?.stops?.[0]?.location;

    const location = endLoc || stopLoc;
    if (location) {
      locationName = location?.descriptor?.name || "";
      if (location.lat != null && location.lon != null) {
        lat = parseFloat(String(location.lat));
        lon = parseFloat(String(location.lon));
      } else if (location.gps) {
        const [latStr, lonStr] = String(location.gps).split(",").map((s) => s.trim());
        lat = parseFloat(latStr) || 0;
        lon = parseFloat(lonStr) || 0;
      }
    }

    const tags: Array<{ code?: string; value?: string }> = intent?.tags || [];
    const dateTag = tags.find((t) => t.code === "date")?.value;
    const stopRange = intent?.fulfillment?.stops?.[0]?.time?.range;
    const dateFromRange = stopRange?.end || stopRange?.start;
    const date = this.agmarknetApi.parseDateTag(dateTag || dateFromRange);

    if (!lat || !lon) return null;

    return { commodityName, lat, lon, locationName, date };
  }

  isNewMandiPayload(body: any): boolean {
    const itemName = body?.message?.intent?.item?.descriptor?.name;
    const commodityCode = body?.message?.intent?.fulfillment?.stops?.[0]?.commoditycode;
    const categoryCode = body?.message?.intent?.category?.descriptor?.code?.toLowerCase();
    return categoryCode === "price-discovery" && !!itemName && commodityCode == null;
  }
}