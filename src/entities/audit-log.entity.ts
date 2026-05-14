import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  BaseEntity,
} from 'typeorm';
import { User } from './user.entity';

@Entity('audit_logs')
export class AuditLog extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'varchar', length: 255 })
  transactionId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  entity: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @Column({ name: 'transaction_type', type: 'varchar', length: 255 })
  transactionType: string;

  @Column({ type: 'json' })
  json: any;

  @Column({ name: 'ip_address', type: 'varchar', length: 255, nullable: true })
  ipAddress: string;

  @Column({ name: 'user_agent', type: 'varchar', length: 600, nullable: true })
  userAgent: string;

  @Column({ default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
