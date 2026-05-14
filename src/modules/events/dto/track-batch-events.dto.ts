import { IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TrackBatchEventsDto {
  @ApiProperty({
    description: 'Array of events to process in batch',
    type: 'array',
    example: [
      {
        messageId: '123',
        contactId: 'user_789',
        event: 'button_clicked',
        properties: { button_id: 'submit_form' },
      },
      {
        messageId: '124',
        contactId: 'user_789',
        eventType: 'opened',
        properties: { subject: 'Welcome email' },
      },
    ],
  })
  @IsArray()
  events: Array<any>;
}
