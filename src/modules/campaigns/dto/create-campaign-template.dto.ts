import {
  IsString,
  IsOptional,
  IsBoolean,
  IsObject,
  IsNotEmpty,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCampaignTemplateDto {
  @ApiProperty({
    description: 'Message template ID from evo-ai-crm',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  messageTemplateId: string;

  @ApiPropertyOptional({
    description: 'Template variant for A/B testing (A, B, C, etc.)',
    example: 'A',
    default: 'A',
  })
  @IsOptional()
  @IsString()
  variant?: string;

  @ApiPropertyOptional({
    description: 'Whether this template is the winner (for A/B testing)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isWinner?: boolean;

  @ApiPropertyOptional({
    description: 'Template statistics (metrics)',
    example: { opens: 0, clicks: 0 },
  })
  @IsOptional()
  @IsObject()
  statistics?: any;
}
