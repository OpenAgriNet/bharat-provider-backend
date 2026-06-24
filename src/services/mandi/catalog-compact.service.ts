import { Injectable } from "@nestjs/common";
import { CommodityRow } from "../weatherforecast/database.service";
import { MandiLocationIntent } from "./beckn-context.service";

export interface CompactPriceRow {
  market: string;
  variety: string;
  modal: number;
  min: number;
  max: number;
  unit: string;
  arrival_date: string;
}

export interface CompactMandiCatalog {
  status?: string;
  query?: string;
  commodity?: string;
  commodity_id?: number;
  group?: string | null;
  location?: string;
  lat?: number;
  lon?: number;
  date?: string;
  options?: Array<{ name: string; commodity_id: number }>;
  message?: string;
  prices: CompactPriceRow[];
}

@Injectable()
export class CatalogCompactService {
  private parsePrice(value: unknown): number {
    const n = parseInt(String(value ?? "0").replace(/,/g, ""), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  compact(
    raw: any[],
    intent: MandiLocationIntent,
    commodity: CommodityRow,
    limit = 5,
  ): CompactMandiCatalog {
    const prices: CompactPriceRow[] = [];
    for (const row of raw.slice(0, limit)) {
      prices.push({
        market: row?.Market ?? "N/A",
        variety: row?.Variety ?? "",
        modal: this.parsePrice(row?.["Modal Price"]),
        min: this.parsePrice(row?.["Min Price"]),
        max: this.parsePrice(row?.["Max Price"]),
        unit: row?.["Price Unit"] ?? "Rs./Qtl",
        arrival_date: row?.["Arrival Date"] ?? intent.date,
      });
    }

    return {
      commodity: commodity.commodity_name,
      commodity_id: commodity.commodity_id,
      group: commodity.group_name,
      location: intent.locationName || `${intent.lat},${intent.lon}`,
      lat: intent.lat,
      lon: intent.lon,
      date: intent.date,
      prices,
      ...(prices.length === 0 ? { status: "no_data" } : {}),
    };
  }

  ambiguous(query: string, options: CommodityRow[]): CompactMandiCatalog {
    return {
      status: "ambiguous",
      query,
      prices: [],
      options: options.map((o) => ({
        name: o.commodity_name,
        commodity_id: o.commodity_id,
      })),
    };
  }

  notFound(query: string): CompactMandiCatalog {
    return {
      status: "not_found",
      query,
      message: `No commodity matching '${query}' in master data`,
      prices: [],
    };
  }
}