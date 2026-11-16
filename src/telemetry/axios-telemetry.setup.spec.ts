import axios from 'axios';
import { setupAxiosTelemetry } from './axios-telemetry.setup';
import { emitOeItemResponse } from './oe-telemetry.emitter';

jest.mock('./oe-telemetry.emitter', () => ({ emitOeItemResponse: jest.fn() }));

const mockedEmit = emitOeItemResponse as jest.Mock;
const okAdapter = async (config: any) => ({
  status: 200,
  statusText: 'OK',
  data: { d: { output: 'x' } },
  headers: {},
  config,
});

describe('setupAxiosTelemetry', () => {
  beforeAll(() => setupAxiosTelemetry());
  beforeEach(() => mockedEmit.mockReset());

  it('records outbound calls by default', async () => {
    await axios.request({ url: 'https://exlink.pmkisan.gov.in/x', adapter: okAdapter });
    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit.mock.calls[0][1]).toMatchObject({ apiService: 'pmkisan' });
  });

  it('skips calls sent with skipTelemetry', async () => {
    await axios.request({
      url: 'https://exlink.pmkisan.gov.in/x',
      adapter: okAdapter,
      skipTelemetry: true,
    });
    expect(mockedEmit).not.toHaveBeenCalled();
  });
});
