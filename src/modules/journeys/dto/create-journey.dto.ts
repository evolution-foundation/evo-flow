import {
  IsNotEmpty,
  IsString,
  IsObject,
  IsOptional,
  IsBoolean,
  IsArray,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FlowData, FlowTrigger } from '../entities/journey.entity';

export class CreateJourneyDto {
  @ApiProperty({
    description: 'Name of the journey',
    example: 'Welcome Journey',
    maxLength: 255,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: 'Description of the journey',
    example: 'A journey to welcome new users to the platform',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Whether the journey is active',
    example: true,
    default: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    description: 'Flow data containing nodes and edges for React Flow',
    example: {
      nodes: [
        {
          id: '1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          data: { label: 'Start' },
        },
      ],
      edges: [],
    },
  })
  @IsNotEmpty()
  @IsObject()
  flowData: FlowData;

  @ApiProperty({
    description: 'Triggers that start the journey',
    example: [
      {
        id: 'trigger-1',
        type: 'Event',
        name: 'User Signup',
        enabled: true,
        conditions: {
          eventName: 'user.signup',
        },
      },
    ],
  })
  @IsNotEmpty()
  @IsArray()
  flowTriggers: FlowTrigger[];
}
