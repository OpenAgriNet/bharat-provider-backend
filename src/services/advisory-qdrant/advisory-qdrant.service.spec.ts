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
    season: 'Rabi',
    start_period: 105,
    end_period: 120,
    ...overrides,
  };
}

function body(query: string | undefined, tags: Array<[string, string]> = []) {
  return {
    context: { transaction_id: 't-1', message_id: 'm-1' },
    message: {
      intent: {
        item: {
          descriptor: query === undefined ? {} : { name: query },
          ...(tags.length
            ? {
                tags: [
                  {
                    descriptor: { code: 'search_params' },
                    list: tags.map(([code, value]) => ({ descriptor: { code }, value })),
                  },
                ],
              }
            : {}),
        },
      },
    },
  };
}

function ids(out: any): string[] {
  return (out.message.catalog.providers[0]?.items ?? []).map((i: any) => i.id);
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
    delete process.env.ADVISORY_DEFAULT_SEASON;
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

  describe('crop, season and days after sowing', () => {
    const wheatRabi = hit({ chunk_id: 'wr', pop_id: 1, score: 0.7, season: 'Rabi', start_period: 20, end_period: 100 });
    const wheatKharif = hit({ chunk_id: 'wk', pop_id: 2, score: 0.75, season: 'Kharif', start_period: 20, end_period: 100 });

    it('passes the normalized crop to Qdrant and does not filter on season', async () => {
      await service.search(body('aphids', [['crop', 'wheat']]));
      expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledTimes(1);
      expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledWith([0.1, 0.2], { limit: 40, crop: 'Wheat' });
    });

    it('ranks the ADVISORY_DEFAULT_SEASON first without dropping other seasons', async () => {
      process.env.ADVISORY_DEFAULT_SEASON = 'Rabi';
      qdrant.queryAdvisoryPoints.mockResolvedValue([wheatKharif, wheatRabi]);
      const out = await service.search(body('aphids', [['crop', 'wheat']]));
      expect(ids(out)).toEqual(['wr', 'wk']);
    });

    it('uses the request season when the setting is empty, and no preference when neither is set', async () => {
      qdrant.queryAdvisoryPoints.mockResolvedValue([wheatRabi, wheatKharif]);
      expect(ids(await service.search(body('aphids', [['crop', 'wheat'], ['season', 'Rabi']])))).toEqual(['wr', 'wk']);
      qdrant.queryAdvisoryPoints.mockResolvedValue([wheatRabi, wheatKharif]);
      expect(ids(await service.search(body('aphids', [['crop', 'wheat']])))).toEqual(['wk', 'wr']);
    });

    it('ranks the advisory whose day range contains the days after sowing first', async () => {
      const late = hit({ chunk_id: 'late', pop_id: 3, score: 0.8, season: 'Rabi', start_period: 105, end_period: 150 });
      qdrant.queryAdvisoryPoints.mockResolvedValue([late, wheatRabi]);
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['days_after_sowing', '40']]));
      expect(ids(out)).toEqual(['wr', 'late']);
      expect(ctx(out)['days-matched']).toBe('true');
      expect(ctx(out)['has-day-range']).toBe('true');
    });

    it('reports days-matched false when no returned range contains the day count', async () => {
      qdrant.queryAdvisoryPoints.mockResolvedValue([wheatRabi]);
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['days_after_sowing', '300']]));
      expect(ids(out)).toEqual(['wr']);
      expect(ctx(out)['days-matched']).toBe('false');
    });

    it('reports has-day-range false for advisories without a range', async () => {
      qdrant.queryAdvisoryPoints.mockResolvedValue([hit({ start_period: null, end_period: null })]);
      expect(ctx(await service.search(body('aphids', [['crop', 'wheat']])))['has-day-range']).toBe('false');
    });

    it('takes top_k from the request tag, clamped to 20', async () => {
      const many = Array.from({ length: 30 }, (_, i) => hit({ chunk_id: `c${i}`, pop_id: i, score: 1 - i / 100 }));
      qdrant.queryAdvisoryPoints.mockResolvedValue(many);
      expect(ids(await service.search(body('q', [['top_k', '3']])))).toHaveLength(3);
      expect(ids(await service.search(body('q', [['top_k', '99']])))).toHaveLength(20);
    });
  });

  describe('district with parallel fallback', () => {
    const general = hit({ chunk_id: 'g', pop_id: 1 });
    const local = hit({ chunk_id: 'l', pop_id: 2 });

    it('runs the district and crop-level queries on one embedding and uses the district results when present', async () => {
      qdrant.queryAdvisoryPoints.mockImplementation(async (_v: number[], o: any) => (o.district ? [local] : [general]));
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['district', 'Lucknow']]));
      expect(embedding.embedQuery).toHaveBeenCalledTimes(1);
      expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledTimes(2);
      expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledWith([0.1, 0.2], { limit: 40, crop: 'Wheat', district: 'Lucknow' });
      expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledWith([0.1, 0.2], { limit: 40, crop: 'Wheat' });
      expect(ids(out)).toEqual(['l']);
      expect(ctx(out)['location-status']).toBe('location_matched');
    });

    it('falls back to crop-level results when nothing matches the district (location_not_applied)', async () => {
      qdrant.queryAdvisoryPoints.mockImplementation(async (_v: number[], o: any) => (o.district ? [] : [general]));
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['district', 'Lucknow']]));
      expect(ids(out)).toEqual(['g']);
      expect(ctx(out).status).toBe('success');
      expect(ctx(out)['location-status']).toBe('location_not_applied');
    });

    it('treats a failing district query as no location match and still answers', async () => {
      qdrant.queryAdvisoryPoints.mockImplementation(async (_v: number[], o: any) => {
        if (o.district) throw new Error('unindexed filter rejected');
        return [general];
      });
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['district', 'Lucknow']]));
      expect(ids(out)).toEqual(['g']);
      expect(ctx(out)['location-status']).toBe('location_not_applied');
    });

    it('still fails with the fixed message when the crop-level query fails', async () => {
      qdrant.queryAdvisoryPoints.mockRejectedValue(new Error('boom'));
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['district', 'Lucknow']]));
      expect(ctx(out).status).toBe('error');
      expect(ctx(out).message).toBe('Advisory search failed');
    });

    it('reports no_match when a district was sent and nothing was found at all', async () => {
      const out = await service.search(body('aphids', [['crop', 'wheat'], ['district', 'Lucknow']]));
      expect(ctx(out).status).toBe('not_found');
      expect(ctx(out)['location-status']).toBe('no_match');
    });

    it('reports not_requested and runs one query when no district is sent', async () => {
      qdrant.queryAdvisoryPoints.mockResolvedValue([general]);
      const out = await service.search(body('aphids', [['crop', 'wheat']]));
      expect(qdrant.queryAdvisoryPoints).toHaveBeenCalledTimes(1);
      expect(ctx(out)['location-status']).toBe('not_requested');
    });
  });
});
