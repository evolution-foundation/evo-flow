import { Module } from '@nestjs/common';
import { CustomAttributesService } from './custom-attributes.service';

/**
 * Thin CustomAttributesModule — controller and CRUD DTOs removed; CRM Rails
 * owns attribute definition management. The service delegates writes to
 * `CustomAttributesClientService` (provided globally by `CrmClientModule`).
 */
@Module({
  providers: [CustomAttributesService],
  exports: [CustomAttributesService],
})
export class CustomAttributesModule {}
