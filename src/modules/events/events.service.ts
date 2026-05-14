import { Injectable, BadRequestException } from '@nestjs/common';
import {
  TrackEventDto,
  IdentifyEventDto,
  PageEventDto,
  ScreenEventDto,
  BatchProcessingResultDto,
  BatchEventResultDto,
} from './dto';
import { ProcessingService } from '../processing/processing.service';
import { EventData } from '../processing/interfaces/event-data.interface';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class EventsService {
  private readonly logger = new CustomLoggerService(EventsService.name);

  constructor(private processingService: ProcessingService) {}

  async trackEvent(
    dto: TrackEventDto,
  ): Promise<{ messageId: string; status: string }> {
    this.logger.debug(`Processing track event: ${dto.event}`);

    // Validate that either contactId or anonymousId is provided
    if (!dto.contactId && !dto.anonymousId) {
      throw new BadRequestException(
        'Either contactId or anonymousId must be provided',
      );
    }

    const eventData: EventData = {
      messageId: dto.messageId,
      contactId: dto.contactId,
      anonymousId: dto.anonymousId,
      eventType: 'track',
      eventName: dto.event,
      properties: dto.properties,
      timestamp: dto.timestamp,
      context: dto.context,
    };

    const result = await this.processingService.processEvent(eventData);

    if (result.status === 'error') {
      throw new BadRequestException(result.error);
    }

    return { messageId: result.messageId, status: result.status };
  }

  async identifyEvent(
    dto: IdentifyEventDto,
  ): Promise<{ messageId: string; status: string }> {
    this.logger.debug('Processing identify event');

    // Validate that either contactId or anonymousId is provided
    if (!dto.contactId && !dto.anonymousId) {
      throw new BadRequestException(
        'Either contactId or anonymousId must be provided',
      );
    }

    const eventData: EventData = {
      messageId: dto.messageId,
      contactId: dto.contactId,
      anonymousId: dto.anonymousId,
      eventType: 'identify',
      eventName: dto.eventName || 'identify',
      properties: dto.properties,
      traits: dto.traits,
      timestamp: dto.timestamp,
      context: dto.context,
    };

    const result = await this.processingService.processEvent(eventData);

    if (result.status === 'error') {
      throw new BadRequestException(result.error);
    }

    return { messageId: result.messageId, status: result.status };
  }

  async pageEvent(
    dto: PageEventDto,
  ): Promise<{ messageId: string; status: string }> {
    this.logger.debug(`Processing page event: ${dto.name}`);

    // Validate that either contactId or anonymousId is provided
    if (!dto.contactId && !dto.anonymousId) {
      throw new BadRequestException(
        'Either contactId or anonymousId must be provided',
      );
    }

    const eventData: EventData = {
      messageId: dto.messageId,
      contactId: dto.contactId,
      anonymousId: dto.anonymousId,
      eventType: 'page',
      eventName: dto.name || 'page_view',
      properties: dto.properties,
      timestamp: dto.timestamp,
      context: dto.context,
    };

    const result = await this.processingService.processEvent(eventData);

    if (result.status === 'error') {
      throw new BadRequestException(result.error);
    }

    return { messageId: result.messageId, status: result.status };
  }

  async screenEvent(
    dto: ScreenEventDto,
  ): Promise<{ messageId: string; status: string }> {
    this.logger.debug(`Processing screen event: ${dto.name}`);

    // Validate that either contactId or anonymousId is provided
    if (!dto.contactId && !dto.anonymousId) {
      throw new BadRequestException(
        'Either contactId or anonymousId must be provided',
      );
    }

    const eventData: EventData = {
      messageId: dto.messageId,
      contactId: dto.contactId,
      anonymousId: dto.anonymousId,
      eventType: 'screen',
      eventName: dto.name || 'screen_view',
      properties: dto.properties,
      timestamp: dto.timestamp,
      context: dto.context,
    };

    const result = await this.processingService.processEvent(eventData);

    if (result.status === 'error') {
      throw new BadRequestException(result.error);
    }

    return { messageId: result.messageId, status: result.status };
  }

  // ==================== HELPER METHODS FOR UNIVERSAL EVENTS ====================

  /**
   * Track email events (sent, opened, clicked, etc.)
   */
  async trackEmailEvent(params: {
    contactId: string;
    eventType:
      | 'sent'
      | 'delivered'
      | 'opened'
      | 'clicked'
      | 'bounced'
      | 'unsubscribed'
      | 'spam';
    messageId: string;
    properties: {
      email_id?: string;
      campaign_id?: string;
      subject?: string;
      link_url?: string;
      bounce_reason?: string;
      provider?: 'sendgrid' | 'postmark' | 'resend' | 'mailchimp';
      [key: string]: any;
    };
    timestamp?: string;
  }) {
    const trackDto: TrackEventDto = {
      messageId: params.messageId,
      contactId: params.contactId,
      event: `email_${params.eventType}`,
      properties: {
        ...params.properties,
        channel: 'email',
        event_category: 'email_engagement',
      },
      timestamp: params.timestamp,
    };

    return await this.trackEvent(trackDto);
  }

  /**
   * Track WhatsApp events
   */
  async trackWhatsAppEvent(params: {
    contactId: string;
    eventType: 'sent' | 'delivered' | 'read' | 'replied' | 'failed';
    messageId: string;
    properties: {
      whatsapp_message_id?: string;
      conversation_id?: string;
      message_type?: 'text' | 'image' | 'document' | 'template';
      template_name?: string;
      failure_reason?: string;
      provider?: 'twilio' | 'meta' | '360dialog';
      [key: string]: any;
    };
    timestamp?: string;
  }) {
    const trackDto: TrackEventDto = {
      messageId: params.messageId,
      contactId: params.contactId,
      event: `whatsapp_${params.eventType}`,
      properties: {
        ...params.properties,
        channel: 'whatsapp',
        event_category: 'messaging_engagement',
      },
      timestamp: params.timestamp,
    };

    return await this.trackEvent(trackDto);
  }

  /**
   * Track SMS events
   */
  async trackSmsEvent(params: {
    contactId: string;
    eventType: 'sent' | 'delivered' | 'failed' | 'replied';
    messageId: string;
    properties: {
      sms_id?: string;
      phone_number?: string;
      message_length?: number;
      failure_reason?: string;
      provider?: 'twilio' | 'signalwire';
      [key: string]: any;
    };
    timestamp?: string;
  }) {
    const trackDto: TrackEventDto = {
      messageId: params.messageId,
      contactId: params.contactId,
      event: `sms_${params.eventType}`,
      properties: {
        ...params.properties,
        channel: 'sms',
        event_category: 'messaging_engagement',
      },
      timestamp: params.timestamp,
    };

    return await this.trackEvent(trackDto);
  }

  /**
   * Track web/chat events
   */
  async trackWebEvent(params: {
    contactId: string;
    eventType:
      | 'page_view'
      | 'form_submit'
      | 'button_click'
      | 'chat_message'
      | 'file_download';
    messageId: string;
    properties: {
      page_url?: string;
      page_title?: string;
      form_name?: string;
      button_text?: string;
      chat_widget_id?: string;
      file_name?: string;
      [key: string]: any;
    };
    timestamp?: string;
    anonymousId?: string;
  }) {
    const trackDto: TrackEventDto = {
      messageId: params.messageId,
      contactId: params.contactId,
      anonymousId: params.anonymousId,
      event: params.eventType,
      properties: {
        ...params.properties,
        channel: 'web',
        event_category: 'web_engagement',
      },
      timestamp: params.timestamp,
    };

    return await this.trackEvent(trackDto);
  }

  async trackBatchEvents(
    events: Array<any>,
  ): Promise<BatchProcessingResultDto> {
    this.logger.log(`Processing batch of ${events.length} events`);
    const results: BatchEventResultDto[] = [];

    const promises = events.map(async (event) => {
      try {
        let result: { messageId: string; status: string } | null = null;

        if ('event' in event && typeof (event as any).event === 'string') {
          result = await this.trackEvent(event);
        } else if ('traits' in event) {
          result = await this.identifyEvent(event);
        } else if ('name' in event && 'category' in event) {
          if ('url' in event) {
            result = await this.pageEvent(event);
          } else {
            result = await this.screenEvent(event);
          }
        } else if (
          'eventType' in event &&
          typeof (event as any).eventType === 'string'
        ) {
          const eventType = (event as any).eventType as string;

          if (
            [
              'sent',
              'delivered',
              'opened',
              'clicked',
              'bounced',
              'unsubscribed',
              'spam',
            ].includes(eventType)
          ) {
            result = await this.trackEmailEvent(event);
          } else if (eventType === 'read') {
            result = await this.trackWhatsAppEvent(event);
          } else if (
            ['sent', 'delivered', 'failed', 'replied'].includes(eventType)
          ) {
            result = await this.trackSmsEvent(event);
          } else if (
            [
              'page_view',
              'form_submit',
              'button_click',
              'chat_message',
              'file_download',
            ].includes(eventType)
          ) {
            result = await this.trackWebEvent(event);
          } else {
            this.logger.error(`Unknown eventType: ${eventType}`);
            return { error: `Unknown eventType: ${eventType}` };
          }
        } else {
          this.logger.error(
            `Invalid event structure: ${JSON.stringify(event)}`,
          );
          return { error: 'Invalid event structure' };
        }

        if (result) {
          return result;
        }
        return { error: 'Unknown processing error' };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Error processing event: ${errorMessage}`);
        return { error: errorMessage };
      }
    });

    const settledResults = await Promise.allSettled(promises);

    for (const settled of settledResults) {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
      } else {
        results.push({ error: settled.reason?.message || 'Unknown error' });
      }
    }

    const successful = results.filter((r) => !('error' in r)).length;
    const failed = results.filter((r) => 'error' in r).length;

    this.logger.log(
      `Batch completed: ${successful} successful, ${failed} failed out of ${events.length}`,
    );

    return {
      message: 'Batch processing completed',
      results,
      total: events.length,
      successful,
      failed,
    };
  }
}
