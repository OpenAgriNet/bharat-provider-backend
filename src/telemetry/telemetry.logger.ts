import { $t } from '@project-sunbird/telemetry-sdk';
import {
  TelemetryWrap,
  generateMid,
  type ApiLifecycleEvent,
} from 'telemetry-wrap';

export type TelemetryApiCallType = 'bpp_network_api_call' | 'ext_api_call';

function buildApiCallParams(event: ApiLifecycleEvent) {
  return [
    { requestTime: event.requestTime },
    { url: event.url },
    { method: event.method },
    { requestPayload: event.requestPayload },
    { sessionId: event.sessionId },
    { questionId: event.questionId },
    { responseStatus: event.responseStatus },
    { responseBody: event.responseBody },
    { isEmptyResponse: event.isEmptyResponse },
    { latencyMs: event.latencyMs },
    { error: event.error ?? null },
    { context: event.context },
  ];
}

export function logTelemetryApiCall(
  event: ApiLifecycleEvent,
  type: TelemetryApiCallType,
): void {
  try {
    $t.log(
      {
        type,
        level: 'TRACE',
        message: `${event.method} ${event.url}`,
        params: buildApiCallParams(event),
      },
      { id: generateMid(), type: 'Event' },
    );

    if (event.isEmptyResponse) {
      TelemetryWrap.logEmptyResponse(event);
    }
    if (event.error || event.responseStatus >= 400) {
      TelemetryWrap.logError(event);
    }
  } catch {
    // Telemetry must never break the request flow
  }
}