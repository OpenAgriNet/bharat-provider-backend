import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import {
  TelemetryWrap,
  isEmptyBody,
  sanitisePayload,
  truncateBody,
} from 'telemetry-wrap';
import { getTelemetryContext } from './telemetry.context';
import { getTelemetryEndpoint } from './telemetry.config';

type TimedAxiosConfig = InternalAxiosRequestConfig & {
  __telemetryStart?: number;
};

let axiosTelemetryInstalled = false;

function shouldSkipTelemetry(url?: string): boolean {
  if (!url) return false;
  const telemetryEndpoint = getTelemetryEndpoint();
  return url.includes(telemetryEndpoint) || url.includes('/data/v3/telemetry');
}

function logOutboundCall(
  config: TimedAxiosConfig | undefined,
  status: number,
  data: unknown,
  error?: string,
): void {
  if (!config || shouldSkipTelemetry(config.url)) return;

  const start = config.__telemetryStart ?? Date.now();
  const latencyMs = Date.now() - start;
  const ctx = getTelemetryContext();
  const truncatedBody = truncateBody(data);
  const isEmpty = status === 200 && isEmptyBody(data);

  try {
    TelemetryWrap.logApiCall({
      requestTime: new Date(start).toISOString(),
      url: config.url ?? 'unknown',
      method: (config.method ?? 'GET').toUpperCase(),
      requestPayload: sanitisePayload(config.data ?? config.params),
      sessionId: ctx.sessionId,
      questionId: ctx.questionId,
      responseStatus: status,
      responseBody: truncatedBody,
      isEmptyResponse: isEmpty,
      latencyMs,
      error,
      context: {
        ...ctx.context,
        direction: 'outbound',
        source: 'external-api',
      },
    });
  } catch {
    // Telemetry must never break outbound calls
  }
}

export function setupAxiosTelemetry(): void {
  if (axiosTelemetryInstalled) return;
  axiosTelemetryInstalled = true;

  axios.interceptors.request.use((config: TimedAxiosConfig) => {
    config.__telemetryStart = Date.now();
    return config;
  });

  axios.interceptors.response.use(
    (response) => {
      logOutboundCall(
        response.config as TimedAxiosConfig,
        response.status,
        response.data,
      );
      return response;
    },
    (error: AxiosError) => {
      logOutboundCall(
        error.config as TimedAxiosConfig | undefined,
        error.response?.status ?? 0,
        error.response?.data,
        error.message,
      );
      return Promise.reject(error);
    },
  );
}