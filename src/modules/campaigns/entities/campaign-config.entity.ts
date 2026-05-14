import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export interface CampaignConfigData {
  rate_limits?: {
    whatsapp?: number;
    email?: number;
    sms?: number;
    [key: string]: number | undefined;
  };
  retry?: {
    max_attempts?: number;
    delay_ms?: number;
  };
  allocation?: {
    strategy?: string;
    max_messages_per_number?: number;
  };
  
  schedule?: {
    week_days?: number[];
    time_ranges?: Array<{
      start: string;
      end: string;
      timezone?: string;
    }>;
    business_hours?: {
      enabled: boolean;
      start: string;
      end: string;
      timezone?: string;
    };
    max_frequency?: {
      per_day?: number;
      per_hour?: number;
    };
  };
  
  templates?: {
    default_language?: string;
  };
}

@Entity('campaigns_configs')
export class CampaignConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', default: {} })
  configs: CampaignConfigData;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
