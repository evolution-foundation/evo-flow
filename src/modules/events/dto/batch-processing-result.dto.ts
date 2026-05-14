import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsArray,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class BatchEventResultDto {
  @IsOptional()
  @IsString()
  @ApiProperty({
    description: 'Message ID returned from successful event processing',
    example: 'msg_123456789',
    required: false,
  })
  messageId?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({
    description: 'Status of the event processing',
    example: 'success',
    required: false,
  })
  status?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({
    description: 'Error message if event processing failed',
    example: 'Invalid event structure',
    required: false,
  })
  error?: string;
}

export class BatchProcessingResultDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'Overall processing result message',
    example: 'Batch processing completed',
  })
  message: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchEventResultDto)
  @ApiProperty({
    description: 'Array of individual event processing results',
    type: [BatchEventResultDto],
    example: [
      { messageId: 'msg_123', status: 'success' },
      { error: 'Invalid event structure' },
    ],
  })
  results: BatchEventResultDto[];

  @IsNumber()
  @ApiProperty({
    description: 'Total number of events processed',
    example: 10,
  })
  total: number;

  @IsNumber()
  @ApiProperty({
    description: 'Number of successfully processed events',
    example: 8,
  })
  successful: number;

  @IsNumber()
  @ApiProperty({
    description: 'Number of failed events',
    example: 2,
  })
  failed: number;
}
