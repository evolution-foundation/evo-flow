import { Inject, Optional } from '@nestjs/common';
import { StorageProcessor } from '../interfaces/storage-processor.interface';
import { EventData } from '../interfaces/event-data.interface';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { getProcessingConfig } from '../config/processing.config';
import { WriteMode } from '../enums/write-mode.enum';
import { SegmentJobService } from '../../segments/services/segment-job.service';
import { SegmentInvalidationService } from '../../segments/services/segment-invalidation.service';
import { getSegmentComputationConfig } from '../../segments/config/segment-computation.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface ClickHouseEventRecord {
  id?: string;
  contact_id: string;
  event_type: 'identify' | 'track' | 'page' | 'screen' | 'segment' | 'journey';
  event_name: string;
  properties: string; // JSON as string
  traits: string; // JSON as string
  anonymous_id?: string;
  message_id?: string;
  occurred_at: string; // ISO string
  processing_time: string; // ISO string
  message_raw: string; // JSON as string
  contact_or_anonymous_id: string;
}

export class ClickHouseStorageProcessor implements StorageProcessor {
  private readonly logger = new CustomLoggerService(
    ClickHouseStorageProcessor.name,
  );
  private readonly config = getProcessingConfig();
  private readonly segmentConfig = getSegmentComputationConfig();

  constructor(
    private clickhouseService: ClickHouseService,
    @Optional()
    @Inject(SegmentJobService)
    private segmentJobService?: SegmentJobService,
    @Optional()
    @Inject(SegmentInvalidationService)
    private segmentInvalidationService?: SegmentInvalidationService,
  ) {
    this.logger.log(
      `🎯 Segment computation mode: ${this.segmentConfig.type} ` +
        `(real-time: ${this.segmentConfig.enableRealTime}, cron-job: ${this.segmentConfig.enableCronJob})`,
    );
    this.logger.log(
      `🔧 Services available - SegmentInvalidationService: ${this.segmentInvalidationService ? 'YES' : 'NO'}, ` +
        `SegmentJobService: ${this.segmentJobService ? 'YES' : 'NO'}`,
    );
    this.logger.log(
      `🆔 ClickHouseStorageProcessor using ClickHouse instance: ${(this.clickhouseService as any).instanceId}`,
    );
  }

  async saveEvent(eventData: EventData): Promise<void> {
    this.logger.log(
      `🎯 [CLICKHOUSE] Processing event: ${eventData.eventType}/${eventData.eventName} for contact: ${eventData.contactId}`,
    );

    try {
      const contactId = eventData.contactId || eventData.anonymousId;

      if (!contactId) {
        throw new Error('Either contactId or anonymousId must be provided');
      }

      const now = new Date();
      const occurredAt = eventData.timestamp
        ? new Date(eventData.timestamp)
        : now;

      const record: ClickHouseEventRecord = {
        contact_id: contactId,
        event_type: eventData.eventType,
        event_name: eventData.eventName || eventData.eventType,
        properties: JSON.stringify(eventData.properties || {}),
        traits: JSON.stringify(eventData.traits || {}),
        anonymous_id: eventData.anonymousId || undefined,
        message_id: eventData.messageId || undefined,
        occurred_at: occurredAt.toISOString(),
        processing_time: now.toISOString(),
        message_raw: JSON.stringify({
          type: eventData.eventType,
          eventName: eventData.eventName,
          properties: eventData.properties,
          traits: eventData.traits,
          timestamp: eventData.timestamp,
          contactId: eventData.contactId,
          anonymousId: eventData.anonymousId,
          context: eventData.context,
          messageId: eventData.messageId,
        }),
        contact_or_anonymous_id: contactId,
      };

      const tableName = this.config.clickhouse?.table || 'contact_events';

      // Determine async mode based on write mode configuration
      const useAsync = this.config.writeMode === WriteMode.CH_ASYNC;

      this.logger.debug(
        `Inserting record to ClickHouse (${this.config.writeMode}): ${JSON.stringify(record)}`,
      );

      await this.clickhouseService.insert({
        table: tableName,
        values: [record],
        asyncInsert: useAsync,
      });

      this.logger.log(`Event saved to ClickHouse: ${eventData.messageId}`);
    } catch (error) {
      this.logger.error(
        `Failed to save event to ClickHouse: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getEvents(limit: number = 100): Promise<any[]> {
    this.logger.debug('Getting events from ClickHouse');

    try {
      const tableName = this.config.clickhouse?.table || 'contact_events';
      const queryBuilder = this.clickhouseService.createQueryBuilder();

      const limitParam = queryBuilder.addParameter(limit, 'UInt32');

      queryBuilder
        .addQueryPart(`SELECT *`)
        .addQueryPart(`FROM ${tableName}`)
        .addQueryPart(`ORDER BY occurred_at DESC`)
        .addQueryPart(`LIMIT ${limitParam}`);

      const { query, parameters } = queryBuilder.build();

      const results = await this.clickhouseService.query({
        query,
        parameters,
      });

      this.logger.debug(
        `Retrieved ${results.length} events from ClickHouse`,
      );

      return results;
    } catch (error) {
      this.logger.error(
        `Failed to get events from ClickHouse: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.clickhouseService.healthCheck();
    } catch (error) {
      this.logger.error(
        `ClickHouse storage health check failed: ${error.message}`,
      );
      return false;
    }
  }

  getConfig(): Record<string, any> {
    return {
      storage: 'clickhouse',
      description: 'Stores events in ClickHouse analytics database',
      ...this.clickhouseService.getConfig(),
    };
  }

  async saveBatch(events: EventData[]): Promise<void> {
    this.logger.debug(`Saving batch of ${events.length} events to ClickHouse`);

    if (events.length === 0) {
      return;
    }

    try {
      const now = new Date();
      const records: ClickHouseEventRecord[] = events.map((eventData) => {
        const contactId = eventData.contactId || eventData.anonymousId;

        if (!contactId) {
          throw new Error(
            `Event ${eventData.messageId}: Either contactId or anonymousId must be provided`,
          );
        }

        const occurredAt = eventData.timestamp
          ? new Date(eventData.timestamp)
          : now;

        return {
          contact_id: contactId,
          event_type: eventData.eventType,
          event_name: eventData.eventName || eventData.eventType,
          properties: JSON.stringify(eventData.properties || {}),
          traits: JSON.stringify(eventData.traits || {}),
          anonymous_id: eventData.anonymousId || undefined,
          message_id: eventData.messageId || undefined,
          occurred_at: occurredAt.toISOString(),
          processing_time: now.toISOString(),
          message_raw: JSON.stringify({
            type: eventData.eventType,
            eventName: eventData.eventName,
            properties: eventData.properties,
            traits: eventData.traits,
            timestamp: eventData.timestamp,
            contactId: eventData.contactId,
            anonymousId: eventData.anonymousId,
            context: eventData.context,
            messageId: eventData.messageId,
          }),
          contact_or_anonymous_id: contactId,
        };
      });

      const tableName = this.config.clickhouse?.table || 'contact_events';

      // Determine async mode based on write mode configuration
      const useAsync = this.config.writeMode === WriteMode.CH_ASYNC;

      await this.clickhouseService.insert({
        table: tableName,
        values: records,
        asyncInsert: useAsync,
      });

      this.logger.log(`Batch of ${events.length} events saved to ClickHouse`);
    } catch (error) {
      this.logger.error(
        `Failed to save batch to ClickHouse: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
