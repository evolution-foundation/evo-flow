import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tag } from './tag.entity';

export enum TaggableType {
  CONTACT = 'Contact',
  CONVERSATION = 'Conversation',
}

export enum TaggerType {
  USER = 'User',
  ADMIN = 'Admin',
}

@Entity('taggings')
@Index(['tagId'])
@Index(['taggableId', 'taggableType', 'context'])
@Index(['taggableId'])
@Index(['taggableType'])
@Index(['taggerId', 'taggerType'])
@Index(['taggerId'])
@Index(
  ['tagId', 'taggableId', 'taggableType', 'context', 'taggerId', 'taggerType'],
  { unique: true },
)
export class Tagging {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tag_id', type: 'uuid' })
  tagId: string;

  @Column({ name: 'taggable_type' })
  taggableType: TaggableType;

  @Column({ name: 'taggable_id', type: 'uuid' })
  taggableId: string;

  @Column({ name: 'tagger_type', nullable: true })
  taggerType?: TaggerType;

  @Column({ name: 'tagger_id', type: 'uuid', nullable: true })
  taggerId?: string;

  @Column({ length: 128, nullable: true })
  context?: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
  })
  createdAt: Date;

  // Relacionamentos
  @ManyToOne(() => Tag, (tag) => tag.taggings)
  @JoinColumn({ name: 'tag_id' })
  tag: Tag;

  // Métodos de conveniência
  get isContactTagging(): boolean {
    return this.taggableType === TaggableType.CONTACT;
  }

  get isConversationTagging(): boolean {
    return this.taggableType === TaggableType.CONVERSATION;
  }

  get isLabelsContext(): boolean {
    return this.context === 'labels';
  }
}
