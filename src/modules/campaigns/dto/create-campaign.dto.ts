import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsObject,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CampaignType, CampaignStatus, CampaignChannelType } from '../entities/campaign.entity';

export class CreateCampaignDto {
  @ApiProperty({
    description: 'Campaign title',
    example: 'Black Friday 2025',
  })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: 'Campaign name (unique per account, max 40 chars)',
    example: 'black-friday-2025',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: 'Campaign description',
    example: 'Black Friday promotional campaign',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Publisher name',
    example: 'Marketing Team',
  })
  @IsOptional()
  @IsString()
  publisher?: string;

  @ApiPropertyOptional({
    description: 'Schedule campaign to start at this date/time',
    example: '2025-11-25T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  scheduleTo?: string;

  @ApiProperty({
    description: 'Campaign type',
    enum: CampaignType,
    example: CampaignType.SIMPLE,
  })
  @IsEnum(CampaignType)
  type: CampaignType;

  @ApiPropertyOptional({
    description: 'Channel type',
    enum: CampaignChannelType,
    example: CampaignChannelType.WHATSAPP,
  })
  @IsOptional()
  @IsEnum(CampaignChannelType)
  channelType?: CampaignChannelType;

  @ApiPropertyOptional({
    description: 'Inbox ID - single inbox per campaign (each channel requires its own campaign)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsUUID()
  inboxId?: string;

  @ApiPropertyOptional({
    description: 'Enable rate limiting',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isRateLimit?: boolean;

  @ApiPropertyOptional({
    description: 'Run segmentation query when campaign starts',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isRunSegment?: boolean;

  @ApiPropertyOptional({
    description: 'Spread sending over N hours',
    example: 24,
  })
  @IsOptional()
  @IsNumber()
  spreadSending?: number;

  @ApiPropertyOptional({
    description: 'Send to all contacts (ignore segmentation)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  sendToAll?: boolean;

  @ApiPropertyOptional({
    description: 'Segmentation query (SQL)',
    example: 'SELECT * FROM contacts WHERE blocked = false',
  })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({
    description: 'Segmentation steps (JSON)',
    example: [{ type: 'filter', field: 'email', operator: 'is_not_empty' }],
  })
  @IsOptional()
  @IsObject()
  steps?: any;

  @ApiPropertyOptional({
    description: 'Tags for filtering',
    example: ['vip', 'newsletter'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  // A/B Testing fields
  @ApiPropertyOptional({
    description: 'A/B test name',
    example: 'Subject Line Test',
  })
  @IsOptional()
  @IsString()
  testabName?: string;

  @ApiPropertyOptional({
    description: 'A/B test subject',
    example: 'Which subject performs better?',
  })
  @IsOptional()
  @IsString()
  testabSubject?: string;

  @ApiPropertyOptional({
    description: 'A/B test percentage (0-100)',
    example: 20,
  })
  @IsOptional()
  @IsNumber()
  testabPercentage?: number;

  @ApiPropertyOptional({
    description: 'A/B test winner criteria',
    example: 'open_rate',
  })
  @IsOptional()
  @IsString()
  testabWinnerCriteria?: string;

  @ApiPropertyOptional({
    description: 'A/B test duration in hours',
    example: 24,
  })
  @IsOptional()
  @IsNumber()
  testabDurationHours?: number;

  // Recurrence fields
  @ApiPropertyOptional({
    description: 'Recurrence count',
    example: 0,
  })
  @IsOptional()
  @IsNumber()
  recurrenceCount?: number;

  @ApiPropertyOptional({
    description: 'Recurrence settings (JSON)',
    example: { frequency: 'weekly', dayOfWeek: 1 },
  })
  @IsOptional()
  @IsObject()
  recurrenceSettings?: any;

  // Rotation strategy
  @ApiPropertyOptional({
    description: 'Inbox rotation strategy',
    example: 'round_robin',
  })
  @IsOptional()
  @IsString()
  phoneNumberStrategy?: string;

  @ApiPropertyOptional({
    description: 'Template allocation configuration (JSON)',
    example: {},
  })
  @IsOptional()
  @IsObject()
  templateAllocationConfig?: any;

  @ApiPropertyOptional({
    description: 'Delivery distribution configuration (JSON)',
    example: {},
  })
  @IsOptional()
  @IsObject()
  deliveryDistribution?: any;

  @ApiPropertyOptional({
    description: 'Trigger configuration for trigger-based campaigns',
    example: {
      trigger_type: 'event',
      event_name: 'contact_created',
      event_properties: [
        { path: 'properties.source', operator: 'Equals', value: 'web' },
      ],
    },
  })
  @IsOptional()
  @IsObject()
  triggerConfig?: {
    trigger_type: 'manual' | 'event' | 'segment' | 'webhook' | 'contactCreated' | 'contactUpdated' | 'label' | 'customAttribute';
    // Event config
    event_name?: string;
    event_properties?: Array<{
      path: string;
      operator: string;
      value?: any;
    }>;
    // Segment config
    segment_id?: string;
    segment_name?: string;
    segment_action?: 'entered' | 'exited';
    // Contact config
    contact_fields?: Array<{
      field: string;
      operator: string;
      value?: any;
    }>;
    // Label config
    label_id?: string;
    label_name?: string;
    label_action?: 'applied' | 'removed';
    // Custom attribute config
    custom_attribute_name?: string;
    custom_attribute_display_name?: string;
    custom_attribute_operator?: string;
    custom_attribute_value?: string;
    // Webhook config
    webhook_url?: string;
    webhook_secret?: string;
    webhook_method?: 'POST' | 'PUT' | 'PATCH';
    expected_headers?: Array<{
      name: string;
      value: string;
    }>;
  };
}
