import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from 'src/entities/audit-log.entity';
import { AuditSubscriber } from './subscribers/audit.subscriber';
import { AuditService } from './audit.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog])
  ],
  providers: [AuditSubscriber, AuditService],
  exports: [AuditSubscriber, AuditService],
})
export class AuditModule {} 