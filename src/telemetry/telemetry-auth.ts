import { Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

const authLogger = new Logger('TelemetryAuth');
let warnedMissingAuth = false;

function base64UrlEncode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Bearer token for the observability service, same scheme as bharat-oan-api
 * (app/tasks/telemetry.py _get_telemetry_auth_token):
 *   1. TELEMETRY_AUTH_TOKEN as-is
 *   2. HS256 JWT signed from TELEMETRY_AUTH_KEY (iss) + TELEMETRY_AUTH_SECRET
 *   3. Legacy: TELEMETRY_AUTH_KEY / TELEMETRY_SERVICE_AUTH_KEY alone, used as
 *      the raw token (previous behaviour of this service)
 */
export function getTelemetryAuthToken(): string | null {
  if (process.env.TELEMETRY_AUTH_TOKEN) {
    return process.env.TELEMETRY_AUTH_TOKEN;
  }

  const key = process.env.TELEMETRY_AUTH_KEY;
  const secret = process.env.TELEMETRY_AUTH_SECRET;
  if (key && secret) {
    const unsignedToken = `${base64UrlEncode({ typ: 'JWT', alg: 'HS256' })}.${base64UrlEncode({
      iss: key,
      iat: null,
      exp: null,
      aud: '',
      sub: '',
    })}`;
    const signature = createHmac('sha256', secret)
      .update(unsignedToken)
      .digest('base64url');
    return `${unsignedToken}.${signature}`;
  }

  return key || process.env.TELEMETRY_SERVICE_AUTH_KEY || null;
}

/**
 * Request headers for telemetry dispatch, same as bharat-oan-api
 * _get_telemetry_headers.
 */
export function getTelemetryHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    dataType: 'json',
  };

  const authToken = getTelemetryAuthToken();
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  } else if (!warnedMissingAuth) {
    warnedMissingAuth = true;
    authLogger.warn(
      'Telemetry auth is not configured; sending telemetry without Authorization header',
    );
  }

  if (process.env.TELEMETRY_ORIGIN) {
    headers.Origin = process.env.TELEMETRY_ORIGIN;
  }
  if (process.env.TELEMETRY_REFERER) {
    headers.Referer = process.env.TELEMETRY_REFERER;
  }

  return headers;
}
