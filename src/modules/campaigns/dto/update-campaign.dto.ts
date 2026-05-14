import { PartialType } from '@nestjs/swagger';
import { CreateCampaignDto } from './create-campaign.dto';
import { IsOptional, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignStatus } from '../entities/campaign.entity';

export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {
  @ApiPropertyOptional({
    description: 'Campaign status',
    enum: CampaignStatus,
    example: CampaignStatus.SCHEDULED,
  })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;
}
