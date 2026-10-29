import { getTelemetryContext } from './telemetry.context';
import { emitOeItemResponse } from './oe-telemetry.emitter';

/**
 * success  - upstream answered and accepted the request
 * rejected - upstream answered but refused it (wrong OTP, unknown beneficiary, ...)
 * error    - upstream unreachable, timed out, non-2xx, or unreadable response
 */
export type ExternalApiOutcome = 'success' | 'rejected' | 'error';

export interface ExternalApiCall {
  /** Per-API name shown in Service Check, e.g. "pmkisan_send_otp" */
  apiService: string;
  url: string;
  method?: string;
  startedAt: number;
  outcome: ExternalApiOutcome;
  statusCode?: number | null;
  errorType?: string | null;
  upstreamMessage?: string | null;
  identifierType?: string | null;
}

/**
 * Classify an axios/transport error into a status code and a short error type.
 */
export function classifyRequestError(error: any): {
  statusCode: number | null;
  errorType: string;
} {
  const statusCode = error?.response?.status ?? null;
  if (statusCode) {
    return { statusCode, errorType: 'http_error' };
  }
  const code = String(error?.code || '');
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    /timeout/i.test(String(error?.message || ''))
  ) {
    return { statusCode: null, errorType: 'timeout' };
  }
  if (code) {
    return { statusCode: null, errorType: 'network_error' };
  }
  return { statusCode: null, errorType: 'processing_error' };
}

/**
 * Record one outbound call whose result is only known after decrypting the
 * response (e.g. PM-Kisan "Rsponce": "False"), as an EXT_API event in the
 * current flow. The axios request must be sent with `skipTelemetry: true`
 * so the global axios interceptor doesn't record it a second time.
 *
 * Never pass identifiers, OTPs or request/response bodies here: only the
 * call's outcome and metadata are sent.
 */
export function trackExternalApiCall(call: ExternalApiCall): void {
  try {
    const ctx = getTelemetryContext();

    let error: string | undefined;
    if (call.outcome === 'rejected') {
      error = `rejected: ${call.upstreamMessage || 'no message'}`;
    } else if (call.outcome === 'error') {
      error = `${call.errorType || 'error'}${call.upstreamMessage ? `: ${call.upstreamMessage}` : ''}`;
    }

    emitOeItemResponse(ctx, {
      itemType: 'ext_api_call',
      serviceName: ctx.context.service_name ?? 'unknown',
      apiService: call.apiService,
      method: call.method || 'POST',
      url: call.url.split('?')[0],
      requestPayload: {
        beckn: {
          action: ctx.context.beckn_action ?? null,
          domain: ctx.context.beckn_domain ?? null,
          transaction_id: ctx.context.beckn_transaction_id ?? null,
          message_id: ctx.context.beckn_message_id ?? null,
        },
        identifierType: call.identifierType || null,
      },
      responsePayload: {
        outcome: call.outcome,
        errorType: call.errorType || null,
      },
      statusCode: call.statusCode ?? 0,
      latencyMs: Date.now() - call.startedAt,
      success: call.outcome === 'success',
      error: error ? error.slice(0, 300) : undefined,
    });
  } catch {
    // Telemetry must never break outbound calls
  }
}
