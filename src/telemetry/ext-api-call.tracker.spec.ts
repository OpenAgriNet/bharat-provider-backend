import { classifyRequestError, trackExternalApiCall } from './ext-api-call.tracker';
import { emitOeItemResponse } from './oe-telemetry.emitter';
import { getTelemetryContext } from './telemetry.context';

jest.mock('./oe-telemetry.emitter', () => ({ emitOeItemResponse: jest.fn() }));
jest.mock('./telemetry.context', () => ({ getTelemetryContext: jest.fn() }));

const mockedEmit = emitOeItemResponse as jest.Mock;
const mockedContext = getTelemetryContext as jest.Mock;

const CTX = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  questionId: '22222222-2222-4222-8222-222222222222',
  hasExplicitCorrelation: true,
  context: {
    service_name: 'pmkisan',
    beckn_action: 'status',
    beckn_domain: 'schemes:vistaar',
    beckn_transaction_id: 'txn-1',
    beckn_message_id: 'msg-1',
  },
};

describe('trackExternalApiCall', () => {
  beforeEach(() => {
    mockedEmit.mockReset();
    mockedContext.mockReturnValue(CTX);
  });

  it('emits a rejected call as an unsuccessful EXT_API item in the current flow', () => {
    trackExternalApiCall({
      apiService: 'pmkisan_verify_otp',
      url: 'https://pmkisan.test/ChatbotOTPVerified?x=1',
      startedAt: Date.now(),
      outcome: 'rejected',
      statusCode: 200,
      upstreamMessage: 'Invalid OTP',
      identifierType: 'Ben_id',
    });

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    const [ctx, details] = mockedEmit.mock.calls[0];
    expect(ctx).toBe(CTX);
    expect(details).toMatchObject({
      itemType: 'ext_api_call',
      serviceName: 'pmkisan',
      apiService: 'pmkisan_verify_otp',
      method: 'POST',
      url: 'https://pmkisan.test/ChatbotOTPVerified',
      statusCode: 200,
      success: false,
      error: 'rejected: Invalid OTP',
      requestPayload: {
        beckn: { action: 'status', transaction_id: 'txn-1', message_id: 'msg-1' },
        identifierType: 'Ben_id',
      },
      responsePayload: { outcome: 'rejected', errorType: null },
    });
  });

  it('emits success without an error and errors with their type', () => {
    trackExternalApiCall({
      apiService: 'pmkisan_send_otp',
      url: 'https://pmkisan.test/ChatbotOTP',
      startedAt: Date.now(),
      outcome: 'success',
      statusCode: 200,
    });
    trackExternalApiCall({
      apiService: 'pmkisan_send_otp',
      url: 'https://pmkisan.test/ChatbotOTP',
      startedAt: Date.now(),
      outcome: 'error',
      errorType: 'timeout',
      upstreamMessage: 'timeout of 60000ms exceeded',
    });

    expect(mockedEmit.mock.calls[0][1]).toMatchObject({ success: true, error: undefined });
    expect(mockedEmit.mock.calls[1][1]).toMatchObject({
      success: false,
      statusCode: 0,
      error: 'timeout: timeout of 60000ms exceeded',
      responsePayload: { outcome: 'error', errorType: 'timeout' },
    });
  });

  it('never throws when telemetry fails', () => {
    mockedEmit.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      trackExternalApiCall({
        apiService: 'pmkisan_send_otp',
        url: 'https://pmkisan.test/ChatbotOTP',
        startedAt: Date.now(),
        outcome: 'success',
      }),
    ).not.toThrow();
  });
});

describe('classifyRequestError', () => {
  it('classifies HTTP, timeout and network errors', () => {
    expect(classifyRequestError({ response: { status: 502 } })).toEqual({
      statusCode: 502,
      errorType: 'http_error',
    });
    expect(classifyRequestError({ code: 'ECONNABORTED' })).toEqual({
      statusCode: null,
      errorType: 'timeout',
    });
    expect(classifyRequestError({ code: 'ENOTFOUND' })).toEqual({
      statusCode: null,
      errorType: 'network_error',
    });
    expect(classifyRequestError(new Error('bad json'))).toEqual({
      statusCode: null,
      errorType: 'processing_error',
    });
  });
});
