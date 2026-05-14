import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CampaignExecution,
  CampaignExecutionStatus,
} from '../entities/campaign-execution.entity';

const ACTIVE_STATUSES = [
  CampaignExecutionStatus.RUNNING,
  CampaignExecutionStatus.PAUSED,
] as const;

@Injectable()
export class CampaignExecutionsService {
  constructor(
    @InjectRepository(CampaignExecution)
    private readonly executionsRepository: Repository<CampaignExecution>,
  ) {}

  async createExecution(input: {
    campaignId: string;
    workflowId: string;
    runId: string;
    metadata?: Record<string, any>;
  }): Promise<CampaignExecution> {
    const entity = this.executionsRepository.create({
      campaignId: input.campaignId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: CampaignExecutionStatus.RUNNING,
      metadata: input.metadata || {},
    });

    return this.executionsRepository.save(entity);
  }

  async getActiveExecution(
    campaignId: string,
  ): Promise<CampaignExecution | null> {
    return this.executionsRepository.findOne({
      where: {
        campaignId,
        status: In([...ACTIVE_STATUSES]),
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async getLatestExecution(
    campaignId: string,
  ): Promise<CampaignExecution | null> {
    return this.executionsRepository.findOne({
      where: { campaignId },
      order: { createdAt: 'DESC' },
    });
  }

  async updateStatus(
    executionId: string,
    status: CampaignExecutionStatus,
    updates?: Partial<CampaignExecution>,
  ): Promise<void> {
    await this.executionsRepository.update(
      { id: executionId },
      {
        status,
        ...updates,
        ...(status === CampaignExecutionStatus.COMPLETED ||
        status === CampaignExecutionStatus.FAILED ||
        status === CampaignExecutionStatus.CANCELLED
          ? { endedAt: new Date() }
          : {}),
      },
    );
  }

  async updateProgress(
    executionId: string,
    updates: {
      totalContacts?: number;
      processedContacts?: number;
      sentContacts?: number;
      failedContacts?: number;
      currentBatch?: number;
      totalBatches?: number;
      metadata?: Record<string, any>;
    },
  ): Promise<void> {
    await this.executionsRepository.update({ id: executionId }, updates);
  }

  async markFailed(
    executionId: string,
    error: string,
    updates?: Partial<CampaignExecution>,
  ): Promise<void> {
    await this.executionsRepository.update(
      { id: executionId },
      {
        status: CampaignExecutionStatus.FAILED,
        lastError: error,
        endedAt: new Date(),
        ...updates,
      },
    );
  }
}
