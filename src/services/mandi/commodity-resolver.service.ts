import { Injectable } from "@nestjs/common";
import { CommodityRow, DatabaseService } from "../weatherforecast/database.service";

export type CommodityResolveResult =
  | { status: "resolved"; commodity: CommodityRow }
  | { status: "ambiguous"; query: string; options: CommodityRow[] }
  | { status: "not_found"; query: string };

@Injectable()
export class CommodityResolverService {
  constructor(private readonly databaseService: DatabaseService) {}

  async resolve(name: string): Promise<CommodityResolveResult> {
    const query = name.trim();
    if (!query) return { status: "not_found", query };

    const exact = await this.databaseService.findCommodityExact(query);
    if (exact) return { status: "resolved", commodity: exact };

    const byTerm = await this.databaseService.findCommodityByTerm(query);
    if (byTerm) return { status: "resolved", commodity: byTerm };

    const partial = await this.databaseService.findCommoditiesPartial(query, 5);
    if (partial.length === 1) return { status: "resolved", commodity: partial[0] };
    if (partial.length > 1) {
      return { status: "ambiguous", query, options: partial.slice(0, 3) };
    }

    return { status: "not_found", query };
  }
}