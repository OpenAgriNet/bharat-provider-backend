import { $t } from '@project-sunbird/telemetry-sdk';
import { TelemetryWrap } from 'telemetry-wrap';
import { getTelemetryEndpoint } from './telemetry.config';

let telemetryReady = false;

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
}