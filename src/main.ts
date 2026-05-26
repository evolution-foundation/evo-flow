// 🔧 CRITICAL: Load .env BEFORE any imports that read process.env
import * as dotenv from 'dotenv';
dotenv.config();

import { RunMode } from './modules/processing/enums/run-mode.enum';
import { parseRunMode } from './modules/processing/config/processing.config';

// Fail-fast validation BEFORE NestFactory.create (EVO-1194 AC3).
// Throws with the full list of valid values; bubble up to the top-level
// .catch() at the end of this file, which prints and exits non-zero.
parseRunMode(process.env.RUN_MODE);

// Stub-mode short-circuit for RUN_MODEs whose dedicated modules have not landed yet.
// EVO-1194 introduces the names so docker-compose / k8s manifests can already
// reference them; each downstream story wires its module in and removes the
// matching entry from this Set.
const STUB_RUN_MODES = new Set<string>([
  RunMode.CAMPAIGN_PACKER, // wired by downstream campaign-packer story (epic 4)
  RunMode.CAMPAIGN_SENDER, // wired by downstream campaign-sender story (epic 4)
  RunMode.EVENT_RECEIVER, // wired by EVO-1207 (event-receiver POST /webhooks/*)
  RunMode.EVENT_PROCESS, // wired by downstream event-process story (epic 3)
]);
if (STUB_RUN_MODES.has(process.env.RUN_MODE ?? '')) {
  // Structured JSON to stderr so log collectors (Loki / Datadog) ingest the
  // stub-exit event with proper severity instead of treating it as untagged
  // stdout noise. NestJS Logger is not available pre-NestFactory.
  process.stderr.write(
    JSON.stringify({
      level: 'info',
      service: 'evo-flow',
      runMode: process.env.RUN_MODE,
      msg: 'Stub mode — no module wired yet. Exiting gracefully.',
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
  process.exit(0);
}

// Initialize OpenTelemetry BEFORE NestFactory if tracing is enabled
if (process.env.OTEL_TRACES_ENABLED === 'true') {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { NestInstrumentation } = require('@opentelemetry/instrumentation-nestjs-core');
  const { Resource } = require('@opentelemetry/resources');
  const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

  const serviceName = process.env.OTEL_SERVICE_NAME || 'evo-campaign-api';
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (otlpEndpoint) {
    const sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: 'production',
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`, // OTLP HTTP traces path
      }),
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new NestInstrumentation(),
      ],
    });

    sdk.start();
    console.log(`✅ OpenTelemetry tracing initialized for Tempo: ${otlpEndpoint}`);
  } else {
    console.warn('⚠️  OTEL_EXPORTER_OTLP_ENDPOINT not set, OpenTelemetry tracing disabled');
  }
}

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe, Logger, LogLevel, RequestMethod, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { AppFactory } from './app-factory';
import { BootstrapService } from './bootstrap/bootstrap.service';
import { KafkaService } from './modules/processing/kafka/kafka.service';
import { KafkaConsumerService } from './modules/processing/consumers/kafka.consumer';
import { ClickHouseService } from './modules/processing/clickhouse/clickhouse.service';
import { ProcessingService } from './modules/processing/processing.service';
import { SegmentJobService } from './modules/segments/services/segment-job.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { CustomLoggerService } from './common/services/custom-logger.service';

async function bootstrap() {
  // 🔍 DEBUG: Log environment variables BEFORE anything else
  console.log('🔍 DEBUG - Environment variables at startup:');
  console.log('  KAFKA_BROKERS:', process.env.KAFKA_BROKERS);
  console.log('  KAFKA_BROKERS_INTERNAL:', process.env.KAFKA_BROKERS_INTERNAL);
  console.log('  Current directory:', process.cwd());
  
  // Override global Logger to add run mode to all logs
  CustomLoggerService.overrideGlobalLogger();

  // Create custom logger with run mode
  const customLogger = new CustomLoggerService();

  // Use original Logger interface for bootstrap, but with custom logger underneath
  const logger = new Logger('Bootstrap');

  // Determine which module to load based on RUN_MODE
  // Filter log levels - disable DEBUG and VERBOSE for cleaner output
  const logLevels: LogLevel[] = ['log', 'warn', 'error'];

  const app = await NestFactory.create(AppModule.forRoot(), {
    logger: logLevels, // Use minimal log levels instead of custom logger for cleaner output
  });

  // Migration safety guardrail in production.
  if (process.env.NODE_ENV === 'production') {
    const dataSource = app.get(DataSource);
    const hasPendingMigrations = await dataSource.showMigrations();
    if (hasPendingMigrations) {
      logger.error(
        '❌ Pending database migrations detected in production. Aborting startup.',
      );
      await app.close();
      process.exit(1);
    }
  }

  // Get bootstrap service to log startup info
  const bootstrapService = app.get(BootstrapService);
  bootstrapService.logStartupInfo();

  // Only setup HTTP server if needed (not for event-processor mode)
  if (AppFactory.shouldStartHttpServer()) {
    // Set global API prefix for all routes
    // RedirectController route must be explicitly excluded
    app.setGlobalPrefix('api/v1', {
      exclude: ['link/:shortCode'],
    });

    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: false, // Permite propriedades extras (temporário)
        skipMissingProperties: false,
        skipNullProperties: false,
        skipUndefinedProperties: false,
        exceptionFactory: (errors) => {
          // Transform validation errors to standard format
          const details = errors.map((error) => ({
            field: error.property,
            message: Object.values(error.constraints || {}).join(', '),
            value: error.value,
          }));
          return new HttpException(
            {
              message: 'Validation failed',
              details,
            },
            HttpStatus.BAD_REQUEST,
          );
        },
      }),
    );

    // Apply global response interceptor for standard format
    app.useGlobalInterceptors(new ResponseTransformInterceptor());

    // Apply global exception filter for standard error format
    app.useGlobalFilters(new HttpExceptionFilter());

    const config = new DocumentBuilder()
      .setTitle('EvoCampaign API v1')
      .setDescription('Event tracking and campaign management API')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          description: 'Enter JWT Bearer token',
          in: 'header',
        },
        'Bearer',
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: 'api_access_token',
          in: 'header',
          description: 'API Access Token from your profile',
        },
        'api_access_token',
      )
      .addTag(
        'Events',
        'Event tracking endpoints (track, identify, page, screen)',
      )
      .addTag('Contacts', 'Contact management and customer data')
      .addTag('Labels', 'Label management and tagging system')
      .addTag(
        'Custom Attributes',
        'Custom attribute definitions and validation',
      )
      .addTag('Segments', 'Contact segmentation and filtering')
      .addTag('Processing', 'Event processing configuration and health')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);

    app.enableCors({
      origin: true,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    const port = process.env.PORT ?? 3000;
    await app.listen(port);

    logger.log(`🌐 HTTP Server listening on port ${port}`);
    logger.log(`📖 API Documentation: http://localhost:${port}/api`);
  }

  // Workers start automatically via OnModuleInit in respective services
  logger.log('🔧 Background workers will initialize based on RUN_MODE...');

  // Force initialization of services that need OnModuleInit in worker modes
  if (!AppFactory.shouldStartHttpServer()) {
    logger.log(
      '🔧 Manually triggering service initialization for worker mode...',
    );

    // Ensure the app is fully initialized (this should trigger all decorators)
    await app.init();

    try {
      // Get services that need manual initialization
      // For temporal-worker, use ClickHouse singleton to avoid multiple instances
      if (process.env.RUN_MODE === 'temporal-worker') {
        logger.log('🔧 Using ClickHouse singleton for temporal-worker mode...');
        const { ClickHouseSingleton } = await import('./modules/processing/clickhouse/clickhouse-singleton.service');
        await ClickHouseSingleton.getInstance();
        logger.log('✅ ClickHouse singleton initialized for temporal-worker');
      } else {
        const clickhouseService = app.get(ClickHouseService);
        if (clickhouseService && clickhouseService.onModuleInit) {
          logger.log('🔧 Manually calling ClickHouseService.onModuleInit...');
          await clickhouseService.onModuleInit();
        }
      }

      const kafkaService = app.get(KafkaService);
      if (kafkaService && kafkaService.onModuleInit) {
        logger.log('🔧 Manually calling KafkaService.onModuleInit...');
        await kafkaService.onModuleInit();
      }

      const processingService = app.get(ProcessingService);
      if (processingService && processingService.onModuleInit) {
        logger.log('🔧 Manually calling ProcessingService.onModuleInit...');
        await processingService.onModuleInit();
      }

      const kafkaConsumerService = app.get(KafkaConsumerService);
      if (kafkaConsumerService && kafkaConsumerService.onModuleInit) {
        logger.log('🔧 Manually calling KafkaConsumerService.onModuleInit...');
        await kafkaConsumerService.onModuleInit();
      }

      // Initialize SegmentJobService for SEGMENT-WORKER mode crons
      if (AppFactory.shouldStartSegmentWorker()) {
        try {
          const segmentJobService = app.get(SegmentJobService);
          if (segmentJobService) {
            logger.log(
              '🔧 SegmentJobService initialized for SEGMENT-WORKER cron jobs',
            );

            // Force service to be fully initialized with all decorators
            // This triggers the @Cron decorator registration
            logger.log(
              '🔧 Forcing cron job registration by accessing service methods...',
            );
          }

          // Wait a moment for decorators to register
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Initialize SchedulerRegistry to ensure @Cron decorators execute in worker mode
          try {
            const schedulerRegistry = app.get(SchedulerRegistry);
            if (schedulerRegistry) {
              logger.log(
                '🔧 SchedulerRegistry initialized - cron jobs should now execute',
              );

              // Log currently registered cron jobs for debugging
              const cronJobs = schedulerRegistry.getCronJobs();
              logger.log(
                `📅 Found ${cronJobs.size} registered cron jobs: ${Array.from(cronJobs.keys()).join(', ')}`,
              );

              if (cronJobs.size === 0) {
                logger.warn(
                  '⚠️ No cron jobs found - @Cron decorators may not be registering in worker mode',
                );
                logger.warn(
                  '⚠️ This could be a NestJS lifecycle issue in worker mode without HTTP server',
                );
              } else {
                logger.log(
                  '✅ Cron jobs registered successfully and should execute',
                );
              }
            }
          } catch (error) {
            logger.warn(
              '⚠️ Could not initialize SchedulerRegistry:',
              error.message,
            );
          }
        } catch (error) {
          logger.warn(
            '⚠️ Could not initialize SegmentJobService for cron jobs:',
            error.message,
          );
        }
      }

      // Initialize Journey Temporal Worker if needed
      if (AppFactory.shouldStartJourneyWorker()) {
        logger.log('🔧 Initializing Temporal Worker for journey execution...');

        try {
          // Initialize Temporal Worker Service - it will auto-start via onModuleInit
          const { TemporalWorkerService } = await import(
            './modules/temporal/temporal-worker.service'
          );
          const temporalWorkerService = app.get(TemporalWorkerService);

          if (temporalWorkerService) {
            logger.log(
              '✅ TemporalWorkerService found and will initialize via onModuleInit',
            );
          } else {
            logger.warn('⚠️ TemporalWorkerService not found in app context');
          }

          logger.log('✅ Temporal Worker initialization completed');
        } catch (error) {
          logger.warn(
            '⚠️ Could not initialize Temporal Worker:',
            error.message,
          );
        }
      }

      // Initialize Campaign Temporal Worker if needed
      if (AppFactory.shouldStartCampaignWorker()) {
        logger.log('🔧 Initializing Temporal Worker for campaign execution...');

        try {
          const { CampaignWorkerService } = await import(
            './modules/temporal/campaign-worker.service'
          );
          const campaignWorkerService = app.get(CampaignWorkerService);

          if (campaignWorkerService) {
            logger.log(
              '✅ CampaignWorkerService found and will initialize via onModuleInit',
            );
          } else {
            logger.warn('⚠️ CampaignWorkerService not found in app context');
          }

          logger.log('✅ Campaign Worker initialization completed');
        } catch (error) {
          logger.warn(
            '⚠️ Could not initialize Campaign Worker:',
            error.message,
          );
        }
      }

      logger.log('✅ Manual service initialization completed');
    } catch (error) {
      logger.error(
        '❌ Error during manual service initialization:',
        error.message,
        error.stack,
      );
    }
  }

  const runInfo = bootstrapService.getRunInfo();
  logger.log(
    `🎯 Service ready in ${String(runInfo.runMode).toUpperCase()} mode`,
  );
}

bootstrap().catch((error) => {
  console.error('❌ Failed to start application:', error);
  process.exit(1);
});
