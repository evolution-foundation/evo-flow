import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CampaignTemplate } from '../entities/campaign-template.entity';
import { Campaign } from '../entities/campaign.entity';
import { CreateCampaignTemplateDto } from '../dto';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';

@Injectable()
export class CampaignTemplatesService {
  constructor(
    @InjectRepository(CampaignTemplate)
    private readonly campaignTemplateRepository: Repository<CampaignTemplate>,
    @InjectRepository(Campaign)
    private readonly campaignRepository: Repository<Campaign>,
    @InjectRepository(MessageTemplate)
    private readonly messageTemplateRepository: Repository<MessageTemplate>,
  ) {}

  async create(
    campaignId: string,
    createTemplateDto: CreateCampaignTemplateDto,
  ): Promise<CampaignTemplate> {
    // Verify campaign exists
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign with ID "${campaignId}" not found`);
    }

    // Verify message template exists
    const messageTemplate = await this.messageTemplateRepository.findOne({
      where: { id: createTemplateDto.messageTemplateId, active: true },
    });

    if (!messageTemplate) {
      throw new NotFoundException(
        `Message template with ID "${createTemplateDto.messageTemplateId}" not found or inactive`,
      );
    }

    // Check for duplicate variant
    const existingTemplate = await this.campaignTemplateRepository.findOne({
      where: {
        campaignId,
        messageTemplateId: createTemplateDto.messageTemplateId,
        variant: createTemplateDto.variant || 'A',
      },
    });

    if (existingTemplate) {
      throw new BadRequestException(
        `Template variant "${createTemplateDto.variant || 'A'}" already exists for this campaign and message template`,
      );
    }

    const campaignTemplate = this.campaignTemplateRepository.create({
      campaignId,
      messageTemplateId: createTemplateDto.messageTemplateId,
      variant: createTemplateDto.variant || 'A',
      isWinner: createTemplateDto.isWinner || false,
      statistics: createTemplateDto.statistics || {},
    });

    return this.campaignTemplateRepository.save(campaignTemplate);
  }

  async findAll(campaignId: string): Promise<CampaignTemplate[]> {
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign with ID "${campaignId}" not found`);
    }

    return this.campaignTemplateRepository.find({
      where: { campaignId },
      order: { variant: 'ASC' },
    });
  }

  async findOne(
    id: string,
    campaignId: string,
  ): Promise<CampaignTemplate> {
    const template = await this.campaignTemplateRepository.findOne({
      where: { id, campaignId },
    });

    if (!template) {
      throw new NotFoundException(
        `Campaign template with ID "${id}" not found`,
      );
    }

    return template;
  }

  async remove(id: string, campaignId: string): Promise<void> {
    const template = await this.findOne(id, campaignId);
    await this.campaignTemplateRepository.remove(template);
  }

  async updateStatistics(
    id: string,
    campaignId: string,
    statistics: any,
  ): Promise<CampaignTemplate> {
    const template = await this.findOne(id, campaignId);
    template.statistics = { ...template.statistics, ...statistics };
    return this.campaignTemplateRepository.save(template);
  }

  async setWinner(
    id: string,
    campaignId: string,
  ): Promise<CampaignTemplate> {
    const template = await this.findOne(id, campaignId);

    // Unset other winners
    await this.campaignTemplateRepository.update(
      { campaignId },
      { isWinner: false },
    );

    // Set this as winner
    template.isWinner = true;
    return this.campaignTemplateRepository.save(template);
  }
}
