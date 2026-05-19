import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
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
import { ComplianceFramework, DetectedEntityStatus } from '@common/constants/compliance.constants';

export enum SyntheticOutputFormat {
  TXT = 'txt',
  PDF = 'pdf',
}

export enum PreviewValidationMode {
  STRICT = 'strict',
  WARN_ONLY = 'warn_only',
}

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

  @ApiPropertyOptional({
    enum: PreviewValidationMode,
    example: PreviewValidationMode.WARN_ONLY,
    description:
      'Post-validation behavior for preview response. strict returns 422 on PHI leaks, warn_only returns 200 with leak metadata.',
  })
  @IsOptional()
  @IsEnum(PreviewValidationMode)
  readonly validationMode?: PreviewValidationMode;
}

export class BulkUpdateEntityStatusesRequestDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID('4')
  readonly jobId!: string;

  @ApiProperty({
    description:
      'Entity UUIDs that should be marked as active. All remaining job entities become inactive.',
    example: ['550e8400-e29b-41d4-a716-446655440010', '550e8400-e29b-41d4-a716-446655440011'],
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  readonly activeEntityIds!: string[];
}

export class ResetEntityStatusRequestDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440010' })
  @IsUUID('4')
  readonly entityId!: string;

  @ApiProperty({ enum: DetectedEntityStatus, example: DetectedEntityStatus.ACTIVE })
  @IsEnum(DetectedEntityStatus)
  readonly fallbackStatus!: DetectedEntityStatus;
}

export class GenerateSyntheticVariantsRequestDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID('4')
  readonly jobId!: string;

  @ApiProperty({
    example: 'Patient John Doe visited on 2026-01-10. Contact: +49 30 1234567',
    description:
      'Original analyzed text. Used to generate synthetic variants after hash/length validation.',
  })
  @IsString()
  @IsNotEmpty()
  readonly text!: string;

  @ApiProperty({
    example: 5,
    description: 'Number of synthetic variants to generate. Max limit from environment config.',
  })
  @IsNumber()
  @Min(1)
  readonly count!: number;

  @ApiProperty({
    enum: SyntheticOutputFormat,
    example: SyntheticOutputFormat.TXT,
    description: 'Output file format: txt or pdf',
  })
  @IsEnum(SyntheticOutputFormat)
  readonly outputFormat!: SyntheticOutputFormat;
}

export class GenerateSyntheticTableRequestDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID('4')
  readonly jobId!: string;

  @ApiProperty({
    example: 'Patient John Doe visited on 2026-01-10. Contact: +49 30 1234567',
    description:
      'Original analyzed text. Used to generate synthetic rows after hash/length validation.',
  })
  @IsString()
  @IsNotEmpty()
  readonly text!: string;

  @ApiProperty({
    example: 5,
    description: 'Number of synthetic rows to generate. Max limit from environment config.',
  })
  @IsNumber()
  @Min(1)
  readonly count!: number;

  @ApiProperty({
    enum: SyntheticOutputFormat,
    example: SyntheticOutputFormat.TXT,
    description: 'Output file format used when downloading the archive.',
  })
  @IsEnum(SyntheticOutputFormat)
  readonly outputFormat!: SyntheticOutputFormat;
}

export class RegenerateSyntheticTableRequestDto {
  @ApiProperty({
    example: 5,
    description: 'Number of synthetic rows to regenerate. Max limit from environment config.',
  })
  @IsNumber()
  @Min(1)
  readonly count!: number;

  @ApiProperty({
    enum: SyntheticOutputFormat,
    example: SyntheticOutputFormat.TXT,
    description: 'Output file format used when downloading the archive.',
  })
  @IsEnum(SyntheticOutputFormat)
  readonly outputFormat!: SyntheticOutputFormat;
}
