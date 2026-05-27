import { MiddlewareConsumer, Module, DynamicModule } from '@nestjs/common';
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
import { AppFactory } from './app-factory';

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
      CrmClientModule,
      AuthClientModule,
      BrokerModule,
    ];

    const conditionalImports: any[] = [];
    if (AppFactory.shouldStartTemporalWorker()) {
      conditionalImports.push(TemporalModule);
    }

    return {
      module: AppModule,
      imports: [...baseImports, ...conditionalImports],
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
  }
}
