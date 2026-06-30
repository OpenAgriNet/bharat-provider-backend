import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

export interface TelemetryContext {
  sessionId: string;
  questionId: string;
  context: Record<string, string>;
}

const telemetryStorage = new AsyncLocalStorage<TelemetryContext>();

export function runWithTelemetryContext<T>(
  ctx: TelemetryContext,
  fn: () => T,
): T {
  return telemetryStorage.run(ctx, fn);
}

export function getTelemetryContext(): TelemetryContext {
  return (
    telemetryStorage.getStore() ?? {
      sessionId: 'unknown',
      questionId: 'unknown',
      context: {},
    }
  );
}

export function extractBecknContext(req: {
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  originalUrl?: string;
}): TelemetryContext {
  const body = req.body ?? {};
  const becknContext = (body.context ?? {}) as Record<string, string>;

  const transactionId = becknContext.transaction_id ?? uuidv4();
  const messageId = becknContext.message_id ?? uuidv4();
  const action = becknContext.action ?? inferActionFromPath(req.originalUrl ?? req.url);
  const domain = becknContext.domain ?? 'unknown';
  const bppId = becknContext.bpp_id ?? '';
  const bapId = becknContext.bap_id ?? '';

  return {
    sessionId: transactionId,
    questionId: messageId,
    context: {
      beckn_transaction_id: transactionId,
      beckn_message_id: messageId,
      beckn_action: action,
      beckn_domain: domain,
      beckn_bpp_id: bppId,
      beckn_bap_id: bapId,
      request_path: req.originalUrl ?? req.url ?? 'unknown',
    },
  };
}

function inferActionFromPath(path?: string): string {
  if (!path) return 'unknown';
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'unknown';
}