import {
  MiddlewareConsumer,
  Module,
  DynamicModule,
  Type,
  Logger,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { AppDataSource } from './database/ormconfig';
import { AppController } from './app.controller';
import { MetricsController } from './controllers/metrics.controller';
import { RequestContextMiddleware } from './middlewares/request-context.middleware';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { LabelsModule } from './modules/labels/labels.module';
import { CustomAttributesModule } from './modules/custom-attributes/custom-attributes.module';
import { SegmentsModule } from './modules/segments/segments.module';
import { ProcessingModule } from './modules/processing/processing.module';
import { JourneysModule } from './modules/journeys/journeys.module';
import { TemporalModule } from './modules/temporal/temporal.module';
import { CacheModule } from './modules/cache/cache.module';
import { ClickTrackingModule } from './modules/click-tracking/click-tracking.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { BootstrapService } from './bootstrap/bootstrap.service';
import { CommonModule } from './common/common.module';
import { APP_GUARD } from '@nestjs/core';
import { BearerAuthGuard } from './auth/bearer-auth.guard';
import { CrmClientModule } from './shared/crm-client/crm-client.module';
import { AuthClientModule } from './shared/auth-client/auth-client.module';
import { BrokerModule } from './shared/broker/broker.module';
import { CorrelationModule } from './shared/correlation/correlation.module';
import { AppFactory } from './app-factory';
import {
  EvoExtensionPoints,
  RuntimeContextMiddleware,
  TenantDbContextModule,
} from './evo-extension-points';

/**
 * Dynamic App Module - Imports modules based on RUN_MODE
 * Prevents loading Temporal in API-only mode
 */
@Module({})
export class AppModule {
  static forRoot(): DynamicModule {
    const baseImports = [
      ConfigModule.forRoot({
        envFilePath: '.env',
        isGlobal: true,
      }),
      TypeOrmModule.forRoot(AppDataSource.options),
      ScheduleModule.forRoot(),
      CommonModule,
      AuthModule,
      EventsModule,
      ContactsModule,
      LabelsModule,
      CustomAttributesModule,
      SegmentsModule,
      ProcessingModule,
      JourneysModule,
      CacheModule,
      ClickTrackingModule,
      CampaignsModule,
      ClsModule.forRoot({
        global: true,
        middleware: {
          mount: false,
        },
      }),
      // DB-context seam (ADR14, story 10.1b). Global no-op provider in community;
      // the enterprise overlay contributes the per-request RLS transaction.
      TenantDbContextModule,
      CorrelationModule,
      CrmClientModule,
      AuthClientModule,
      BrokerModule,
    ];

    const conditionalImports: Array<DynamicModule | Type> = [];
    if (AppFactory.shouldStartTemporalWorker()) {
      conditionalImports.push(TemporalModule);
    }

    // Extension point (story 0.15): external consumers — e.g. an enterprise
    // overlay — register NestJS modules through the plugin_loader seam. The
    // community default returns no modules, so this is empty in standalone OSS
    // runs. Consumed synchronously to keep forRoot() sync (async factories are
    // warned about below, not awaited).
    const pluginResult = EvoExtensionPoints.get('plugin_loader')();
    let pluginModules: DynamicModule[] = [];
    if (pluginResult instanceof Promise) {
      // forRoot() is synchronous and cannot await here. The runtime contract
      // permits an async plugin_loader factory, but this consumption path does
      // not support one — surface it loudly instead of silently dropping its
      // modules (which would look like "the overlay didn't load" with no clue).
      new Logger('AppModule').warn(
        'plugin_loader returned a Promise (async factory); its modules were ' +
          'NOT imported. Use a synchronous factory, or await it before forRoot().',
      );
    } else {
      pluginModules = pluginResult.modules;
    }

    return {
      module: AppModule,
      imports: [...baseImports, ...pluginModules, ...conditionalImports],
      controllers: [AppController, MetricsController],
      providers: [
        BootstrapService,
        {
          provide: APP_GUARD,
          useClass: BearerAuthGuard,
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ClsMiddleware).forRoutes('*');
    // Single-account: AccountMiddleware removed. Replaced by lightweight
    // RequestContextMiddleware (transactionId/ip/userAgent only).
    consumer.apply(RequestContextMiddleware).forRoutes('*');
    // Extension point (story 0.15, wiring deferred to 10.1): build the
    // request-scoped runtime context and hand it to the registered enricher.
    // Community default leaves scope_id null; an enterprise overlay fills it.
    consumer.apply(RuntimeContextMiddleware).forRoutes('*');
  }
}
