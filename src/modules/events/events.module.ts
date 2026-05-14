import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventSearchController } from './controllers/event-search.controller';
import { EventSearchService } from './services/event-search.service';
import { ProcessingModule } from '../processing/processing.module';

@Module({
  imports: [ProcessingModule],
  controllers: [EventsController, EventSearchController],
  providers: [EventsService, EventSearchService],
  exports: [EventsService, EventSearchService],
})
export class EventsModule {}
