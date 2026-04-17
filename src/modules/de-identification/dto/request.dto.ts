import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsUUID,
} from 'class-validator';
import { ComplianceFramework } from '@common/constants/compliance.constants';

export class AnalyzeRequestDto {
  @ApiProperty({ example: 'Patient John Doe, born 1980-05-15...' })
  @IsString()
  @IsNotEmpty()
  readonly text!: string;

  @ApiProperty({ enum: ComplianceFramework, example: ComplianceFramework.GDPR_EU })
  @IsEnum(ComplianceFramework)
  readonly framework!: ComplianceFramework;

  @ApiProperty({ example: 0.85, description: 'Confidence threshold (0.0 to 1.0)' })
  @IsNumber()
  @Min(0)
  @Max(1)
  readonly threshold!: number;

  @ApiProperty({ example: true, description: 'Preserve original document formatting' })
  @IsBoolean()
  readonly preserveStructure!: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Request-level override for external recognizers. true: keep env behavior, false: disable external recognizers for this request.',
  })
  @IsOptional()
  @IsBoolean()
  readonly includeExternalRecognizers?: boolean;
}

export class PreviewRequestDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID('4')
  readonly jobId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly text!: string;

  @ApiProperty({ enum: ComplianceFramework })
  @IsEnum(ComplianceFramework)
  readonly framework!: ComplianceFramework;

  @ApiProperty({
    description: 'List of entity UUIDs where Action is set to ON',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  readonly activeIds!: string[];
}
