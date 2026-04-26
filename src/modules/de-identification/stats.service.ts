import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ComplianceFramework } from '@common/constants/compliance.constants';
import {
  DE_ID_STATS_ERRORS,
  DE_ID_STATS_FILTERS,
  DeIdStatsPeriod,
} from './de-identification.constants';
import { DeIdStatsQueryDto } from './dto/stats-query.dto';

import {
  DeIdStatsChartItemDto,
  DeIdStatsResponseDto,
  DeIdStatsSummaryDto,
} from './dto/stats-response.dto';

type DbMetricValue = number | string | null;

type SummaryRow = {
  totalDocs?: DbMetricValue;
  totalEntities?: DbMetricValue;
  avgConfidence?: DbMetricValue;
  gdprCount?: DbMetricValue;
  hipaaCount?: DbMetricValue;
};

type ChartRow = {
  label?: string;
  value?: DbMetricValue;
};

type StatsDateRange = {
  startDateTime: string;
  endDateTimeExclusive: string;
  timezone: string;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

const EMPTY_SUMMARY: DeIdStatsSummaryDto = {
  totalDocs: 0,
  totalEntities: 0,
  avgConfidence: 0,
  gdprCount: 0,
  hipaaCount: 0,
};

@Injectable()
export default class StatsService {
  constructor(private readonly entityManager: EntityManager) {}

  public async getDashboardData(
    userUuid: string,
    query: DeIdStatsQueryDto = {},
  ): Promise<DeIdStatsResponseDto> {
    const dateRange = StatsService.buildDateRange(query);

    try {
      const summaryRows = (await this.entityManager.query(
        `
          SELECT
            COUNT(DISTINCT de.jobId) AS totalDocs,
            COUNT(*) AS totalEntities,
            AVG(de.confidence) AS avgConfidence,
            SUM(CASE WHEN dj.framework = ? THEN 1 ELSE 0 END) AS gdprCount,
            SUM(CASE WHEN dj.framework = ? THEN 1 ELSE 0 END) AS hipaaCount
          FROM detected_entities de
          INNER JOIN de_id_jobs dj ON dj.id = de.jobId
          WHERE dj.userUuid = ?
            AND CONVERT_TZ(dj.createdAt, ?, ?) >= ?
            AND CONVERT_TZ(dj.createdAt, ?, ?) < ?
        `,
        [
          ComplianceFramework.GDPR_EU,
          ComplianceFramework.HIPAA,
          userUuid,
          DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
          dateRange.timezone,
          dateRange.startDateTime,
          DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
          dateRange.timezone,
          dateRange.endDateTimeExclusive,
        ],
      )) as SummaryRow[];

      const entityDistribution = (await this.entityManager.query(
        `
        SELECT category AS label, COUNT(*) AS value
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
          AND CONVERT_TZ(dj.createdAt, ?, ?) >= ?
          AND CONVERT_TZ(dj.createdAt, ?, ?) < ?
        GROUP BY category
      `,
        [
          userUuid,
          DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
          dateRange.timezone,
          dateRange.startDateTime,
          DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
          dateRange.timezone,
          dateRange.endDateTimeExclusive,
        ],
      )) as ChartRow[];

      const summaryRow = summaryRows[0] ?? {};
      const summary: DeIdStatsSummaryDto = {
        totalDocs: StatsService.normalizeNumber(summaryRow.totalDocs),
        totalEntities: StatsService.normalizeNumber(summaryRow.totalEntities),
        avgConfidence: StatsService.normalizeNumber(summaryRow.avgConfidence),
        gdprCount: StatsService.normalizeNumber(summaryRow.gdprCount),
        hipaaCount: StatsService.normalizeNumber(summaryRow.hipaaCount),
      };

      const chartData: DeIdStatsChartItemDto[] = entityDistribution.map((item) => ({
        label: item.label ?? '',
        value: StatsService.normalizeNumber(item.value),
      }));

      return {
        summary,
        chartData,
      };
    } catch {
      return {
        summary: EMPTY_SUMMARY,
        chartData: [],
      };
    }
  }

  private static normalizeNumber(value: DbMetricValue | undefined): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === 'string') {
      const parsedValue = Number(value);
      return Number.isFinite(parsedValue) ? parsedValue : 0;
    }

    return 0;
  }

  private static buildDateRange(query: DeIdStatsQueryDto): StatsDateRange {
    const timezone = (query.timezone ?? DE_ID_STATS_FILTERS.DEFAULT_TIMEZONE).trim();
    StatsService.assertValidTimeZone(timezone);

    const period = query.period ?? DeIdStatsPeriod.TODAY;
    const todayDateInTimeZone = StatsService.getDateInTimeZone(timezone);
    const endDateExclusive = StatsService.shiftDate(todayDateInTimeZone, 1);

    const daysInRangeMap: Record<DeIdStatsPeriod, number> = {
      [DeIdStatsPeriod.TODAY]: DE_ID_STATS_FILTERS.TODAY_RANGE_DAYS,
      [DeIdStatsPeriod.LAST_7_DAYS]: DE_ID_STATS_FILTERS.LAST_7_DAYS_RANGE_DAYS,
      [DeIdStatsPeriod.LAST_14_DAYS]: DE_ID_STATS_FILTERS.LAST_14_DAYS_RANGE_DAYS,
      [DeIdStatsPeriod.MONTH]: DE_ID_STATS_FILTERS.MONTH_RANGE_DAYS,
    };

    const daysInRange = daysInRangeMap[period];
    const startDate = StatsService.shiftDate(todayDateInTimeZone, -(daysInRange - 1));

    return {
      timezone,
      startDateTime: StatsService.toDateTimeString(startDate),
      endDateTimeExclusive: StatsService.toDateTimeString(endDateExclusive),
    };
  }

  private static assertValidTimeZone(timeZone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
      throw new BadRequestException(DE_ID_STATS_ERRORS.INVALID_TIMEZONE);
    }
  }

  private static getDateInTimeZone(timeZone: string): Date {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const parts = formatter.formatToParts(new Date());
    const dateParts = parts.reduce<DateParts>(
      (accumulator, part) => {
        if (part.type === 'year') {
          return { ...accumulator, year: Number(part.value) };
        }

        if (part.type === 'month') {
          return { ...accumulator, month: Number(part.value) };
        }

        if (part.type === 'day') {
          return { ...accumulator, day: Number(part.value) };
        }

        return accumulator;
      },
      { year: 0, month: 0, day: 0 },
    );

    return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
  }

  private static shiftDate(date: Date, daysDelta: number): Date {
    const shiftedDate = new Date(date);
    shiftedDate.setUTCDate(shiftedDate.getUTCDate() + daysDelta);
    return shiftedDate;
  }

  private static toDateTimeString(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    return `${year}${DE_ID_STATS_FILTERS.DATE_STRING_SEPARATOR}${month}${DE_ID_STATS_FILTERS.DATE_STRING_SEPARATOR}${day} ${DE_ID_STATS_FILTERS.START_OF_DAY_TIME}`;
  }
}
