import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import {
  bootstrapTelemetry,
  isTelemetryEnabled,
  logTelemetryStartupSummary,
  setupAxiosTelemetry,
} from './telemetry';

config();

function initTelemetry(): void {
  if (!isTelemetryEnabled()) {
    logTelemetryStartupSummary();
    return;
  }

  try {
    bootstrapTelemetry();
    setupAxiosTelemetry();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logger = new Logger('Telemetry');
    logger.error(`Telemetry init failed: ${message}`);
    console.error(`[Telemetry] Init failed: ${message}`);
  }
}

// Initialise telemetry before Nest boots so Docker logs show status immediately.
initTelemetry();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN });
    app.use(Sentry.Handlers.requestHandler());
    app.use(Sentry.Handlers.errorHandler());
  }

  app.setViewEngine('ejs');
  app.setBaseViewsDir(join('src', '.', 'views'));
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);

  if (isTelemetryEnabled()) {
    logTelemetryStartupSummary();
  }
}

bootstrap();