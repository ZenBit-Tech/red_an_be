import { ApiProperty } from '@nestjs/swagger';
import {
  DetectedEntitySource,
  DetectedEntityStatus,
  DetectedEntitySystemReason,
  DetectedEntityUserReason,
} from '@common/constants/compliance.constants';

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

  @ApiProperty({ example: true })
  readonly isSyntheticEligible!: boolean;
}

export class AnalyzeResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  readonly jobId!: string;

  @ApiProperty({ type: [DetectedEntityResponseDto] })
  readonly findings!: DetectedEntityResponseDto[];
}

export class PreviewResponseDto {
  @ApiProperty({ example: '[PERSON_1] was born on [DATE_SHIFTED_1].' })
  readonly anonymizedText!: string;
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
