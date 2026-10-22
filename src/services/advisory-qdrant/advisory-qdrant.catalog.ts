import { AdvisoryHit, formatSource } from './advisory-qdrant.util';

export type AdvisoryStatus = 'success' | 'not_found' | 'failed' | 'error';

export interface BuildAdvisoryCatalogOptions {
  context: any;
  query: string;
  results: AdvisoryHit[];
  status: AdvisoryStatus;
  message?: string;
}

const CATEGORY_CODE = 'knowledge-advisory';

function tag(code: string, name: string, value: string) {
  return { descriptor: { code, name }, value, display: true };
}

/**
 * Build the Beckn on_search catalog for knowledge-advisory from Qdrant advisory chunks.
 * One item per chunk, `chunk-details` tags: title, crop, section, score, doc_id, chunk_id,
 * source, text. `text` is the stored chunk text followed by a "Source:" line.
 */
export function buildAdvisoryOnSearch(options: BuildAdvisoryCatalogOptions) {
  const { context, query, results, status, message = '' } = options;

  const items = results.map((hit, index) => {
    const source = formatSource(hit.institute, hit.creator);
    const text = source ? `${hit.text}\n\nSource: ${source}` : hit.text;
    const score = Number(hit.score) || 0;
    const id = hit.chunk_id || `${hit.doc_id || 'doc'}:${index}`;
    return {
      id,
      descriptor: {
        name: hit.title || 'Advisory',
        code: hit.section,
        short_desc: `section=${hit.section} score=${score.toFixed(4)}`,
        long_desc: text,
      },
      tags: [
        {
          display: true,
          descriptor: { code: 'chunk-details', name: 'Chunk Details' },
          list: [
            tag('title', 'Title', hit.title),
            tag('crop', 'Crop', hit.crop),
            tag('section', 'Section', hit.section),
            tag('score', 'Score', score.toFixed(4)),
            tag('doc_id', 'Document ID', hit.doc_id),
            tag('chunk_id', 'Chunk ID', hit.chunk_id),
            tag('source', 'Source', source),
            tag('text', 'Text', text),
          ],
        },
      ],
    };
  });

  const providers =
    items.length > 0
      ? [
          {
            id: 'advisory-documents',
            descriptor: {
              name: 'Advisory Documents',
              short_desc: 'Qdrant-backed crop advisory chunks',
              code: CATEGORY_CODE,
            },
            items,
          },
        ]
      : [];

  return {
    context: { ...context, action: 'on_search', timestamp: new Date().toISOString() },
    message: {
      catalog: {
        descriptor: { name: 'Advisory Search', code: CATEGORY_CODE },
        tags: [
          {
            descriptor: { code: 'search-context', name: 'Search Context' },
            list: [
              { descriptor: { code: 'query', name: 'Query' }, value: query || '' },
              { descriptor: { code: 'status', name: 'Status' }, value: status },
              { descriptor: { code: 'message', name: 'Message' }, value: message },
              { descriptor: { code: 'hit-count', name: 'Hit Count' }, value: String(items.length) },
              { descriptor: { code: 'search-backend', name: 'Search Backend' }, value: 'qdrant' },
            ],
          },
        ],
        providers,
      },
    },
  };
}
