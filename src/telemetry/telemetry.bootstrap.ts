import { Logger } from '@nestjs/common';
import { $t } from '@project-sunbird/telemetry-sdk';
import { TelemetryWrap } from 'telemetry-wrap';
import { getTelemetryEndpoint, isTelemetryEnabled } from './telemetry.config';

const telemetryLogger = new Logger('Telemetry');

let telemetryReady = false;

function writeTelemetryLog(level: 'log' | 'warn' | 'error', message: string): void {
  telemetryLogger[level](message);
  if (level === 'error') {
    console.error(message);
    return;
  }
  console.log(message);
}

export function isTelemetryReady(): boolean {
  return telemetryReady;
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

  writeTelemetryLog(
    'log',
    `[Telemetry] Initialised → ${endpoint} (channel=${process.env.TELEMETRY_CHANNEL || 'beckn-network-provider'})`,
  );
}

export function logTelemetryStartupSummary(): void {
  if (!isTelemetryEnabled()) {
    writeTelemetryLog('warn', '[Telemetry] Status: DISABLED (TELEMETRY_ENABLED=false)');
    return;
  }

  if (isTelemetryReady()) {
    writeTelemetryLog(
      'log',
      `[Telemetry] Status: ENABLED — capturing bpp_network_api_call + ext_api_call`,
    );
    return;
  }

  writeTelemetryLog(
    'error',
    '[Telemetry] Status: FAILED — events will not be captured',
  );
}