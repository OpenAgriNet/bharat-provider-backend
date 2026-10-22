import { AdvisoryQdrantService } from './advisory-qdrant.service';
import { AdvisoryHit } from './advisory-qdrant.util';

function hit(overrides: Partial<AdvisoryHit>): AdvisoryHit {
  return {
    score: 0.5,
    text: 'chunk text',
    doc_id: 'row-1',
    chunk_id: 'c-1',
    pop_id: 819,
    section: 'full',
    title: 'Sorghum- Harvesting Management',
    crop: 'Sorghum',
    institute: 'ICAR–DKMA',
    creator: '',
    ...overrides,
  };
}

function body(query: string | undefined) {
  return {
    context: { transaction_id: 't-1', message_id: 'm-1' },
    message: { intent: { item: { descriptor: query === undefined ? {} : { name: query } } } },
  };
}

function ctx(out: any): Record<string, string> {
  const group = out.message.catalog.tags.find((t: any) => t.descriptor.code === 'search-context');
  return Object.fromEntries(group.list.map((e: any) => [e.descriptor.code, e.value]));
}

describe('AdvisoryQdrantService', () => {
  const saved = { ...process.env };
  let embedding: { isConfigured: jest.Mock; embedQuery: jest.Mock };
  let qdrant: { isConfigured: jest.Mock; queryAdvisoryPoints: jest.Mock };
  let service: AdvisoryQdrantService;

  beforeEach(() => {
    delete process.env.ADVISORY_QDRANT_TOP_K;
    embedding = { isConfigured: jest.fn().mockReturnValue(true), embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]) };
    qdrant = { isConfigured: jest.fn().mockReturnValue(true), queryAdvisoryPoints: jest.fn().mockResolvedValue([]) };
    service = new AdvisoryQdrantService(embedding as any, qdrant as any);
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('fails clearly when the query is missing', async () => {
    const out = await service.search(body(undefined));
    expect(ctx(out).status).toBe('failed');
    expect(qdrant.queryAdvisoryPoints).not.toHaveBeenCalled();
  });

  it('reports a generic error when Qdrant is not configured', async () => {
    qdrant.isConfigured.mockReturnValue(false);
    const out = await service.search(body('aphids'));
    expect(ctx(out).status).toBe('error');
    expect(ctx(out).message).toBe('Advisory search is not available');
  });

  it('reports a generic error when embedding is not configured', async () => {
    embedding.isConfigured.mockReturnValue(false);
    const out = await service.search(body('aphids'));
    expect(ctx(out).status).toBe('error');
    expect(ctx(out).message).toBe('Advisory search is not available');
  });

  it('embeds the query, searches advisory points, and returns one item per advisory entry', async () => {
    qdrant.queryAdvisoryPoints.mockResolvedValue([
      hit({ chunk_id: 'a', score: 0.6, section: 'symptoms' }),
      hit({ chunk_id: 'b', score: 0.9, section: 'overview' }),
      hit({ chunk_id: 'c', score: 0.5, pop_id: 820, doc_id: 'row-2' }),
    ]);
    const out = await service.search(body('aphids in wheat'));
    expect(embedding.embedQuery).toHaveBeenCalledWith('aphids in wheat');
    expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledWith([0.1, 0.2], { limit: 40 });
    const items = out.message.catalog.providers[0].items;
    expect(items.map((i: any) => i.id)).toEqual(['b', 'c']);
    expect(ctx(out).status).toBe('success');
    expect(ctx(out)['hit-count']).toBe('2');
  });

  it('limits the result to ADVISORY_QDRANT_TOP_K (default 5)', async () => {
    const many = Array.from({ length: 8 }, (_, i) => hit({ chunk_id: `c${i}`, pop_id: i, score: 1 - i / 10 }));
    qdrant.queryAdvisoryPoints.mockResolvedValue(many);
    expect((await service.search(body('q'))).message.catalog.providers[0].items).toHaveLength(5);
    process.env.ADVISORY_QDRANT_TOP_K = '2';
    expect((await service.search(body('q'))).message.catalog.providers[0].items).toHaveLength(2);
  });

  it('returns not_found when nothing matches', async () => {
    const out = await service.search(body('something unrelated'));
    expect(ctx(out).status).toBe('not_found');
    expect(out.message.catalog.providers).toEqual([]);
  });

  it('turns a backend failure into a fixed error message without leaking details', async () => {
    qdrant.queryAdvisoryPoints.mockRejectedValue(
      new Error('Qdrant query failed HTTP 500: {"status":{"error":"collection secret-name missing"}}'),
    );
    const out = await service.search(body('aphids'));
    expect(ctx(out).status).toBe('error');
    expect(ctx(out).message).toBe('Advisory search failed');
    expect(JSON.stringify(out)).not.toContain('secret-name');
  });
});
