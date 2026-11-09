import { AdvisoryHit, formatSource, isNational } from './advisory-qdrant.util';

export type AdvisoryStatus = 'success' | 'not_found' | 'failed' | 'error';

/**
 * How the farmer's place (state / district LGD codes) was handled:
 * - `not_requested`: no place was sent
 * - `location_matched`: at least one advisory covers the farmer's district or state
 * - `location_partial`: the farmer gave a state and the best advisories cover some districts of it
 * - `location_not_applied`: a place was sent but the advisories returned are not tied to a place
 *   (they apply everywhere)
 * - `other_only`: a place was sent and every returned advisory is meant for other places
 * - `no_match`: a place was sent and nothing was found at all
 */
export type LocationStatus =
  | 'not_requested'
  | 'location_matched'
  | 'location_partial'
  | 'location_not_applied'
  | 'other_only'
  | 'no_match';

export interface BuildAdvisoryCatalogOptions {
  context: any;
  query: string;
  results: AdvisoryHit[];
  status: AdvisoryStatus;
  message?: string;
  locationStatus?: LocationStatus;
  /** True when at least one returned advisory has a days-after-sowing range. */
  hasDayRange?: boolean;
  /** True when a days-after-sowing value was sent and a returned advisory's range contains it. */
  daysMatched?: boolean;
  /** True when at least one returned advisory is tied to particular states or districts. */
  hasLocationSpecific?: boolean;
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
  const {
    context,
    query,
    results,
    status,
    message = '',
    locationStatus = 'not_requested',
    hasDayRange = false,
    daysMatched = false,
    hasLocationSpecific = false,
  } = options;

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
            tag('origin', 'Origin', hit.origin),
            tag('text', 'Text', text),
            tag('location-match', 'Location Match', hit.location_match ?? 'not_requested'),
            tag('location-national', 'Applies Everywhere', String(isNational(hit))),
            tag('location-states', 'Location States', (hit.location_state_names ?? []).join(', ')),
            tag('location-districts', 'Location Districts', (hit.location_district_names ?? []).join(', ')),
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
              { descriptor: { code: 'location-status', name: 'Location Status' }, value: locationStatus },
              { descriptor: { code: 'has-day-range', name: 'Has Day Range' }, value: String(hasDayRange) },
              { descriptor: { code: 'days-matched', name: 'Days Matched' }, value: String(daysMatched) },
              {
                descriptor: { code: 'has-location-specific', name: 'Has Location Specific' },
                value: String(hasLocationSpecific),
              },
              { descriptor: { code: 'search-backend', name: 'Search Backend' }, value: 'qdrant' },
            ],
          },
        ],
        providers,
      },
    },
  };
}
