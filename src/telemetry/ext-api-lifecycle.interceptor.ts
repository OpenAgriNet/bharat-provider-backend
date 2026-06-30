import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import {
  isEmptyBody,
  sanitisePayload,
  truncateBody,
} from 'telemetry-wrap';
import { getTelemetryContext } from './telemetry.context';
import { logTelemetryApiCall } from './telemetry.logger';

@Injectable()
export class ExtApiLifecycleInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requestTime = Date.now();
    const ctx = getTelemetryContext();

    return next.handle().pipe(
      tap((response) => {
        const latencyMs = Date.now() - requestTime;
        const responseBody = truncateBody(response?.data);
        const isEmptyResponse =
          response?.status === 200 && isEmptyBody(response?.data);

        logTelemetryApiCall(
          {
            requestTime: new Date(requestTime).toISOString(),
            url: response?.config?.url ?? 'unknown',
            method: (response?.config?.method ?? 'GET').toUpperCase(),
            requestPayload: sanitisePayload(response?.config?.data),
            sessionId: ctx.sessionId,
            questionId: ctx.questionId,
            responseStatus: response?.status ?? 0,
            responseBody,
            isEmptyResponse,
            latencyMs,
            context: {
              ...ctx.context,
              direction: 'outbound',
              source: 'external-api',
            },
          },
          'ext_api_call',
        );
      }),
      catchError((err) => {
        const latencyMs = Date.now() - requestTime;

        logTelemetryApiCall(
          {
            requestTime: new Date(requestTime).toISOString(),
            url: err?.config?.url ?? 'unknown',
            method: (err?.config?.method ?? 'GET').toUpperCase(),
            requestPayload: sanitisePayload(err?.config?.data),
            sessionId: ctx.sessionId,
            questionId: ctx.questionId,
            responseStatus: err?.response?.status ?? 0,
            responseBody: truncateBody(err?.response?.data),
            isEmptyResponse: false,
            latencyMs,
            error: err?.message,
            context: {
              ...ctx.context,
              direction: 'outbound',
              source: 'external-api',
            },
          },
          'ext_api_call',
        );

        return throwError(() => err);
      }),
    );
  }
}