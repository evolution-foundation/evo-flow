import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Campaign, CampaignStatus, CampaignType } from '../entities/campaign.entity';
import { CreateCampaignDto, UpdateCampaignDto, CampaignQueryDto } from '../dto';

@Injectable()
export class CampaignsService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepository: Repository<Campaign>,
  ) {}

  async create(createCampaignDto: CreateCampaignDto): Promise<Campaign> {
    // Check for duplicate name
    const existingCampaign = await this.campaignRepository.findOne({
      where: { name: createCampaignDto.name },
    });

    if (existingCampaign) {
      throw new ConflictException(
        `Campaign with name "${createCampaignDto.name}" already exists`,
      );
    }

    const campaign = this.campaignRepository.create({
      ...createCampaignDto,
      status: CampaignStatus.DRAFT,
      type: createCampaignDto.type || CampaignType.SIMPLE,
      phoneNumberStrategy: createCampaignDto.phoneNumberStrategy || 'round_robin',
      templateAllocationConfig: createCampaignDto.templateAllocationConfig || {},
      deliveryDistribution: createCampaignDto.deliveryDistribution || {},
    });

    return this.campaignRepository.save(campaign);
  }

  async findAll(queryDto?: CampaignQueryDto): Promise<{ campaigns: Campaign[]; total: number; page: number; pageSize: number }> {
    const {
      page = 1,
      per_page = 25,
      sort = 'created_at',
      order = 'desc',
      status,
      type,
      channel_type,
      search,
    } = queryDto || {};

    const skip = (page - 1) * per_page;

    // Build query builder for complex queries (search)
    const queryBuilder = this.campaignRepository.createQueryBuilder('campaign');

    // Apply filters
    if (status && status.length > 0) {
      queryBuilder.andWhere('campaign.status IN (:...status)', { status });
    }

    if (type && type.length > 0) {
      queryBuilder.andWhere('campaign.type IN (:...type)', { type });
    }

    if (channel_type && channel_type.length > 0) {
      queryBuilder.andWhere('campaign.channelType IN (:...channelType)', { channelType: channel_type });
    }

    // Apply search
    if (search) {
      queryBuilder.andWhere(
        '(campaign.title ILIKE :search OR campaign.name ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    // Apply sorting
    const sortField = sort === 'created_at' ? 'campaign.createdAt' :
                      sort === 'schedule_to' ? 'campaign.scheduleTo' :
                      sort === 'name' ? 'campaign.name' :
                      'campaign.status';

    queryBuilder.orderBy(sortField, order.toUpperCase() as 'ASC' | 'DESC');

    // Apply pagination
    queryBuilder.skip(skip).take(per_page);

    const [campaigns, total] = await queryBuilder.getManyAndCount();

    return {
      campaigns,
      total,
      page,
      pageSize: per_page,
    };
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepository.findOne({
      where: { id },
      relations: ['templates', 'campaignContacts'],
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign with ID "${id}" not found`);
    }

    return campaign;
  }

  async update(
    id: string,
    updateCampaignDto: UpdateCampaignDto,
  ): Promise<Campaign> {
    const campaign = await this.findOne(id);

    // Check for duplicate name if name is being updated
    if (updateCampaignDto.name && updateCampaignDto.name !== campaign.name) {
      const existingCampaign = await this.campaignRepository.findOne({
        where: { name: updateCampaignDto.name },
      });

      if (existingCampaign) {
        throw new ConflictException(
          `Campaign with name "${updateCampaignDto.name}" already exists`,
        );
      }
    }

    // Prevent status changes that don't make sense
    if (updateCampaignDto.status !== undefined) {
      this.validateStatusTransition(campaign.status, updateCampaignDto.status);
    }

    Object.assign(campaign, updateCampaignDto);
    return this.campaignRepository.save(campaign);
  }

  async remove(id: string): Promise<void> {
    const campaign = await this.findOne(id);
    await this.campaignRepository.softRemove(campaign);
  }

  async schedule(id: string, scheduleTo: Date): Promise<Campaign> {
    const campaign = await this.findOne(id);

    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException(
        `Only campaigns in DRAFT status can be scheduled. Current status: ${campaign.status}`,
      );
    }

    campaign.scheduleTo = scheduleTo;
    campaign.status = CampaignStatus.SCHEDULED;

    return this.campaignRepository.save(campaign);
  }

  async pause(id: string): Promise<Campaign> {
    const campaign = await this.findOne(id);

    if (campaign.status !== CampaignStatus.SENDING) {
      throw new BadRequestException(
        `Only campaigns in SENDING status can be paused. Current status: ${campaign.status}`,
      );
    }

    campaign.status = CampaignStatus.PAUSED;
    return this.campaignRepository.save(campaign);
  }

  async resume(id: string): Promise<Campaign> {
    const campaign = await this.findOne(id);

    if (campaign.status !== CampaignStatus.PAUSED) {
      throw new BadRequestException(
        `Only campaigns in PAUSED status can be resumed. Current status: ${campaign.status}`,
      );
    }

    campaign.status = CampaignStatus.SENDING;
    return this.campaignRepository.save(campaign);
  }

  async stop(id: string): Promise<Campaign> {
    const campaign = await this.findOne(id);

    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.SCHEDULED &&
      campaign.status !== CampaignStatus.SENDING &&
      campaign.status !== CampaignStatus.PAUSED
    ) {
      throw new BadRequestException(
        `Only campaigns in DRAFT, SCHEDULED, SENDING or PAUSED status can be stopped. Current status: ${campaign.status}`,
      );
    }

    campaign.status = CampaignStatus.STOPPED;
    return this.campaignRepository.save(campaign);
  }

  async duplicate(id: string): Promise<Campaign> {
    const original = await this.findOne(id);

    const duplicated = this.campaignRepository.create({
      ...original,
      id: undefined,
      name: `${original.name}_copy`,
      title: `${original.title} (Copy)`,
      status: CampaignStatus.DRAFT,
      sentContacts: undefined,
      sentPercentage: undefined,
      scheduleTo: undefined,
      scheduledJobId: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      deletedAt: undefined,
    });

    return this.campaignRepository.save(duplicated);
  }

  async bulkAction(
    action: 'pause' | 'resume' | 'delete',
    campaignIds: string[],
  ): Promise<{ message: string; affected_count: number }> {
    if (campaignIds.length === 0) {
      throw new BadRequestException('No campaign IDs provided');
    }

    const campaigns = await this.campaignRepository.find({
      where: { id: In(campaignIds) },
    });

    if (campaigns.length === 0) {
      throw new NotFoundException('No campaigns found with provided IDs');
    }

    let affectedCount = 0;

    for (const campaign of campaigns) {
      try {
        if (action === 'pause') {
          if (campaign.status === CampaignStatus.SENDING) {
            campaign.status = CampaignStatus.PAUSED;
            await this.campaignRepository.save(campaign);
            affectedCount++;
          }
        } else if (action === 'resume') {
          if (campaign.status === CampaignStatus.PAUSED) {
            campaign.status = CampaignStatus.SENDING;
            await this.campaignRepository.save(campaign);
            affectedCount++;
          }
        } else if (action === 'delete') {
          await this.campaignRepository.softRemove(campaign);
          affectedCount++;
        }
      } catch (error) {
        // Continue with other campaigns even if one fails
        console.error(`Failed to ${action} campaign ${campaign.id}:`, error);
      }
    }

    return {
      message: `Bulk ${action} completed`,
      affected_count: affectedCount,
    };
  }

  async getStats(id: string): Promise<{
    total_sent: number;
    total_delivered: number;
    total_read: number;
    total_errors: number;
    delivery_rate: number;
    read_rate: number;
  }> {
    const campaign = await this.findOne(id);

    // TODO: Implement actual statistics calculation from campaign_contacts and messages
    // For now, return mock data based on campaign status
    const totalSent = campaign.sentContacts ? Number(campaign.sentContacts) : 0;
    const totalDelivered = Math.floor(totalSent * 0.95);
    const totalRead = Math.floor(totalDelivered * 0.7);
    const totalErrors = totalSent - totalDelivered;
    const deliveryRate = totalSent > 0 ? (totalDelivered / totalSent) * 100 : 0;
    const readRate = totalDelivered > 0 ? (totalRead / totalDelivered) * 100 : 0;

    return {
      total_sent: totalSent,
      total_delivered: totalDelivered,
      total_read: totalRead,
      total_errors: totalErrors,
      delivery_rate: parseFloat(deliveryRate.toFixed(2)),
      read_rate: parseFloat(readRate.toFixed(2)),
    };
  }

  private validateStatusTransition(currentStatus: CampaignStatus, newStatus: CampaignStatus): void {
    const validTransitions: Record<CampaignStatus, CampaignStatus[]> = {
      [CampaignStatus.DRAFT]: [
        CampaignStatus.SCHEDULED,
        CampaignStatus.SENDING,
        CampaignStatus.DRAFT,
      ],
      [CampaignStatus.SCHEDULED]: [
        CampaignStatus.SENDING,
        CampaignStatus.DRAFT,
        CampaignStatus.SCHEDULED,
      ],
      [CampaignStatus.SENDING]: [
        CampaignStatus.PAUSED,
        CampaignStatus.STOPPED,
        CampaignStatus.COMPLETED,
        CampaignStatus.SENDING,
      ],
      [CampaignStatus.PAUSED]: [
        CampaignStatus.SENDING,
        CampaignStatus.STOPPED,
        CampaignStatus.PAUSED,
      ],
      [CampaignStatus.STOPPED]: [CampaignStatus.STOPPED],
      [CampaignStatus.COMPLETED]: [CampaignStatus.COMPLETED],
      [CampaignStatus.SENDING_TESTAB]: [
        CampaignStatus.SENDING,
        CampaignStatus.STOPPED,
        CampaignStatus.SENDING_TESTAB,
      ],
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw new BadRequestException(
        `Invalid status transition from ${CampaignStatus[currentStatus]} to ${CampaignStatus[newStatus]}`,
      );
    }
  }
}
