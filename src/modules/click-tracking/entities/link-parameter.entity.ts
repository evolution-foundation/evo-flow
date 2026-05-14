import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ShortLink } from './short-link.entity';

@Entity('link_parameters')
export class LinkParameter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'short_link_id' })
  shortLinkId: string;

  @Column()
  key: string;

  @Column()
  value: string;

  @Column({ default: false, name: 'is_utm' })
  isUtm: boolean;

  @ManyToOne(() => ShortLink, (link) => link.parameters, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'short_link_id' })
  shortLink: ShortLink;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
