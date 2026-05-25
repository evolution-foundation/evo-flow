import { ApiProperty } from '@nestjs/swagger';
import { ContactEventChType } from './list-contact-events-query.dto';

export class ContactEventDto {
  @ApiProperty({ description: 'Event ID (UUID)' })
  id: string;

  @ApiProperty({ description: 'Contact ID' })
  contactId: string;

  // Mirrors the actual ClickHouse Enum8 subset (no `journey`) so the response
  // contract matches what the column can produce, not the wider app-level enum.
  @ApiProperty({
    description: 'Event type',
    enum: ['identify', 'track', 'page', 'screen', 'segment'],
  })
  eventType: ContactEventChType;

  @ApiProperty({ description: 'Event name' })
  eventName: string;

  @ApiProperty({ description: 'Event timestamp (ISO8601)' })
  occurredAt: string;

  @ApiProperty({ description: 'Event properties (parsed JSON)' })
  properties: Record<string, unknown>;

  @ApiProperty({ description: 'Event traits (parsed JSON)' })
  traits: Record<string, unknown>;

  @ApiProperty({ description: 'Originating message ID', required: false })
  messageId?: string;

  @ApiProperty({ description: 'Anonymous ID', required: false })
  anonymousId?: string;
}

export class ContactEventsPaginationDto {
  @ApiProperty({
    description: 'Opaque cursor for the next page (null when no more pages)',
    nullable: true,
  })
  nextCursor: string | null;

  @ApiProperty({ description: 'Whether more pages exist' })
  hasNext: boolean;

  @ApiProperty({ description: 'Items per page actually applied' })
  limit: number;
}

export class ContactEventsResponseDto {
  @ApiProperty({ type: [ContactEventDto] })
  events: ContactEventDto[];

  @ApiProperty({ type: ContactEventsPaginationDto })
  pagination: ContactEventsPaginationDto;
}
