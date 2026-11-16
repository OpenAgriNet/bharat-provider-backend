import { getTelemetryAuthToken, getTelemetryHeaders } from './telemetry-auth';

// Produced by bharat-oan-api app/tasks/telemetry.py for key="key", secret="secret"
const PYTHON_JWT =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJrZXkiLCJpYXQiOm51bGwsImV4cCI6bnVsbCwiYXVkIjoiIiwic3ViIjoiIn0.S6_yEoJiDE1iX2trY-3G1os5cFqimQV0ZKiW9zH-WEY';

describe('telemetry auth', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.TELEMETRY_AUTH_TOKEN;
    delete process.env.TELEMETRY_AUTH_KEY;
    delete process.env.TELEMETRY_AUTH_SECRET;
    delete process.env.TELEMETRY_SERVICE_AUTH_KEY;
    delete process.env.TELEMETRY_ORIGIN;
    delete process.env.TELEMETRY_REFERER;
  });

  afterEach(() => {
    process.env = env;
  });

  it('signs the same JWT as bharat-oan-api from key + secret', () => {
    process.env.TELEMETRY_AUTH_KEY = 'key';
    process.env.TELEMETRY_AUTH_SECRET = 'secret';
    expect(getTelemetryAuthToken()).toBe(PYTHON_JWT);
  });

  it('prefers TELEMETRY_AUTH_TOKEN over key + secret', () => {
    process.env.TELEMETRY_AUTH_TOKEN = 'static-token';
    process.env.TELEMETRY_AUTH_KEY = 'key';
    process.env.TELEMETRY_AUTH_SECRET = 'secret';
    expect(getTelemetryAuthToken()).toBe('static-token');
  });

  it('keeps the legacy raw key when no secret is set', () => {
    process.env.TELEMETRY_AUTH_KEY = 'raw-key';
    expect(getTelemetryAuthToken()).toBe('raw-key');
    delete process.env.TELEMETRY_AUTH_KEY;
    process.env.TELEMETRY_SERVICE_AUTH_KEY = 'service-key';
    expect(getTelemetryAuthToken()).toBe('service-key');
  });

  it('sends the same headers as bharat-oan-api', () => {
    process.env.TELEMETRY_AUTH_KEY = 'key';
    process.env.TELEMETRY_AUTH_SECRET = 'secret';
    process.env.TELEMETRY_ORIGIN = 'https://vistaar.test';
    process.env.TELEMETRY_REFERER = 'https://vistaar.test/chat';

    expect(getTelemetryHeaders()).toEqual({
      Accept: '*/*',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      dataType: 'json',
      Authorization: `Bearer ${PYTHON_JWT}`,
      Origin: 'https://vistaar.test',
      Referer: 'https://vistaar.test/chat',
    });
  });

  it('omits Authorization when nothing is configured', () => {
    expect(getTelemetryHeaders().Authorization).toBeUndefined();
  });
});
