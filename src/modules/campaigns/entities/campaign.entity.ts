import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { CampaignTemplate } from './campaign-template.entity';
import { CampaignContact } from './campaign-contact.entity';

export enum CampaignStatus {
  DRAFT = 0,
  SCHEDULED = 1,
  SENDING = 2,
  PAUSED = 3,
  STOPPED = 4,
  COMPLETED = 5,
  SENDING_TESTAB = 6,
}

export enum CampaignType {
  SIMPLE = 'simple',
  TESTAB = 'testAB',
  SPLIT = 'split',
  RECURRING = 'recurring',
  TRIGGER = 'trigger',
}

export enum CampaignChannelType {
  EMAIL = 'Channel::Email',
  WHATSAPP = 'Channel::Whatsapp',
  SMS = 'Channel::Sms',
}

@Entity('campaigns')
@Index(['status'])
@Index(['inboxId'])
@Index(['channelType'])
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  title: string;

  @Column({ length: 40 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 100, nullable: true })
  publisher?: string;

  @Column({ name: 'schedule_to', type: 'timestamptz', nullable: true })
  scheduleTo?: Date;

  @Column({ name: 'scheduled_job_id', length: 255, nullable: true })
  scheduledJobId?: string;

  // Status and control
  @Column({ type: 'int', default: CampaignStatus.DRAFT })
  status: CampaignStatus;

  @Column({ name: 'spread_sending', type: 'int', nullable: true })
  spreadSending?: number;

  @Column({ name: 'sent_contacts', type: 'decimal', nullable: true })
  sentContacts?: number;

  // Aggregate failure counter for the distributed dispatch pipeline (story 4.6
  // / EVO-1220). Incremented per page by the campaigns.tracked aggregator.
  @Column({ name: 'failed_contacts', type: 'int', default: 0 })
  failedContacts: number;

  // Total pages the packer split the audience into, learned by the tracking
  // aggregator from the page whose campaigns.tracked carries completed=true
  // (story 4.6 / EVO-1220). Completion = distinct reported pages === totalPages.
  @Column({ name: 'total_pages', type: 'int', nullable: true })
  totalPages?: number;

  @Column({ name: 'sent_percentage', type: 'decimal', nullable: true })
  sentPercentage?: number;

  @Column({ type: 'text', nullable: true })
  query?: string;

  @Column({ type: 'jsonb', nullable: true })
  steps?: any;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  @Column({ name: 'send_to_all', type: 'boolean', default: false })
  sendToAll: boolean;

  @Column({ length: 30 })
  type: CampaignType;

  @Column({ name: 'inbox_id', type: 'uuid', nullable: true })
  inboxId?: string;

  @Column({ name: 'channel_type', length: 50, nullable: true })
  channelType?: CampaignChannelType;

  @Column({ name: 'is_rate_limit', type: 'boolean', default: false })
  isRateLimit: boolean;

  @Column({ name: 'is_run_segment', type: 'boolean', default: false })
  isRunSegment: boolean;

  @Column({ name: 'recurrence_count', type: 'int', default: 0 })
  recurrenceCount: number;

  @Column({ name: 'recurrence_settings', type: 'jsonb', nullable: true })
  recurrenceSettings?: any;

  @Column({ name: 'testab_name', length: 255, nullable: true })
  testabName?: string;

  @Column({ name: 'testab_subject', length: 255, nullable: true })
  testabSubject?: string;

  @Column({ name: 'testab_percentage', type: 'decimal', nullable: true })
  testabPercentage?: number;

  @Column({ name: 'testab_winner_criteria', length: 50, nullable: true })
  testabWinnerCriteria?: string;

  @Column({ name: 'testab_duration_hours', type: 'int', nullable: true })
  testabDurationHours?: number;

  @Column({ name: 'phone_number_strategy', length: 50, default: 'round_robin' })
  phoneNumberStrategy: string;

  @Column({ name: 'template_allocation_config', type: 'jsonb', default: {} })
  templateAllocationConfig: any;

  @Column({ name: 'delivery_distribution', type: 'jsonb', default: {} })
  deliveryDistribution: any;

  @Column({ name: 'trigger_config', type: 'jsonb', nullable: true })
  triggerConfig?: {
    trigger_type:
      | 'manual'
      | 'event'
      | 'segment'
      | 'webhook'
      | 'contactCreated'
      | 'contactUpdated'
      | 'label'
      | 'customAttribute';
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

  @OneToMany(() => CampaignTemplate, (template) => template.campaign, {
    cascade: true,
  })
  templates: CampaignTemplate[];

  @OneToMany(
    () => CampaignContact,
    (campaignContact) => campaignContact.campaign,
  )
  campaignContacts: CampaignContact[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt?: Date;
}
