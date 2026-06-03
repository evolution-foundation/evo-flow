import { Global, Module } from '@nestjs/common';
import { SegmentsModule } from '../../modules/segments/segments.module';
import { SegmentQueryBuilderService } from './segment-query-builder.service';
import { AudienceComputationService } from './audience-computation.service';

/**
 * Global module exposing audience resolution (FR25/FR26) so both the legacy
 * operator-facing path (CampaignsModule) and the future campaign-packer
 * (Epic 4) consume the same logic without re-importing.
 *
 * Imports SegmentsModule for SegmentComputationService; TenantDbContext and
 * ContactsClientService come from their existing global modules.
 */
@Global()
@Module({
  imports: [SegmentsModule],
  providers: [SegmentQueryBuilderService, AudienceComputationService],
  exports: [SegmentQueryBuilderService, AudienceComputationService],
})
export class AudienceModule {}
