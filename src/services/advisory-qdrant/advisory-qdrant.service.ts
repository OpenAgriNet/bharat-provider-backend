import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from '../scheme-qdrant/embedding.service';
import { QdrantClientService } from '../scheme-qdrant/qdrant.client';
import { AdvisoryStatus, buildAdvisoryOnSearch } from './advisory-qdrant.catalog';
import { dedupeByPop } from './advisory-qdrant.util';

const FETCH_LIMIT = 40;
const DEFAULT_TOP_K = 5;

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
    const query = String(body?.message?.intent?.item?.descriptor?.name || '').trim();
    const topK = this.getTopK();

    this.logger.log(`[advisory-qdrant] → txn=${txn} query=${JSON.stringify(query)} topK=${topK}`);

    const respond = (status: AdvisoryStatus, results: any[] = [], message = '') =>
      buildAdvisoryOnSearch({ context, query, results, status, message });

    if (!query) {
      this.logger.warn(`[advisory-qdrant] ← txn=${txn} status=failed reason=missing_query`);
      return respond('failed', [], 'Missing search query (item.descriptor.name)');
    }
    if (!this.qdrantClient.isConfigured()) {
      this.logger.error(`[advisory-qdrant] ← txn=${txn} status=error reason=qdrant_not_configured`);
      return respond('error', [], 'Qdrant is not configured on the provider');
    }
    if (!this.embeddingService.isConfigured()) {
      this.logger.error(`[advisory-qdrant] ← txn=${txn} status=error reason=embedding_not_configured`);
      return respond('error', [], 'Embedding is not configured on the provider');
    }

    try {
      const vector = await this.embeddingService.embedQuery(query);
      const hits = await this.qdrantClient.queryAdvisoryPoints(vector, { limit: FETCH_LIMIT });
      const results = dedupeByPop(hits).slice(0, topK);
      const status: AdvisoryStatus = results.length ? 'success' : 'not_found';
      this.logger.log(
        `[advisory-qdrant] ← txn=${txn} hits=${hits.length} returned=${results.length} status=${status} elapsedMs=${
          Date.now() - started
        }`,
      );
      return respond(status, results, results.length ? '' : 'No advisory found for this question');
    } catch (err: any) {
      this.logger.error(
        `[advisory-qdrant] ← txn=${txn} status=error elapsedMs=${Date.now() - started} err=${err?.message || err}`,
        err?.stack,
      );
      return respond('error', [], err?.message || 'Advisory search failed');
    }
  }

  private getTopK(): number {
    const n = parseInt(process.env.ADVISORY_QDRANT_TOP_K || '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOP_K;
  }
}
