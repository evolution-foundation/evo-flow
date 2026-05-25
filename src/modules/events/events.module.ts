import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventSearchController } from './controllers/event-search.controller';
import { EventSearchService } from './services/event-search.service';
import { ContactEventsController } from './controllers/contact-events.controller';
import { ContactEventsService } from './services/contact-events.service';
import { ProcessingModule } from '../processing/processing.module';

@Module({
  imports: [ProcessingModule],
  controllers: [
    EventsController,
    EventSearchController,
    ContactEventsController,
  ],
  providers: [EventsService, EventSearchService, ContactEventsService],
  exports: [EventsService, EventSearchService],
})
export class EventsModule {}
