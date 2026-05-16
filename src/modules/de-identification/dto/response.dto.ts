import { ApiProperty } from '@nestjs/swagger';
import {
  DetectedEntitySource,
  DetectedEntityStatus,
  DetectedEntitySystemReason,
  DetectedEntityUserReason,
} from '@common/constants/compliance.constants';
import { PreviewValidationMode, SyntheticOutputFormat } from './request.dto';

export class DetectedEntityResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  readonly id!: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  readonly jobId!: string;

  @ApiProperty({ example: 'PERSON' })
  readonly category!: string;

  @ApiProperty({ example: 98.73 })
  readonly confidence!: number;

  @ApiProperty({ example: 8 })
  readonly start!: number;

  @ApiProperty({ example: 16 })
  readonly end!: number;

  @ApiProperty({ example: 'Hash' })
  readonly proxyType!: string;

  @ApiProperty({ enum: DetectedEntityStatus, example: DetectedEntityStatus.ACTIVE })
  readonly systemStatus!: DetectedEntityStatus;

  @ApiProperty({
    enum: DetectedEntitySystemReason,
    example: DetectedEntitySystemReason.ANALYZER_DETECTED,
  })
  readonly systemStatusReason!: DetectedEntitySystemReason;

  @ApiProperty({ enum: DetectedEntityStatus, nullable: true, example: null })
  readonly userStatus!: DetectedEntityStatus | null;

  @ApiProperty({ enum: DetectedEntityUserReason, nullable: true, example: null })
  readonly userStatusReason!: DetectedEntityUserReason | null;

  @ApiProperty({ enum: DetectedEntitySource, example: DetectedEntitySource.ANALYZER })
  readonly source!: DetectedEntitySource;

  @ApiProperty({ enum: DetectedEntityStatus, example: DetectedEntityStatus.ACTIVE })
  readonly effectiveStatus!: DetectedEntityStatus;

  @ApiProperty({ example: true })
  readonly isSyntheticEligible!: boolean;
}

export class AnalyzeResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  readonly jobId!: string;

  @ApiProperty({ type: [DetectedEntityResponseDto] })
  readonly findings!: DetectedEntityResponseDto[];
}

export class PreviewPostValidationLeakDto {
  @ApiProperty({
    example: 'SSN',
    description: 'Matched PHI pattern type from post-validation engine',
  })
  readonly type!: string;

  @ApiProperty({ example: '123-45-6789' })
  readonly match!: string;

  @ApiProperty({ example: 15 })
  readonly index!: number;
}

export class PreviewPostValidationSummaryItemDto {
  @ApiProperty({ example: 'SSN' })
  readonly type!: string;

  @ApiProperty({ example: 2 })
  readonly count!: number;
}

export class PreviewPostValidationDto {
  @ApiProperty({ example: false })
  readonly valid!: boolean;

  @ApiProperty({ enum: PreviewValidationMode, example: PreviewValidationMode.WARN_ONLY })
  readonly mode!: PreviewValidationMode;

  @ApiProperty({ type: [PreviewPostValidationLeakDto] })
  readonly leaks!: PreviewPostValidationLeakDto[];

  @ApiProperty({ type: [PreviewPostValidationSummaryItemDto] })
  readonly summary!: PreviewPostValidationSummaryItemDto[];
}

export class PreviewResponseDto {
  @ApiProperty({ example: '[PERSON_1] was born on [DATE_SHIFTED_1].' })
  readonly anonymizedText!: string;

  @ApiProperty({ type: () => PreviewPostValidationDto })
  readonly postValidation!: PreviewPostValidationDto;
}

export class BulkUpdateEntityStatusesResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  readonly jobId!: string;

  @ApiProperty({ example: 4 })
  readonly updatedCount!: number;

  @ApiProperty({ type: [DetectedEntityResponseDto] })
  readonly findings!: DetectedEntityResponseDto[];
}

export class GenerateSyntheticVariantsResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  readonly jobId!: string;

  @ApiProperty({ example: 5 })
  readonly variantsGenerated!: number;

  @ApiProperty({ enum: SyntheticOutputFormat, example: SyntheticOutputFormat.TXT })
  readonly outputFormat!: SyntheticOutputFormat;

  @ApiProperty({
    example: 'application/zip',
    description: 'MIME type of the archive file',
  })
  readonly mimeType!: string;

  @ApiProperty({
    example: 'synthetic-variants-job-123.zip',
    description: 'Suggested filename for the archive',
  })
  readonly filename!: string;
}

export class RemoteNlpHealthResponseDto {
  @ApiProperty({ example: true })
  readonly configured!: boolean;

  @ApiProperty({ example: true })
  readonly reachable!: boolean;

  @ApiProperty({ example: 31, nullable: true })
  readonly latencyMs!: number | null;

  @ApiProperty({ example: 'ok' })
  readonly details!: string;
}

export class SyntheticGenerationRowDto {
  @ApiProperty({ example: 1, description: 'One-based variant index' })
  readonly variantNumber!: number;

  @ApiProperty({
    example: {
      PERSON: 'Michael Garcia',
      'DATE & TIME': '17.03.2026',
      AGE: '47',
      PHONE: '555-55-555',
    },
    description: 'Map of entity category to synthetic replacement value for this row',
  })
  readonly entities!: Record<string, string>;
}

export class SyntheticTableSummaryDto {
  @ApiProperty({ example: 5 })
  readonly totalRows!: number;

  @ApiProperty({ example: '2026-05-14T10:00:00.000Z' })
  readonly generatedAt!: string;

  @ApiProperty({ example: 'GDPR_EU' })
  readonly framework!: string;
}

export class GenerateSyntheticTableResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440099' })
  readonly generationId!: string;

  @ApiProperty({
    example: ['PERSON', 'DATE & TIME', 'AGE', 'PHONE', 'EMAIL', 'MRN'],
    description: 'Ordered list of entity category column headers for the table',
  })
  readonly columns!: string[];

  @ApiProperty({ type: [SyntheticGenerationRowDto] })
  readonly rows!: SyntheticGenerationRowDto[];

  @ApiProperty({ type: () => SyntheticTableSummaryDto })
  readonly summary!: SyntheticTableSummaryDto;
}

export class RegenerateSyntheticTableResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440100' })
  readonly generationId!: string;

  @ApiProperty({
    example: ['PERSON', 'DATE & TIME', 'AGE', 'PHONE', 'EMAIL', 'MRN'],
    description: 'Ordered list of entity category column headers for the table',
  })
  readonly columns!: string[];

  @ApiProperty({ type: [SyntheticGenerationRowDto] })
  readonly rows!: SyntheticGenerationRowDto[];

  @ApiProperty({ type: () => SyntheticTableSummaryDto })
  readonly summary!: SyntheticTableSummaryDto;
}
