import { ApiProperty } from '@nestjs/swagger';

export class DeIdStatsSummaryDto {
  @ApiProperty({ example: 5 })
  readonly totalDocs!: number;

  @ApiProperty({ example: 10 })
  readonly totalEntities!: number;

  @ApiProperty({ example: 92.5 })
  readonly avgConfidence!: number;

  @ApiProperty({ example: 3 })
  readonly gdprCount!: number;

  @ApiProperty({ example: 2 })
  readonly hipaaCount!: number;
}

export class DeIdStatsChartItemDto {
  @ApiProperty({ example: 'PERSON' })
  readonly label!: string;

  @ApiProperty({ example: 6 })
  readonly value!: number;
}

export class DeIdStatsResponseDto {
  @ApiProperty({ type: DeIdStatsSummaryDto })
  readonly summary!: DeIdStatsSummaryDto;

  @ApiProperty({ type: [DeIdStatsChartItemDto] })
  readonly chartData!: DeIdStatsChartItemDto[];
}
