import { Logger } from '@nestjs/common';
import { $t } from '@project-sunbird/telemetry-sdk';
import { TelemetryWrap } from 'telemetry-wrap';
import { getTelemetryEndpoint, isTelemetryEnabled } from './telemetry.config';

const telemetryLogger = new Logger('Telemetry');

let telemetryReady = false;

export function isTelemetryReady(): boolean {
  return telemetryReady;
}

export function formatTelemetryStartupSummary(): string {
  if (!isTelemetryEnabled()) {
    return 'Telemetry: DISABLED (TELEMETRY_ENABLED=false)';
  }

  if (isTelemetryReady()) {
    const endpoint = getTelemetryEndpoint();
    const channel = process.env.TELEMETRY_CHANNEL || 'beckn-network-provider';
    return `Telemetry: ENABLED — initialised → ${endpoint} (channel=${channel};`;
  }

  return 'Telemetry: FAILED — events will not be captured';
}

export function logTelemetryStartupSummary(): void {
  const message = formatTelemetryStartupSummary();
  const level = message.includes('DISABLED')
    ? 'warn'
    : message.includes('FAILED')
      ? 'error'
      : 'log';
  telemetryLogger[level](message);
}

export function bootstrapTelemetry(): void {
  const endpoint = getTelemetryEndpoint();

  $t.initialize({
    pdata: {
      id: process.env.TELEMETRY_PDATA_ID || 'beckn-onix-network-provider',
      ver: process.env.TELEMETRY_PDATA_VER || 'v1.0',
      pid: process.env.TELEMETRY_PDATA_PID || 'network-provider',
    },
    channel: process.env.TELEMETRY_CHANNEL || 'beckn-network-provider',
    env: 'backend',
    batchsize: parseInt(process.env.TELEMETRY_BATCH_SIZE || '20', 10),
    host: endpoint,
    endpoint: '',
  });

  // telemetry-wrap.init() calls a removed SDK API; mark ready for its helpers.
  (TelemetryWrap as unknown as { initialised: boolean }).initialised = true;
  telemetryReady = true;
}