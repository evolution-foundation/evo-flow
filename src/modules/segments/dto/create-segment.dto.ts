import {
  IsNotEmpty,
  IsString,
  IsObject,
  IsOptional,
  IsIn,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SegmentDefinition } from '../entities/segment.entity';

export class CreateSegmentDto {
  @ApiProperty({
    description: 'Name of the segment',
    example: 'Active Users',
  })
  @IsNotEmpty()
  @IsString()
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
  @IsNotEmpty()
  @IsObject()
  definition: SegmentDefinition;

  @ApiProperty({
    description: 'Segment status',
    example: 'running',
    enum: ['running', 'paused', 'completed'],
    required: false,
  })
  @IsOptional()
  @IsIn(['running', 'paused', 'completed'])
  status?: string;
}
