import { AdvisoryHit, dedupeByPop, formatSource } from './advisory-qdrant.util';

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
