import { Injectable, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { Campaign } from '../entities/campaign.entity';
import { CampaignContact } from '../entities/campaign-contact.entity';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { ConfigService } from '@nestjs/config';
import { ContactsClientService } from '../../../shared/crm-client/contacts-client.service';
import {
  mapContactDto,
  type HydratedContact,
} from '../../../shared/crm-client/types/contact';
import { CrmInboxDispatcher } from '../../../shared/messaging-channels/dispatchers/crm-inbox.dispatcher';

export interface SendMessageInput {
  campaignId: string;
  campaignContactId: string;
  contactId: string;
  inboxId: string;
  templateId?: string;
  channelType: string;
}

export interface SendMessageResult {
  success: boolean;
  messageId?: string;
  conversationId?: string;
  error?: string;
  statusCode?: number;
}

/**
 * Service for sending campaign messages through EvoAI CRM inboxes
 * Supports WhatsApp, Email, SMS channels with templates and rate limiting
 */
@Injectable()
export class CampaignMessageSenderService {
  private readonly logger = new Logger(CampaignMessageSenderService.name);

  // Rate limiting trackers (in-memory, could be moved to Redis for distributed systems)
  private rateLimiters: Map<string, { count: number; windowStart: number }> =
    new Map();
  private redis: Redis | null = null;

  constructor(
    private readonly db: TenantDbContext,
    private readonly configService: ConfigService,
    private readonly contactsClient: ContactsClientService,
    private readonly crmInboxDispatcher: CrmInboxDispatcher,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  private get campaignContactRepository(): Repository<CampaignContact> {
    return this.db.getRepository(CampaignContact);
  }

  private get messageTemplateRepository(): Repository<MessageTemplate> {
    return this.db.getRepository(MessageTemplate);
  }

  private async getRedisClient(): Promise<Redis | null> {
    if (this.redis) {
      return this.redis;
    }

    try {
      this.redis = new Redis({
        host: this.configService.get<string>('REDIS_HOST') || 'localhost',
        port: Number(this.configService.get<string>('REDIS_PORT') || '6379'),
        password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
        db: Number(this.configService.get<string>('REDIS_DB') || '5'),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });

      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }

      return this.redis;
    } catch (error) {
      this.logger.warn(
        `Redis unavailable for distributed rate limit, using in-memory fallback: ${error.message}`,
      );
      this.redis = null;
      return null;
    }
  }

  /**
   * Send message to a single contact
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.logger.debug('Sending message', {
      campaignId: input.campaignId,
      contactId: input.contactId,
      channelType: input.channelType,
    });

    try {
      // Get contact details from the CRM
      const dto = await this.contactsClient.findById(input.contactId);
      const contact = mapContactDto(dto);

      if (!contact) {
        throw new Error(`Contact ${input.contactId} not found`);
      }

      // Get campaign
      const campaign = await this.campaignRepository.findOne({
        where: { id: input.campaignId },
      });

      if (!campaign) {
        throw new Error(`Campaign ${input.campaignId} not found`);
      }

      // Check rate limit
      const rateLimitKey = this.getRateLimitKey(
        input.inboxId,
        input.channelType,
      );

      if (
        campaign.isRateLimit &&
        !(await this.checkRateLimit(rateLimitKey, input.channelType))
      ) {
        throw new Error(`Rate limit exceeded for channel ${input.channelType}`);
      }

      // Get message content (from template or campaign)
      const messageContent = await this.prepareMessageContent(
        input.templateId,
        contact,
        campaign,
      );

      // Create conversation and send message via the extracted dispatcher
      const dispatchResult = await this.crmInboxDispatcher.dispatch({
        contactId: input.contactId,
        inboxId: input.inboxId,
        content: messageContent.content,
        campaignId: input.campaignId,
        templateParams: messageContent.templateParams,
      });
      const result: SendMessageResult = {
        success: dispatchResult.success,
        messageId: dispatchResult.messageId,
        conversationId: dispatchResult.conversationId,
        error: dispatchResult.error?.message,
        statusCode: dispatchResult.statusCode,
      };

      // Update rate limiter
      if (campaign.isRateLimit && result.success) {
        await this.incrementRateLimit(rateLimitKey);
      }

      // Update campaign_contact status
      if (result.success) {
        await this.campaignContactRepository.update(
          {
            id: input.campaignContactId,
          },
          {
            status: 'sent',
            sentAt: new Date(),
          },
        );
      } else {
        await this.campaignContactRepository.update(
          {
            id: input.campaignContactId,
          },
          {
            status: 'failed',
          },
        );
      }

      return result;
    } catch (error) {
      this.logger.error('Failed to send message', {
        campaignId: input.campaignId,
        contactId: input.contactId,
        error: error.message,
      });

      // Update campaign_contact status to failed
      try {
        await this.campaignContactRepository.update(
          {
            id: input.campaignContactId,
          },
          {
            status: 'failed',
          },
        );
      } catch (updateError) {
        this.logger.error('Failed to update campaign_contact status', {
          error: updateError.message,
        });
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Prepare message content from template or campaign
   */
  private async prepareMessageContent(
    templateId: string | undefined,
    contact: HydratedContact,
    campaign: Campaign,
  ): Promise<{
    content: string;
    templateParams?: {
      name: string;
      category?: string;
      language?: string;
      processed_params?: Record<string, any>;
    };
  }> {
    if (templateId) {
      // Get template
      const template = await this.messageTemplateRepository.findOne({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error(`Template ${templateId} not found`);
      }

      // Process template variables
      const processedContent = this.processTemplateVariables(
        template.content,
        contact,
      );

      return {
        content: processedContent,
        templateParams: {
          name: template.name,
          category: template.category || undefined,
          language: template.language || 'pt_BR',
          processed_params: template.variables || {},
        },
      };
    }

    // Use campaign description/message if no template
    return {
      content: campaign.description || 'Campaign message',
    };
  }

  /**
   * Process template variables with contact data
   */
  private processTemplateVariables(
    content: string,
    contact: HydratedContact,
  ): string {
    let processedContent = content;

    // Replace common variables
    const variables: Record<string, string> = {
      '{contact.name}': contact.name || '',
      '{contact.email}': contact.email || '',
      '{contact.phone}': contact.phoneNumber || '',
      '{{contact.name}}': contact.name || '',
      '{{contact.email}}': contact.email || '',
      '{{contact.phone}}': contact.phoneNumber || '',
    };

    // Replace custom attributes
    if (contact.customAttributes) {
      Object.keys(contact.customAttributes).forEach((key) => {
        variables[`{contact.${key}}`] = contact.customAttributes[key];
        variables[`{{contact.${key}}}`] = contact.customAttributes[key];
      });
    }

    // Perform replacements
    Object.keys(variables).forEach((placeholder) => {
      processedContent = processedContent.replace(
        new RegExp(placeholder, 'g'),
        variables[placeholder],
      );
    });

    return processedContent;
  }

  /**
   * Get rate limit key for tracking
   */
  private getRateLimitKey(inboxId: string, channelType: string): string {
    return `rate:${inboxId}:${channelType}`;
  }

  /**
   * Check if request is within rate limit
   */
  private async checkRateLimit(
    key: string,
    channelType: string,
  ): Promise<boolean> {
    const redis = await this.getRedisClient();
    const limits: Record<string, number> = {
      'Channel::Whatsapp': Number(
        this.configService.get('RATE_LIMIT_WHATSAPP_PER_MIN') || 1000,
      ),
      'Channel::Email': Number(
        this.configService.get('RATE_LIMIT_EMAIL_PER_MIN') || 5000,
      ),
      'Channel::Sms': Number(
        this.configService.get('RATE_LIMIT_SMS_PER_MIN') || 200,
      ),
    };
    const limit = limits[channelType] || 1000;

    if (redis) {
      const current = Number((await redis.get(key)) || 0);
      return current < limit;
    }

    const now = Date.now();
    const windowDuration = 60000; // 1 minute window

    const tracker = this.rateLimiters.get(key);

    if (!tracker) {
      // No tracker yet, allow
      return true;
    }

    // Check if window has expired
    if (now - tracker.windowStart > windowDuration) {
      // Reset tracker
      this.rateLimiters.set(key, { count: 0, windowStart: now });
      return true;
    }

    // Check if within limit
    return tracker.count < limit;
  }

  /**
   * Increment rate limit counter
   */
  private async incrementRateLimit(key: string): Promise<void> {
    const redis = await this.getRedisClient();
    if (redis) {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, 60);
      }
      return;
    }

    const now = Date.now();
    const tracker = this.rateLimiters.get(key);

    if (!tracker || now - tracker.windowStart > 60000) {
      // Start new window
      this.rateLimiters.set(key, { count: 1, windowStart: now });
    } else {
      // Increment existing window
      tracker.count++;
      this.rateLimiters.set(key, tracker);
    }
  }

  /**
   * Clean up expired rate limiters (should be called periodically)
   */
  cleanupRateLimiters(): void {
    const now = Date.now();
    const windowDuration = 60000; // 1 minute

    for (const [key, tracker] of this.rateLimiters.entries()) {
      if (now - tracker.windowStart > windowDuration * 2) {
        this.rateLimiters.delete(key);
      }
    }
  }
}
