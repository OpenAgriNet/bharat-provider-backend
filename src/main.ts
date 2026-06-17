import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { TelemetryWrap } from 'telemetry-wrap';
import {
  getTelemetryEndpoint,
  isTelemetryEnabled,
  setupAxiosTelemetry,
} from './telemetry';

config();

function initTelemetry(logger: Logger): void {
  if (!isTelemetryEnabled()) {
    logger.log('Telemetry disabled (TELEMETRY_ENABLED=false)');
    return;
  }

  TelemetryWrap.init({
    pdata: {
      id: process.env.TELEMETRY_PDATA_ID || 'beckn-onix-network-provider',
      ver: process.env.TELEMETRY_PDATA_VER || 'v1.0',
      pid: process.env.TELEMETRY_PDATA_PID || 'network-provider',
    },
    channel: process.env.TELEMETRY_CHANNEL || 'beckn-network-provider',
    endpoint: getTelemetryEndpoint(),
    batchSize: parseInt(process.env.TELEMETRY_BATCH_SIZE || '20', 10),
  });

  setupAxiosTelemetry();
  logger.log(`Telemetry initialised → ${getTelemetryEndpoint()}`);
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  initTelemetry(logger);

  Sentry.init({
    dsn: 'YOUR_SENTRY_DSN_HERE', // Replace with your actual Sentry DSN
  });
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.errorHandler());
  app.setViewEngine('ejs');
  app.setBaseViewsDir(join('src','.', 'views'));


  app.enableCors();
  
  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  // Log after server starts
  logger.log(`🚀 Application is running on: http://localhost:${port}`);
  logger.log(`📡 Server started successfully on port ${port}`);
  console.log(`\n========================================`);
  console.log(`🚀 Server is running on port: ${port}`);
  console.log(`🌐 Access the API at: http://localhost:${port}`);
  console.log(`========================================\n`);
}
bootstrap();
