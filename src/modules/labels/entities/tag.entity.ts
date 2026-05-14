import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Tagging } from './tagging.entity';

@Entity('tags')
@Index(['name'], { unique: true })
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ name: 'taggings_count', default: 0 })
  taggingsCount: number;

  @OneToMany(() => Tagging, (tagging) => tagging.tag)
  taggings: Tagging[];
}
