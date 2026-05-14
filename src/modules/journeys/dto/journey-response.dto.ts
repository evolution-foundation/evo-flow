import { ApiProperty } from '@nestjs/swagger';
import { FlowData, FlowTrigger } from '../entities/journey.entity';

export class JourneyResponseDto {
  @ApiProperty({
    description: 'Journey ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'Name of the journey',
    example: 'Welcome Journey',
  })
  name: string;

  @ApiProperty({
    description: 'Description of the journey',
    example: 'A journey to welcome new users to the platform',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Whether the journey is active',
    example: true,
  })
  isActive: boolean;

  @ApiProperty({
    description: 'Flow data containing nodes and edges for React Flow',
  })
  flowData: FlowData;

  @ApiProperty({
    description: 'Triggers that start the journey',
  })
  flowTriggers: FlowTrigger[];

  @ApiProperty({
    description: 'Journey creation date',
    example: '2024-01-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Journey last update date',
    example: '2024-01-01T00:00:00.000Z',
  })
  updatedAt: Date;
}
