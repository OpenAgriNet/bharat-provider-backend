import {
  AdvisoryHit,
  DAYS_BOOST,
  SEASON_BOOST,
  dedupeByPop,
  formatSource,
  normalizeCrop,
  MAX_TAG_LENGTH,
  cleanTagValue,
  parseAdvisoryParams,
  rankHits,
  seasonList,
  resolvePreferredSeason,
} from './advisory-qdrant.util';

function hit(overrides: Partial<AdvisoryHit>): AdvisoryHit {
  return {
    score: 0.5,
    text: 'text',
    doc_id: 'doc-1',
    chunk_id: 'chunk-1',
    pop_id: 819,
    section: 'full',
    title: 'Sorghum- Harvesting Management',
    crop: 'Sorghum',
    institute: 'ICAR–DKMA',
    creator: 'jak',
    season: 'Rabi',
    start_period: 105,
    end_period: 120,
    ...overrides,
  };
}

describe('dedupeByPop', () => {
  it('keeps only the best-scoring chunk per advisory entry', () => {
    const result = dedupeByPop([
      hit({ chunk_id: 'a', score: 0.61, section: 'symptoms' }),
      hit({ chunk_id: 'b', score: 0.83, section: 'overview' }),
      hit({ chunk_id: 'c', score: 0.7, section: 'conditions' }),
    ]);
    expect(result.map((h) => h.chunk_id)).toEqual(['b']);
  });

  it('returns entries sorted by score descending', () => {
    const result = dedupeByPop([
      hit({ chunk_id: 'a', pop_id: 1, score: 0.4 }),
      hit({ chunk_id: 'b', pop_id: 2, score: 0.9 }),
      hit({ chunk_id: 'c', pop_id: 3, score: 0.6 }),
    ]);
    expect(result.map((h) => h.chunk_id)).toEqual(['b', 'c', 'a']);
  });

  it('treats the same pop_id in different documents as different entries', () => {
    const result = dedupeByPop([
      hit({ chunk_id: 'a', doc_id: 'doc-1', pop_id: 5, score: 0.9 }),
      hit({ chunk_id: 'b', doc_id: 'doc-2', pop_id: 5, score: 0.8 }),
    ]);
    expect(result.map((h) => h.chunk_id)).toEqual(['a', 'b']);
  });

  it('keeps every hit that has no pop_id (PDF chunks), keyed by chunk_id', () => {
    const result = dedupeByPop([
      hit({ chunk_id: 'p1', pop_id: undefined, score: 0.7 }),
      hit({ chunk_id: 'p2', pop_id: null, score: 0.6 }),
      hit({ chunk_id: 'p1', pop_id: undefined, score: 0.5 }),
    ]);
    expect(result.map((h) => h.chunk_id)).toEqual(['p1', 'p2']);
  });

  it('returns an empty list for no hits', () => {
    expect(dedupeByPop([])).toEqual([]);
  });
});

describe('formatSource', () => {
  it('joins institute and creator', () => {
    expect(formatSource('ICAR–DKMA', 'jak')).toBe('ICAR–DKMA, jak');
  });
  it('omits an empty creator', () => {
    expect(formatSource('ICAR–DKMA', '')).toBe('ICAR–DKMA');
    expect(formatSource('ICAR–DKMA', '   ')).toBe('ICAR–DKMA');
  });
  it('is empty when there is nothing to credit', () => {
    expect(formatSource('', '')).toBe('');
  });
  it('credits the creator alone when there is no institute', () => {
    expect(formatSource('', 'jak')).toBe('jak');
  });
});

function intent(tags: Array<[string, string]>, name: string | null = 'aphids') {
  return {
    message: {
      intent: {
        item: {
          descriptor: name === null ? {} : { name },
          tags: [
            {
              descriptor: { code: 'search_params' },
              list: tags.map(([code, value]) => ({ descriptor: { code }, value })),
            },
          ],
        },
      },
    },
  };
}

describe('normalizeCrop', () => {
  it('maps case variants and aliases to the stored crop name', () => {
    expect(normalizeCrop('wheat')).toBe('Wheat');
    expect(normalizeCrop('  RICE ')).toBe('Rice');
    expect(normalizeCrop('paddy')).toBe('Rice');
    expect(normalizeCrop('jowar')).toBe('Sorghum');
    expect(normalizeCrop('kodo millet')).toBe('Kodo Millet');
  });

  it('maps Hindi crop names', () => {
    expect(normalizeCrop('गेहूं')).toBe('Wheat');
    expect(normalizeCrop('धान')).toBe('Rice');
    expect(normalizeCrop('ज्वार')).toBe('Sorghum');
  });

  it('title-cases unknown crops and returns empty for blank input', () => {
    expect(normalizeCrop('pearl MILLET')).toBe('Pearl Millet');
    expect(normalizeCrop('')).toBe('');
    expect(normalizeCrop(undefined)).toBe('');
  });
});

