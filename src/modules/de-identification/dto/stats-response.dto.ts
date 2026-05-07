import { ApiProperty } from '@nestjs/swagger';

export class DeIdStatsMetaDto {
  @ApiProperty({ example: 'last_7_days' })
  readonly period!: string;

  @ApiProperty({ example: 'Europe/Kyiv' })
  readonly timezone!: string;

  @ApiProperty({ example: '2026-04-20 00:00:00' })
  readonly rangeStart!: string;

  @ApiProperty({ example: '2026-04-27 00:00:00' })
  readonly rangeEndExclusive!: string;

  @ApiProperty({ example: '2026-04-13 00:00:00' })
  readonly previousRangeStart!: string;

  @ApiProperty({ example: '2026-04-20 00:00:00' })
  readonly previousRangeEndExclusive!: string;
}

export class DeIdStatsTrendDto {
  @ApiProperty({ example: 12.5 })
  readonly totalDocumentsPct!: number;

  @ApiProperty({ example: 8.1 })
  readonly entitiesDetectedPct!: number;

  @ApiProperty({ example: 3.4 })
  readonly avgEntitiesPerDocPct!: number;

  @ApiProperty({ example: 0 })
  readonly successRatePct!: number;
}

export class DeIdStatsSummaryDto {
  @ApiProperty({ example: 185 })
  readonly totalDocuments!: number;

  @ApiProperty({ example: 2471 })
  readonly entitiesDetected!: number;

  @ApiProperty({ example: 13.4 })
  readonly avgEntitiesPerDoc!: number;

  @ApiProperty({ example: 98.7 })
  readonly successRate!: number;

  @ApiProperty({ type: DeIdStatsTrendDto })
  readonly trends!: DeIdStatsTrendDto;
}

export class DeIdStatsFrameworkUsageItemDto {
  @ApiProperty({ example: 'HIPAA' })
  readonly framework!: string;

  @ApiProperty({ example: 42 })
  readonly count!: number;

  @ApiProperty({ example: 42.0 })
  readonly percentage!: number;
}

export class DeIdStatsEntityTypeItemDto {
  @ApiProperty({ example: 'PERSON' })
  readonly label!: string;

  @ApiProperty({ example: 160 })
  readonly value!: number;
}

export class DeIdStatsProcessingHistoryItemDto {
  @ApiProperty({ example: '2026-04-20' })
  readonly date!: string;

  @ApiProperty({ example: 35 })
  readonly documents!: number;

  @ApiProperty({ example: 612 })
  readonly entities!: number;
}

export class DeIdStatsConfidenceDistributionItemDto {
  @ApiProperty({ example: '90-100%' })
  readonly bucket!: string;

  @ApiProperty({ example: 356 })
  readonly value!: number;
}

export class DeIdStatsMethodUsageItemDto {
  @ApiProperty({ example: 'Redact' })
  readonly method!: string;

  @ApiProperty({ example: 205 })
  readonly value!: number;
}

export class DeIdStatsChartsDto {
  @ApiProperty({ type: [DeIdStatsFrameworkUsageItemDto] })
  readonly complianceFrameworkUsage!: DeIdStatsFrameworkUsageItemDto[];

  @ApiProperty({ type: [DeIdStatsEntityTypeItemDto] })
  readonly entityTypesDetected!: DeIdStatsEntityTypeItemDto[];

  @ApiProperty({ type: [DeIdStatsProcessingHistoryItemDto] })
  readonly processingHistory!: DeIdStatsProcessingHistoryItemDto[];

  @ApiProperty({ type: [DeIdStatsConfidenceDistributionItemDto] })
  readonly confidenceScoreDistribution!: DeIdStatsConfidenceDistributionItemDto[];

  @ApiProperty({ type: [DeIdStatsMethodUsageItemDto] })
  readonly deIdentificationMethodUsage!: DeIdStatsMethodUsageItemDto[];
}

export class DeIdStatsResponseDto {
  @ApiProperty({ type: DeIdStatsMetaDto })
  readonly meta!: DeIdStatsMetaDto;

  @ApiProperty({ type: DeIdStatsSummaryDto })
  readonly summary!: DeIdStatsSummaryDto;

  @ApiProperty({ type: DeIdStatsChartsDto })
  readonly charts!: DeIdStatsChartsDto;
}
