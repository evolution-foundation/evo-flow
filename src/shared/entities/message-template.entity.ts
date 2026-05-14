import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('message_templates')
@Index(['channelType', 'channelId', 'active'])
@Index(['channelType', 'channelId'])
@Index(['name'])
@Index(['category'])
@Index(['templateType'])
export class MessageTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'channel_id', type: 'uuid' })
  channelId: string;

  @Column({ name: 'channel_type', length: 255 })
  channelType: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ length: 10, default: 'pt_BR' })
  language: string;

  @Column({ length: 255, nullable: true })
  category?: string;

  @Column({ name: 'template_type', length: 50, nullable: true })
  templateType?: string;

  @Column({ type: 'jsonb', default: {} })
  components: any;

  @Column({ type: 'jsonb', default: [] })
  variables: any[];

  @Column({ name: 'media_url', length: 500, nullable: true })
  mediaUrl?: string;

  @Column({ name: 'media_type', length: 50, nullable: true })
  mediaType?: string;

  @Column({ type: 'jsonb', default: {} })
  settings: any;

  @Column({ type: 'jsonb', default: {} })
  metadata: any;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
