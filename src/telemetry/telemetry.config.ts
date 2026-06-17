export function getTelemetryEndpoint(): string {
  if (process.env.TELEMETRY_ENDPOINT) {
    return process.env.TELEMETRY_ENDPOINT;
  }

  const host = (process.env.TELEMETRY_HOST || 'https://dev-vistaar.da.gov.in').replace(
    /\/$/,
    '',
  );
  const apiSlug = process.env.TELEMETRY_API_SLUG || '/action';
  const path = process.env.TELEMETRY_PATH || '/data/v3/telemetry';

  return `${host}${apiSlug}${path}`;
}

export function isTelemetryEnabled(): boolean {
  return process.env.TELEMETRY_ENABLED !== 'false';
}