import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';

/**
 * Thin ContactsModule — `ContactsService` is now a facade over
 * `ContactsClientService` (provided by the global `CrmClientModule`).
 *
 * No TypeORM features registered here: persistence lives in the CRM.
 * The legacy `Contact` entity is still imported as a type by other modules
 * (cache, custom-attributes, campaigns, temporal) and remains in
 * `entities/contact.entity.ts` for now — see Q3 follow-up for full removal.
 */
@Module({
  imports: [],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
