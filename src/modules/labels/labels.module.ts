import { Module } from '@nestjs/common';
import { LabelsService } from './labels.service';
import { TaggingService } from './services/tagging.service';

/**
 * Thin LabelsModule — labels live in evo-ai-crm-community (Rails
 * acts_as_taggable_on). Both `LabelsService` and `TaggingService` are now
 * facades over the global `CrmClientModule` (`ContactsClientService`).
 *
 * No `TypeOrmModule.forFeature(...)` is registered here: there is no local
 * persistence. The legacy `Label` / `Tag` entities have been removed; the
 * `Tagging` entity file remains only because `Contact.taggings` still
 * declares a `@OneToMany` relation against it (full removal is tracked
 * outside this sub-spec).
 */
@Module({
  imports: [],
  providers: [LabelsService, TaggingService],
  exports: [LabelsService, TaggingService],
})
export class LabelsModule {}
