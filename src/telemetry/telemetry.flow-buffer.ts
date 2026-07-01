import type { TelemetryContext } from './telemetry.context';

export interface TelemetryFlowState {
  context: TelemetryContext;
  events: Record<string, unknown>[];
}

export function createFlowState(ctx: TelemetryContext): TelemetryFlowState {
  return { context: ctx, events: [] };
}

export function queueTelemetryEvent(
  state: TelemetryFlowState,
  event: Record<string, unknown>,
): void {
  state.events.push(event);
}