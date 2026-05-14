import {
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
  DataSource,
} from 'typeorm';
import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../entities/audit-log.entity';
import { ClsService } from 'nestjs-cls';

@Injectable()
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  constructor(
    private readonly cls: ClsService,
    dataSource: DataSource,
  ) {
    dataSource.subscribers.push(this);
  }

  private shouldAudit(entityName: string): boolean {
    return entityName !== 'AuditLog';
  }

  private async createAuditLog(
    event: InsertEvent<any> | UpdateEvent<any> | RemoveEvent<any>,
    transactionType: string,
    newData: any = null,
  ) {
    try {
      const auditLog = new AuditLog();
      auditLog.transactionId = this.cls.get('transactionId');
      auditLog.userId = this.cls.get('user')?.id;
      auditLog.entity = event.metadata.name;
      auditLog.entityId = event.entity.id;
      auditLog.transactionType = transactionType;
      auditLog.json = newData;
      auditLog.ipAddress = this.cls.get('ip');
      auditLog.userAgent = this.cls.get('userAgent');

      await event.manager.save(auditLog);
    } catch (error) {
      console.error('Error creating audit log:', error);
      throw error;
    }
  }

  async afterInsert(event: InsertEvent<any>): Promise<void> {
    if (!this.shouldAudit(event.metadata.name) || !event.entity) return;

    await this.createAuditLog(event, 'CREATE', event.entity);
  }

  async afterUpdate(event: UpdateEvent<any>): Promise<void> {
    if (!this.shouldAudit(event.metadata.name) || !event.entity) return;

    await this.createAuditLog(event, 'UPDATE', event.entity);
  }

  async afterRemove(event: RemoveEvent<any>): Promise<void> {
    if (!this.shouldAudit(event.metadata.name) || !event.entity) return;

    await this.createAuditLog(event, 'DELETE', event.entity);
  }
}
