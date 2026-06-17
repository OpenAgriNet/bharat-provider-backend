import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import {
  TelemetryWrap,
  isEmptyBody,
  sanitisePayload,
  truncateBody,
} from 'telemetry-wrap';
import {
  TelemetryContext,
  extractBecknContext,
  runWithTelemetryContext,
} from './telemetry.context';

@Injectable()
export class BecknTelemetryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const telemetryCtx = extractBecknContext(req);
    const requestTime = Date.now();

    req.__telemetryCtx = telemetryCtx;

    this.logInboundReceived(telemetryCtx);

    return new Observable((observer) => {
      runWithTelemetryContext(telemetryCtx, () => {
        next
          .handle()
          .pipe(
            tap((responseBody) => {
              const latencyMs = Date.now() - requestTime;
              const statusCode = res.statusCode || 200;

              this.logInboundCompleted(
                req,
                telemetryCtx,
                requestTime,
                statusCode,
                responseBody,
                latencyMs,
              );
            }),
            catchError((err) => {
              const latencyMs = Date.now() - requestTime;
              const statusCode =
                err?.status ?? err?.getStatus?.() ?? res.statusCode ?? 500;

              this.logInboundCompleted(
                req,
                telemetryCtx,
                requestTime,
                statusCode,
                err?.response ?? { message: err?.message },
                latencyMs,
                err?.message,
              );

              return throwError(() => err);
            }),
          )
          .subscribe({
            next: (value) => observer.next(value),
            error: (err) => observer.error(err),
            complete: () => observer.complete(),
          });
      });
    });
  }

  private logInboundReceived(ctx: TelemetryContext): void {
    try {
      TelemetryWrap.logLifecycle({
        action: `beckn.${ctx.context.beckn_action}.received`,
        domain: ctx.context.beckn_domain,
        durationMs: 0,
        context: {
          ...ctx.context,
          direction: 'inbound',
          source: 'beckn-network',
        },
      });
    } catch {
      // Telemetry must never break the request flow
    }
  }

  private logInboundCompleted(
    req: { method: string; originalUrl?: string; url?: string; body?: unknown },
    ctx: TelemetryContext,
    requestTime: number,
    statusCode: number,
    responseBody: unknown,
    latencyMs: number,
    error?: string,
  ): void {
    try {
      const truncatedBody = truncateBody(responseBody);
      const isEmpty = statusCode === 200 && isEmptyBody(responseBody);

      TelemetryWrap.logApiCall({
        requestTime: new Date(requestTime).toISOString(),
        url: req.originalUrl || req.url || 'unknown',
        method: req.method,
        requestPayload: sanitisePayload(req.body),
        sessionId: ctx.sessionId,
        questionId: ctx.questionId,
        responseStatus: statusCode,
        responseBody: truncatedBody,
        isEmptyResponse: isEmpty,
        latencyMs,
        error,
        context: {
          ...ctx.context,
          direction: 'inbound',
          source: 'beckn-network',
        },
      });

      TelemetryWrap.logLifecycle({
        action: `beckn.${ctx.context.beckn_action}.${error || statusCode >= 400 ? 'failed' : 'completed'}`,
        domain: ctx.context.beckn_domain,
        durationMs: latencyMs,
        context: {
          ...ctx.context,
          direction: 'inbound',
          status: String(statusCode),
          success: String(!error && statusCode < 400),
        },
      });
    } catch {
      // Telemetry must never break the request flow
    }
  }
}