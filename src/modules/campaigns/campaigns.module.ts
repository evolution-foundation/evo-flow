import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Campaign } from './entities/campaign.entity';
import { CampaignTemplate } from './entities/campaign-template.entity';
import { CampaignContact } from './entities/campaign-contact.entity';
import { CampaignConfig } from './entities/campaign-config.entity';
import { CampaignExecution } from './entities/campaign-execution.entity';
import { MessageTemplate } from '../../shared/entities/message-template.entity';
import { Segment } from '../segments/entities/segment.entity';
import { Tagging } from '../labels/entities/tagging.entity';
import { CampaignsController } from './controllers/campaigns.controller';
import { CampaignTemplatesController } from './controllers/campaign-templates.controller';
import { CampaignsService } from './services/campaigns.service';
import { CampaignTemplatesService } from './services/campaign-templates.service';
import { TemplateReplicationService } from './services/template-replication.service';
import { AudienceValidationService } from './services/audience-validation.service';
import { CampaignWorkflowService } from './services/campaign-workflow.service';
import { CampaignExecutionsService } from './services/campaign-executions.service';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Campaign,
      CampaignTemplate,
      CampaignContact,
      CampaignConfig,
      CampaignExecution,
      MessageTemplate,
      Segment,
      Tagging,
    ]),
    ConfigModule,
    ContactsModule,
  ],
  controllers: [CampaignsController, CampaignTemplatesController],
  providers: [
    CampaignsService,
    CampaignTemplatesService,
    TemplateReplicationService,
    AudienceValidationService,
    CampaignWorkflowService,
    CampaignExecutionsService,
  ],
  exports: [
    CampaignsService,
    CampaignTemplatesService,
    TemplateReplicationService,
    AudienceValidationService,
    CampaignWorkflowService,
    CampaignExecutionsService,
  ],
})
export class CampaignsModule {}
