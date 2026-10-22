import axios from 'axios';
import { QdrantClientService } from './qdrant.client';

jest.mock('axios');
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

const POINT = {
  score: 0.83,
  payload: {
    text: 'Sorghum- Harvesting Management\nAdvisory: Harvest AKJ-1 ...',
    doc_id: 'row-1',
    chunk_id: 'c-1',
    pop_id: 819,
    section: 'full',
    title_en: 'Sorghum- Harvesting Management',
    crop: 'Sorghum',
    institute: 'ICAR–DKMA',
    creator: 'jak',
    document_kind: 'advisory',
  },
};

describe('QdrantClientService.queryAdvisoryPoints', () => {
  const saved = { ...process.env };
  let service: QdrantClientService;

  beforeEach(() => {
    process.env.QDRANT_URL = 'http://qdrant:6333/';
    process.env.QDRANT_API_KEY = 'secret';
    process.env.QDRANT_COLLECTION_NAME = 'document-data';
    delete process.env.QDRANT_SCHEME_COLLECTION;
    delete process.env.ADVISORY_QDRANT_COLLECTION_NAME;
    service = new QdrantClientService();
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ status: 200, data: { result: { points: [POINT] } } } as any);
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('filters on document_kind=advisory and queries the provider collection by default', async () => {
    await service.queryAdvisoryPoints([0.1, 0.2], { limit: 40 });
    const [url, body, config] = mockedPost.mock.calls[0] as any[];
    expect(url).toBe('http://qdrant:6333/collections/document-data/points/query');
    expect(body).toEqual({
      query: [0.1, 0.2],
      filter: { must: [{ key: 'document_kind', match: { value: 'advisory' } }] },
      limit: 40,
      with_payload: true,
    });
    expect(config.headers['api-key']).toBe('secret');
  });

  it('prefers ADVISORY_QDRANT_COLLECTION_NAME', async () => {
    process.env.ADVISORY_QDRANT_COLLECTION_NAME = 'prod-docs';
    await service.queryAdvisoryPoints([0.1]);
    expect((mockedPost.mock.calls[0] as any[])[0]).toContain('/collections/prod-docs/');
  });

  it('maps the payload to an AdvisoryHit', async () => {
    const hits = await service.queryAdvisoryPoints([0.1]);
    expect(hits).toEqual([
      {
        score: 0.83,
        text: POINT.payload.text,
        doc_id: 'row-1',
        chunk_id: 'c-1',
        pop_id: 819,
        section: 'full',
        title: 'Sorghum- Harvesting Management',
        crop: 'Sorghum',
        institute: 'ICAR–DKMA',
        creator: 'jak',
      },
    ]);
  });

  it('falls back to name_en for PDF chunks and leaves pop_id/institute empty', async () => {
    mockedPost.mockResolvedValue({
      status: 200,
      data: {
        result: {
          points: [{ score: 0.5, payload: { text: 'pdf text', doc_id: 'd', chunk_id: 'p', name_en: 'Crop Guide' } }],
        },
      },
    } as any);
    const [hit] = await service.queryAdvisoryPoints([0.1]);
    expect(hit.title).toBe('Crop Guide');
    expect(hit.pop_id).toBeUndefined();
    expect(hit.institute).toBe('');
    expect(hit.creator).toBe('');
  });

  it('throws when Qdrant is not configured', async () => {
    delete process.env.QDRANT_URL;
    await expect(service.queryAdvisoryPoints([0.1])).rejects.toThrow('QDRANT_URL is not configured');
  });

  it('throws on a non-2xx response', async () => {
    mockedPost.mockResolvedValue({ status: 500, data: { status: { error: 'boom' } } } as any);
    await expect(service.queryAdvisoryPoints([0.1])).rejects.toThrow('HTTP 500');
  });

  it('returns an empty list when Qdrant returns no points', async () => {
    mockedPost.mockResolvedValue({ status: 200, data: { result: { points: [] } } } as any);
    expect(await service.queryAdvisoryPoints([0.1])).toEqual([]);
  });
});
