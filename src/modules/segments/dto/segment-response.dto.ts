import { ApiProperty } from '@nestjs/swagger';
import { SegmentDefinition } from '../entities/segment.entity';

export class SegmentResponseDto {
  @ApiProperty({
    description: 'Segment ID (UUID)',
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  })
  id: string;

  @ApiProperty({
    description: 'Name of the segment',
    example: 'Active Users',
  })
  name: string;

  @ApiProperty({
    description: 'Segment definition with entry node and conditions',
    example: {
      entryNode: {
        type: 'Everyone',
        id: 'entry-1',
      },
      nodes: [],
    },
  })
  definition: SegmentDefinition;

  @ApiProperty({
    description: 'Segment status',
    example: 'running',
    enum: ['running', 'paused', 'completed'],
  })
  status: string;

  @ApiProperty({
    description: 'Number of contacts matching this segment (cached)',
    example: 150,
  })
  computedCount: number;

  @ApiProperty({
    description: 'Current number of contacts in this segment',
    example: 142,
  })
  contactsCount: number;

  @ApiProperty({
    description: 'Last computed timestamp',
    example: '2024-01-15T10:30:00Z',
    required: false,
  })
  lastComputedAt?: Date;

  @ApiProperty({
    description: 'Definition updated timestamp',
    example: '2024-01-15T10:30:00Z',
  })
  definitionUpdatedAt: Date;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2024-01-15T10:30:00Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-15T10:30:00Z',
  })
  updatedAt: Date;
}
