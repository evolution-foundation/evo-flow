import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Journey } from './entities/journey.entity';
import { CreateJourneyDto, UpdateJourneyDto } from './dto';
import { ProcessingService } from '../processing/processing.service';
import { EventData } from '../processing/interfaces/event-data.interface';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { JourneyCacheService } from '../cache/services/journey-cache.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class JourneysService {
  private readonly logger: CustomLoggerService;

  constructor(
    @InjectRepository(Journey)
    private readonly journeyRepository: Repository<Journey>,
    private readonly processingService: ProcessingService,
    private readonly journeyCacheService: JourneyCacheService,
  ) {
    this.logger = new CustomLoggerService(JourneysService.name);
  }

  async create(createJourneyDto: CreateJourneyDto): Promise<Journey> {
    const journey = this.journeyRepository.create({
      ...createJourneyDto,
    });

    const savedJourney = await this.journeyRepository.save(journey);

    await this.journeyCacheService.set(savedJourney);

    return savedJourney;
  }

  async findAll(): Promise<Journey[]> {
    const cachedJourneys = await this.journeyCacheService.getAll();

    if (cachedJourneys && cachedJourneys.length > 0) {
      return cachedJourneys
        .sort((a, b) => {
          const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
          const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
          return dateB.getTime() - dateA.getTime();
        })
        .map(cached => ({
          id: cached.id,
          name: cached.name,
          description: cached.description,
          isActive: cached.isActive,
          flowData: cached.flowData,
          flowTriggers: cached.flowTriggers,
          createdAt: cached.createdAt instanceof Date ? cached.createdAt : new Date(cached.createdAt),
          updatedAt: cached.updatedAt instanceof Date ? cached.updatedAt : new Date(cached.updatedAt),
        } as Journey));
    }

    const journeys = await this.journeyRepository.find({
      order: { createdAt: 'DESC' },
    });

    for (const journey of journeys) {
      await this.journeyCacheService.set(journey);
    }

    return journeys;
  }

  async findOne(id: string): Promise<Journey> {
    const cachedJourney = await this.journeyCacheService.get(id);

    if (cachedJourney) {
      return {
        id: cachedJourney.id,
        name: cachedJourney.name,
        description: cachedJourney.description,
        isActive: cachedJourney.isActive,
        flowData: cachedJourney.flowData,
        flowTriggers: cachedJourney.flowTriggers,
        createdAt: cachedJourney.createdAt instanceof Date ? cachedJourney.createdAt : new Date(cachedJourney.createdAt),
        updatedAt: cachedJourney.updatedAt instanceof Date ? cachedJourney.updatedAt : new Date(cachedJourney.updatedAt),
      } as Journey;
    }

    const journey = await this.journeyRepository.findOne({
      where: { id },
    });

    if (!journey) {
      throw new NotFoundException(`Journey with ID ${id} not found`);
    }

    await this.journeyCacheService.set(journey);

    return journey;
  }

  async update(
    id: string,
    updateJourneyDto: UpdateJourneyDto,
  ): Promise<Journey> {
    const journey = await this.findOne(id);

    Object.assign(journey, updateJourneyDto);

    const updatedJourney = await this.journeyRepository.save(journey);

    await this.journeyCacheService.set(updatedJourney);

    return updatedJourney;
  }

  async remove(id: string): Promise<void> {
    const journey = await this.findOne(id);

    await this.journeyRepository.remove(journey);

    await this.journeyCacheService.invalidate(id);
  }

  async toggleActive(id: string): Promise<Journey> {
    const journey = await this.findOne(id);

    journey.isActive = !journey.isActive;

    const updatedJourney = await this.journeyRepository.save(journey);

    await this.journeyCacheService.set(updatedJourney);

    return updatedJourney;
  }

  async duplicate(id: string): Promise<Journey> {
    const originalJourney = await this.findOne(id);

    const duplicatedJourney = this.journeyRepository.create({
      ...originalJourney,
      id: undefined,
      name: `${originalJourney.name} (Copy)`,
      isActive: false,
      createdAt: undefined,
      updatedAt: undefined,
    });

    return await this.journeyRepository.save(duplicatedJourney);
  }

  async findByTriggerType(triggerType: string): Promise<Journey[]> {
    const journeys = await this.journeyRepository
      .createQueryBuilder('journey')
      .where('journey.isActive = :isActive', { isActive: true })
      .andWhere(
        "jsonb_path_exists(journey.flow_triggers, '$[*] ? (@.type == :triggerType)')",
        { triggerType },
      )
      .getMany();

    return journeys;
  }

  async findActive(): Promise<Journey[]> {
    const cachedJourneys = await this.journeyCacheService.getActiveJourneys();

    return cachedJourneys.map(cached => ({
      id: cached.id,
      name: cached.name,
      description: cached.description,
      isActive: cached.isActive,
      flowData: cached.flowData,
      flowTriggers: cached.flowTriggers,
      createdAt: cached.createdAt instanceof Date ? cached.createdAt : new Date(cached.createdAt),
      updatedAt: cached.updatedAt instanceof Date ? cached.updatedAt : new Date(cached.updatedAt),
    } as Journey));
  }

  async validateFlowData(journey: Journey): Promise<boolean> {
    if (
      !journey.flowData ||
      !journey.flowData.nodes ||
      !journey.flowData.edges
    ) {
      throw new BadRequestException('Invalid flow data structure');
    }

    const nodeIds = new Set(journey.flowData.nodes.map((node) => node.id));

    for (const edge of journey.flowData.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        throw new BadRequestException(
          'Flow data contains invalid edge references',
        );
      }
    }

    if (journey.flowTriggers.length === 0) {
      throw new BadRequestException('Journey must have at least one trigger');
    }

    return true;
  }

  async processWebhookTrigger(
    payload: any,
    headers: any,
  ): Promise<{ success: boolean; messageId: string; processedAt: Date }> {
    const messageId = uuidv4();
    const processedAt = new Date();

    this.logger.debug('Processing webhook trigger', {
      messageId,
      payloadKeys: Object.keys(payload || {}),
      headersCount: Object.keys(headers || {}).length,
    });

    try {
      const webhookEvent = {
        messageId,
        eventType: 'webhook',
        eventName: 'webhook.received',
        contactId: payload.contactId || null,
        properties: {
          endpoint: '/api/v1/journeys/trigger',
          data: payload,
          headers: this.sanitizeHeaders(headers),
          method: 'POST',
          timestamp: processedAt.toISOString(),
        },
        timestamp: processedAt,
      };

      this.logger.log('Webhook trigger event created successfully', {
        messageId,
        contactId: webhookEvent.contactId,
      });

      return {
        success: true,
        messageId,
        processedAt,
      };
    } catch (error) {
      this.logger.error('Failed to process webhook trigger', {
        messageId,
        error: error.message,
        stack: error.stack,
      });

      throw new BadRequestException('Failed to process webhook trigger');
    }
  }

  private sanitizeHeaders(headers: any): Record<string, string> {
    if (!headers || typeof headers !== 'object') return {};

    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
    const sanitized: Record<string, string> = {};

    Object.keys(headers).forEach((key) => {
      const normalizedKey = key.toLowerCase();
      if (!sensitiveHeaders.includes(normalizedKey)) {
        sanitized[key] = String(headers[key]);
      }
    });

    return sanitized;
  }

  async processSpecificJourneyWebhookTrigger(
    journeyId: string,
    payload: any,
    headers: any,
  ): Promise<{
    success: boolean;
    messageId: string;
    journeyId: string;
    contactId: string;
    processedAt: Date;
  }> {
    const messageId = uuidv4();
    const processedAt = payload.timestamp
      ? new Date(payload.timestamp)
      : new Date();
    const contactId = payload.contact_id;

    this.logger.debug('Processing specific journey webhook trigger', {
      messageId,
      journeyId,
      contactId,
      payloadKeys: Object.keys(payload || {}),
      hasTimestamp: !!payload.timestamp,
    });

    if (!contactId) {
      throw new BadRequestException('contact_id is required in payload');
    }

    try {
      const journey = await this.findOne(journeyId);
      if (!journey.isActive) {
        throw new BadRequestException(`Journey ${journeyId} is not active`);
      }

      const eventData: EventData = {
        messageId,
        contactId,
        eventType: 'track',
        eventName: 'webhook.journey_trigger',
        properties: {
          journeyId,
          endpoint: `/api/v1/journeys/trigger/${journeyId}`,
          data: payload.data || {},
          headers: this.sanitizeHeaders(headers),
          method: 'POST',
          originalPayload: payload,
        },
        timestamp: processedAt.toISOString(),
        context: {
          source: 'journey_webhook',
          userAgent: headers['user-agent'],
          ip: headers['x-forwarded-for'] || headers['x-real-ip'],
        },
      };

      const result = await this.processingService.processEvent(eventData);

      if (result.status === 'error') {
        throw new BadRequestException(
          `Failed to process journey trigger event: ${result.error}`,
        );
      }

      this.logger.log('Journey webhook trigger event processed successfully', {
        messageId,
        journeyId,
        contactId,
        journeyName: journey.name,
        eventProcessingResult: result.status,
      });

      return {
        success: true,
        messageId,
        journeyId,
        contactId,
        processedAt,
      };
    } catch (error) {
      this.logger.error('Failed to process specific journey webhook trigger', {
        messageId,
        journeyId,
        contactId,
        error: error.message,
        stack: error.stack,
      });

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      throw new BadRequestException(
        'Failed to process journey webhook trigger',
      );
    }
  }

  async getJourneyVariables(id: string): Promise<any[]> {
    try {
      const journey = await this.findOne(id);

      return journey.variables || [];
    } catch (error) {
      this.logger.error(
        `Error getting variables for journey ${id}: ${error.message}`,
      );

      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new BadRequestException('Failed to get journey variables');
    }
  }

  async updateJourneyVariables(
    id: string,
    variables: any[],
  ): Promise<any[]> {
    try {
      const journey = await this.findOne(id);

      journey.variables = variables;

      await this.journeyRepository.save(journey);

      return journey.variables || [];
    } catch (error) {
      this.logger.error(
        `Error updating variables for journey ${id}: ${error.message}`,
      );

      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new BadRequestException('Failed to update journey variables');
    }
  }
}
