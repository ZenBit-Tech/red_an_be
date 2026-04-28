import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DE_ID_STATS_FILTERS, DeIdStatsPeriod } from '../de-identification.constants';

export class DeIdStatsQueryDto {
  @ApiPropertyOptional({
    enum: DeIdStatsPeriod,
    example: DeIdStatsPeriod.LAST_7_DAYS,
    description:
      'Filtering period. month means rolling 30 days. last_7_days and last_14_days include the full current day.',
  })
  @IsOptional()
  @IsEnum(DeIdStatsPeriod)
  readonly period?: DeIdStatsPeriod;

  @ApiPropertyOptional({
    example: 'Europe/Kyiv',
    default: DE_ID_STATS_FILTERS.DEFAULT_TIMEZONE,
    description: 'IANA timezone name from frontend user settings.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly timezone?: string;
}
