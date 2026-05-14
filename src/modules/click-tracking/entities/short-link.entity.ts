import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { LinkParameter } from './link-parameter.entity';
import { CustomDomain } from './custom-domain.entity';

@Entity('short_links')
@Index(['shortCode'], { unique: true })
@Index(['campaignId'])
@Index(['journeyId'])
@Index(['customDomainId', 'customSlug'], { unique: true })
export class ShortLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 10, name: 'short_code' })
  shortCode: string;

  @Column({ type: 'text', name: 'original_url' })
  originalUrl: string;

  @Column({ type: 'uuid', nullable: true, name: 'campaign_id' })
  campaignId?: string;

  @Column({ type: 'uuid', nullable: true, name: 'journey_id' })
  journeyId?: string;

  @Column({ type: 'uuid', nullable: true, name: 'contact_id' })
  contactId?: string;

  // Custom Domain Support
  @Column({ type: 'uuid', nullable: true, name: 'custom_domain_id' })
  customDomainId?: string;

  @ManyToOne(() => CustomDomain, { nullable: true })
  @JoinColumn({ name: 'custom_domain_id' })
  customDomain?: CustomDomain;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'custom_slug' })
  customSlug?: string;

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'expires_at' })
  expiresAt?: Date;

  @Column({ type: 'text', nullable: true })
  title?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'json', nullable: true })
  metadata?: Record<string, any>;

  // Estatísticas agregadas (desnormalizado para performance)
  @Column({ default: 0, name: 'click_count' })
  clickCount: number;

  @Column({ default: 0, name: 'unique_click_count' })
  uniqueClickCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => LinkParameter, (param) => param.shortLink, {
    cascade: true,
  })
  parameters: LinkParameter[];

  // Transient property - not persisted to database
  shortUrl?: string;
}
