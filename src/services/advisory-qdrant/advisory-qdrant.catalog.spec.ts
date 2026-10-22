import { buildAdvisoryOnSearch } from './advisory-qdrant.catalog';
import { AdvisoryHit } from './advisory-qdrant.util';

const HIT: AdvisoryHit = {
  score: 0.83214,
  text: 'Sorghum- Harvesting Management\nAdvisory: Harvest AKJ-1 at physiological maturity.',
  doc_id: 'row-1',
  chunk_id: 'chunk-1',
  pop_id: 819,
  section: 'full',
  title: 'Sorghum- Harvesting Management',
  crop: 'Sorghum',
  institute: 'ICAR–DKMA',
  creator: 'jak',
};

function tagMap(item: any): Record<string, string> {
  const group = item.tags.find((t: any) => t.descriptor.code === 'chunk-details');
  return Object.fromEntries(group.list.map((e: any) => [e.descriptor.code, e.value]));
}

function contextMap(catalog: any): Record<string, string> {
  const group = catalog.tags.find((t: any) => t.descriptor.code === 'search-context');
  return Object.fromEntries(group.list.map((e: any) => [e.descriptor.code, e.value]));
}

const CONTEXT = { transaction_id: 't-1', message_id: 'm-1', action: 'search', domain: 'schemes:vistaar' };

describe('buildAdvisoryOnSearch', () => {
  it('returns an on_search catalog with one item per hit and chunk-details tags', () => {
    const out = buildAdvisoryOnSearch({ context: CONTEXT, query: 'aphids', results: [HIT], status: 'success' });
    expect(out.context.action).toBe('on_search');
    expect(out.context.transaction_id).toBe('t-1');
    const catalog = out.message.catalog;
    expect(catalog.descriptor.code).toBe('knowledge-advisory');
    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0].id).toBe('advisory-documents');
    const [item] = catalog.providers[0].items;
    expect(item.id).toBe('chunk-1');
    const tags = tagMap(item);
    expect(Object.keys(tags).sort()).toEqual(
      ['chunk_id', 'crop', 'doc_id', 'score', 'section', 'source', 'text', 'title'].sort(),
    );
    expect(tags.title).toBe('Sorghum- Harvesting Management');
    expect(tags.crop).toBe('Sorghum');
    expect(tags.section).toBe('full');
    expect(tags.score).toBe('0.8321');
    expect(tags.doc_id).toBe('row-1');
    expect(tags.chunk_id).toBe('chunk-1');
    expect(tags.source).toBe('ICAR–DKMA, jak');
  });

  it('appends the Source line to the text', () => {
    const out = buildAdvisoryOnSearch({ context: CONTEXT, query: 'q', results: [HIT], status: 'success' });
    const tags = tagMap(out.message.catalog.providers[0].items[0]);
    expect(tags.text).toBe(`${HIT.text}\n\nSource: ICAR–DKMA, jak`);
  });

  it('omits the creator and the whole Source line when empty', () => {
    const noCreator = buildAdvisoryOnSearch({
      context: CONTEXT, query: 'q', results: [{ ...HIT, creator: '' }], status: 'success',
    });
    expect(tagMap(noCreator.message.catalog.providers[0].items[0]).text).toBe(`${HIT.text}\n\nSource: ICAR–DKMA`);

    const none = buildAdvisoryOnSearch({
      context: CONTEXT, query: 'q', results: [{ ...HIT, institute: '', creator: '' }], status: 'success',
    });
    const tags = tagMap(none.message.catalog.providers[0].items[0]);
    expect(tags.text).toBe(HIT.text);
    expect(tags.source).toBe('');
  });

  it('writes the search-context tags', () => {
    const out = buildAdvisoryOnSearch({ context: CONTEXT, query: 'aphids in wheat', results: [HIT], status: 'success' });
    expect(contextMap(out.message.catalog)).toEqual({
      query: 'aphids in wheat',
      status: 'success',
      message: '',
      'hit-count': '1',
      'search-backend': 'qdrant',
    });
  });

  it('has no providers for empty results and carries the status and message', () => {
    const out = buildAdvisoryOnSearch({
      context: CONTEXT, query: 'q', results: [], status: 'not_found', message: 'No advisory found',
    });
    expect(out.message.catalog.providers).toEqual([]);
    const ctx = contextMap(out.message.catalog);
    expect(ctx.status).toBe('not_found');
    expect(ctx.message).toBe('No advisory found');
    expect(ctx['hit-count']).toBe('0');
  });

  it('falls back to doc_id:index when a hit has no chunk_id', () => {
    const out = buildAdvisoryOnSearch({
      context: CONTEXT, query: 'q', results: [{ ...HIT, chunk_id: '' }], status: 'success',
    });
    expect(out.message.catalog.providers[0].items[0].id).toBe('row-1:0');
  });
});
