import { AppController } from './app.controller';

function makeController() {
  const controller: any = Object.create(AppController.prototype);
  controller.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  controller.appService = { searchForIntentQuery: jest.fn().mockResolvedValue('marqo-result') };
  controller.advisoryQdrantService = { search: jest.fn().mockResolvedValue('qdrant-result') };
  return controller;
}

const BODY = {
  context: { transaction_id: 't-1' },
  message: {
    intent: {
      category: { descriptor: { name: 'knowledge-advisory', code: 'knowledge-advisory' } },
      item: { descriptor: { name: 'aphids in wheat' } },
    },
  },
};

describe('mobility/search knowledge-advisory routing', () => {
  const saved = process.env.ADVISORY_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.ADVISORY_BACKEND;
    else process.env.ADVISORY_BACKEND = saved;
  });

  it('uses the legacy Marqo path when ADVISORY_BACKEND is unset', async () => {
    delete process.env.ADVISORY_BACKEND;
    const controller = makeController();
    expect(await controller.getContentFromIcar1(BODY)).toBe('marqo-result');
    expect(controller.advisoryQdrantService.search).not.toHaveBeenCalled();
  });

  it('uses the legacy Marqo path when ADVISORY_BACKEND=marqo', async () => {
    process.env.ADVISORY_BACKEND = 'marqo';
    const controller = makeController();
    expect(await controller.getContentFromIcar1(BODY)).toBe('marqo-result');
  });

  it('uses the Qdrant advisory service when ADVISORY_BACKEND=qdrant', async () => {
    process.env.ADVISORY_BACKEND = ' Qdrant ';
    const controller = makeController();
    expect(await controller.getContentFromIcar1(BODY)).toBe('qdrant-result');
    expect(controller.advisoryQdrantService.search).toHaveBeenCalledWith(BODY);
    expect(controller.appService.searchForIntentQuery).not.toHaveBeenCalled();
  });
});