describe('parseAdvisoryParams', () => {
  it('reads crop, district, season, days and top_k from the search_params tags', () => {
    const p = parseAdvisoryParams(
      intent([
        ['crop', 'wheat'],
        ['district', ' Lucknow '],
        ['season', 'Kharif'],
        ['days_after_sowing', '45'],
        ['top_k', '3'],
      ]),
    );
    expect(p).toEqual({
      query: 'aphids',
      crop: 'Wheat',
      district: 'Lucknow',
      season: 'Kharif',
      daysAfterSowing: 45,
      topK: 3,
    });
  });

  it('works with only the query (existing callers)', () => {
    const p = parseAdvisoryParams({ message: { intent: { item: { descriptor: { name: 'aphids in wheat' } } } } });
    expect(p).toEqual({ query: 'aphids in wheat', crop: '', district: '', season: '', daysAfterSowing: null, topK: null });
  });

  it('ignores non-numeric days and empty values', () => {
    const p = parseAdvisoryParams(
      intent([
        ['days_after_sowing', 'about 40'],
        ['district', '  '],
      ]),
    );
    expect(p.daysAfterSowing).toBeNull();
    expect(p.district).toBe('');
  });

  it('accepts a negative day count and the search-params group spelling', () => {
    const body = intent([['days_after_sowing', '-10']]);
    body.message.intent.item.tags[0].descriptor.code = 'search-params';
    expect(parseAdvisoryParams(body).daysAfterSowing).toBe(-10);
  });

  it('keeps the descriptor name as the query over a query tag', () => {
    expect(parseAdvisoryParams(intent([['query', 'other']], 'from descriptor')).query).toBe('from descriptor');
    expect(parseAdvisoryParams(intent([['query', 'from tag']], null)).query).toBe('from tag');
  });
});

describe('cleanTagValue and tag sanitizing', () => {
  it('removes control characters, trims and caps the length', () => {
    expect(cleanTagValue('Luck\nnow\r\u0000')).toBe('Luck now');
    expect(cleanTagValue('x'.repeat(500))).toHaveLength(MAX_TAG_LENGTH);
    expect(cleanTagValue(undefined)).toBe('');
  });

  it('applies to crop, district and season so they cannot forge log lines', () => {
    const p = parseAdvisoryParams(
      intent([
        ['crop', 'wheat\n[advisory-qdrant] forged'],
        ['district', 'Lucknow\r\nERROR forged'],
        ['season', 'Rabi\u0007'],
      ]),
    );
    for (const value of [p.crop, p.district, p.season]) {
      expect(value).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(p.district).toBe('Lucknow ERROR forged');
    expect(p.season).toBe('Rabi');
  });
});

describe('resolvePreferredSeason', () => {
  it('uses the env setting when set, even if the request sends a season', () => {
    expect(resolvePreferredSeason('Kharif', 'Rabi')).toBe('Rabi');
  });

  it('falls back to the request season when the env setting is empty', () => {
    expect(resolvePreferredSeason('Kharif', '')).toBe('Kharif');
    expect(resolvePreferredSeason('Kharif', undefined)).toBe('Kharif');
  });

  it('is empty (no preference) when neither is set', () => {
    expect(resolvePreferredSeason('', '  ')).toBe('');
  });
});

describe('rankHits', () => {
  const kharif = hit({ chunk_id: 'k', season: 'Kharif', score: 0.8, pop_id: 1, start_period: 10, end_period: 30 });
  const rabi = hit({ chunk_id: 'r', season: 'Rabi', score: 0.75, pop_id: 2, start_period: 105, end_period: 120 });

  it('ranks the preferred season first but keeps the other seasons', () => {
    const out = rankHits([kharif, rabi], { preferredSeason: 'rabi', daysAfterSowing: null });
    expect(out.map((h) => h.chunk_id)).toEqual(['r', 'k']);
  });

  it('matches an entry that lists several seasons, e.g. "Rabi,Kharif"', () => {
    const both = hit({ chunk_id: 'b', season: 'Rabi,Kharif', score: 0.7, pop_id: 3 });
    const out = rankHits([kharif, both], { preferredSeason: 'rabi', daysAfterSowing: null });
    expect(out.map((h) => h.chunk_id)).toEqual(['b', 'k']);
  });

  it('keeps score order when there is no preference', () => {
    const out = rankHits([rabi, kharif], { preferredSeason: '', daysAfterSowing: null });
    expect(out.map((h) => h.chunk_id)).toEqual(['k', 'r']);
  });

  it('ranks an advisory whose day range contains the day count first', () => {
    const out = rankHits([rabi, kharif], { preferredSeason: '', daysAfterSowing: 20 });
    expect(out.map((h) => h.chunk_id)).toEqual(['k', 'r']);
    const out2 = rankHits([kharif, rabi], { preferredSeason: '', daysAfterSowing: 110 });
    expect(out2.map((h) => h.chunk_id)).toEqual(['r', 'k']);
  });

  it('treats range ends as inclusive and ignores hits without a range', () => {
    const noRange = hit({ chunk_id: 'n', score: 0.8, pop_id: 3, start_period: null, end_period: null });
    expect(rankHits([noRange, rabi], { preferredSeason: '', daysAfterSowing: 120 }).map((h) => h.chunk_id)).toEqual([
      'r',
      'n',
    ]);
    expect(rankHits([noRange, rabi], { preferredSeason: '', daysAfterSowing: 121 }).map((h) => h.chunk_id)).toEqual([
      'n',
      'r',
    ]);
  });

  it('never drops a hit and does not mutate the input', () => {
    const input = [kharif, rabi];
    const out = rankHits(input, { preferredSeason: 'Zaid', daysAfterSowing: 500 });
    expect(out).toHaveLength(2);
    expect(input.map((h) => h.chunk_id)).toEqual(['k', 'r']);
  });

  it('exposes boosts large enough to matter between close scores', () => {
    expect(SEASON_BOOST).toBeGreaterThan(0.05);
    expect(DAYS_BOOST).toBeGreaterThan(SEASON_BOOST);
  });
});

describe('seasonList', () => {
  it('splits a multi-season value and lowercases it', () => {
    expect(seasonList('Rabi,Kharif, Zaid')).toEqual(['rabi', 'kharif', 'zaid']);
    expect(seasonList('')).toEqual([]);
  });
});
