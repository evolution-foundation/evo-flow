import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject } from 'class-validator';
import { SegmentDefinition } from '../entities/segment.entity';

export class PreviewSegmentDto {
  @ApiProperty({
    description:
      'Inline segment definition to preview. It is computed but never persisted.',
    example: {
      entryNode: { type: 'Everyone', id: 'entry-1' },
      nodes: [],
    },
  })
  @IsNotEmpty()
  @IsObject()
  definition: SegmentDefinition;
}
