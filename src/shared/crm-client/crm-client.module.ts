import { Global, Module } from '@nestjs/common';
import { ContactsClientService } from './contacts-client.service';
import { CrmClientService } from './crm-client.service';
import { CustomAttributesClientService } from './custom-attributes-client.service';

/**
 * Global module — once imported in AppModule, any service in any feature
 * module can inject `CrmClientService`, `ContactsClientService`, or
 * `CustomAttributesClientService` without re-importing.
 */
@Global()
@Module({
  providers: [
    CrmClientService,
    ContactsClientService,
    CustomAttributesClientService,
  ],
  exports: [
    CrmClientService,
    ContactsClientService,
    CustomAttributesClientService,
  ],
})
export class CrmClientModule {}
