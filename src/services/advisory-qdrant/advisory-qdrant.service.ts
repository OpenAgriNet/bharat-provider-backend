import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from '../scheme-qdrant/embedding.service';
import { QdrantClientService } from '../scheme-qdrant/qdrant.client';
import { AdvisoryStatus, LocationStatus, buildAdvisoryOnSearch } from './advisory-qdrant.catalog';
import {
  AdvisoryHit,
  dedupeByPop,
  daysInRange,
  hasDayRange,
  parseAdvisoryParams,
  rankHits,
  resolvePreferredSeason,
} from './advisory-qdrant.util';

const FETCH_LIMIT = 40;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

/**
 * Advisory document search over Qdrant (category `knowledge-advisory`).
 * Chunks are written by docs-pipeline with document_kind=advisory; this service embeds the
 * question, searches those chunks, keeps the best chunk per advisory entry and returns a
 * Beckn on_search catalog. Selected by ADVISORY_BACKEND=qdrant in the controller.
 */
@Injectable()
export class AdvisoryQdrantService {
  private readonly logger = new Logger(AdvisoryQdrantService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantClient: QdrantClientService,
  ) {}

  async search(body: any): Promise<any> {
    const context = body?.context || {};
    const txn = context.transaction_id || context.message_id || '-';
    const started = Date.now();
    const params = parseAdvisoryParams(body);
    const { query, crop, district, daysAfterSowing } = params;
    const topK = this.getTopK(params.topK);
    const preferredSeason = resolvePreferredSeason(params.season);

    this.logger.log(
      `[advisory-qdrant] → txn=${txn} query=${JSON.stringify(query)} crop=${crop || '-'} district=${
        district || '-'
      } days=${daysAfterSowing ?? '-'} season=${preferredSeason || '-'} topK=${topK}`,
    );

    const respond = (
      status: AdvisoryStatus,
      results: AdvisoryHit[] = [],
      message = '',
      extra: { locationStatus?: LocationStatus; daysMatched?: boolean } = {},
    ) =>
      buildAdvisoryOnSearch({
        context,
        query,
        results,
        status,
        message,
        locationStatus: extra.locationStatus,
        hasDayRange: results.some(hasDayRange),
        daysMatched: extra.daysMatched,
      });

    if (!query) {
      this.logger.warn(`[advisory-qdrant] ← txn=${txn} status=failed reason=missing_query`);
      return respond('failed', [], 'Missing search query (item.descriptor.name)');
    }
    if (!this.qdrantClient.isConfigured()) {
      this.logger.error(`[advisory-qdrant] ← txn=${txn} status=error reason=qdrant_not_configured`);
      return respond('error', [], 'Advisory search is not available');
    }
    if (!this.embeddingService.isConfigured()) {
      this.logger.error(`[advisory-qdrant] ← txn=${txn} status=error reason=embedding_not_configured`);
      return respond('error', [], 'Advisory search is not available');
    }

    try {
      const vector = await this.embeddingService.embedQuery(query);
      const { hits, locationStatus } = await this.searchWithLocationFallback(vector, crop, district);

      const ranked = rankHits(dedupeByPop(hits), { preferredSeason, daysAfterSowing }).slice(0, topK);
      const status: AdvisoryStatus = ranked.length ? 'success' : 'not_found';
      const finalLocationStatus: LocationStatus =
        district && !ranked.length ? 'no_match' : locationStatus;
      const daysMatched = ranked.some((hit) => daysInRange(hit, daysAfterSowing));
      this.logger.log(
        `[advisory-qdrant] ← txn=${txn} hits=${hits.length} returned=${ranked.length} status=${status} location=${finalLocationStatus} daysMatched=${daysMatched} elapsedMs=${
          Date.now() - started
        }`,
      );
      return respond(status, ranked, ranked.length ? '' : 'No advisory found for this question', {
        locationStatus: finalLocationStatus,
        daysMatched,
      });
    } catch (err: any) {
      this.logger.error(
        `[advisory-qdrant] ← txn=${txn} status=error elapsedMs=${Date.now() - started} err=${err?.message || err}`,
        err?.stack,
      );
      // Detail stays in the server log; callers on the network only get a fixed message.
      return respond('error', [], 'Advisory search failed');
    }
  }

  /**
   * Without a district: one crop-level query. With a district: the district query and the
   * crop-level query run in parallel on the same embedding. District results win when there
   * are any; otherwise the crop-level results are used (`location_not_applied`). A failing
   * district query counts as "no location match" and never fails the request.
   */
  private async searchWithLocationFallback(
    vector: number[],
    crop: string,
    district: string,
  ): Promise<{ hits: AdvisoryHit[]; locationStatus: LocationStatus }> {
    if (!district) {
      const hits = await this.qdrantClient.queryAdvisoryPoints(vector, { limit: FETCH_LIMIT, crop: crop || undefined });
      return { hits, locationStatus: 'not_requested' };
    }

    const [local, general] = await Promise.all([
      this.qdrantClient
        .queryAdvisoryPoints(vector, { limit: FETCH_LIMIT, crop: crop || undefined, district })
        .catch((err: any) => {
          this.logger.warn(`[advisory-qdrant] district query failed, using crop-level results: ${err?.message || err}`);
          return [] as AdvisoryHit[];
        }),
      this.qdrantClient.queryAdvisoryPoints(vector, { limit: FETCH_LIMIT, crop: crop || undefined }),
    ]);
    if (local.length) return { hits: local, locationStatus: 'location_matched' };
    return { hits: general, locationStatus: 'location_not_applied' };
  }

  /** top_k from the request tag when given, else ADVISORY_QDRANT_TOP_K, else 5; clamped to 1..20. */
  private getTopK(requested: number | null): number {
    if (requested !== null && requested > 0) return Math.min(requested, MAX_TOP_K);
    const n = parseInt(process.env.ADVISORY_QDRANT_TOP_K || '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOP_K;
  }
}
