import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ComplianceFramework } from '@common/constants/compliance.constants';
import { DeIdJobStatus } from '@db/entities/de-id-job.entity';
import {
  DE_ID_STATS_CONFIDENCE_BUCKETS,
  DE_ID_STATS_ERRORS,
  DE_ID_STATS_FILTERS,
  DE_ID_STATS_METHOD_LABELS,
  DeIdStatsPeriod,
} from './de-identification.constants';
import { DeIdStatsQueryDto } from './dto/stats-query.dto';

import {
  DeIdStatsChartsDto,
  DeIdStatsConfidenceDistributionItemDto,
  DeIdStatsEntityTypeItemDto,
  DeIdStatsFrameworkUsageItemDto,
  DeIdStatsMetaDto,
  DeIdStatsMethodUsageItemDto,
  DeIdStatsProcessingHistoryItemDto,
  DeIdStatsResponseDto,
  DeIdStatsSummaryDto,
  DeIdStatsTrendDto,
} from './dto/stats-response.dto';

type DbMetricValue = number | string | null;

type CountRow = {
  value?: DbMetricValue;
};

type StatusCountRow = {
  status?: string;
  value?: DbMetricValue;
};

type FrameworkUsageRow = {
  framework?: string;
  value?: DbMetricValue;
};

type LabelCountRow = {
  label?: string;
  value?: DbMetricValue;
};

type ProcessingHistoryRow = {
  dayLabel?: string;
  value?: DbMetricValue;
};

type ConfidenceDistributionRow = {
  bucket90To100?: DbMetricValue;
  bucket80To90?: DbMetricValue;
  bucket70To80?: DbMetricValue;
  bucket60To70?: DbMetricValue;
  bucketUnder60?: DbMetricValue;
};

type SummaryAggregate = {
  totalDocuments: number;
  entitiesDetected: number;
  avgEntitiesPerDoc: number;
  successRate: number;
};

type StatsDateRange = {
  startDateTime: string;
  endDateTimeExclusive: string;
  dayCount: number;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type StatsDateWindow = {
  period: DeIdStatsPeriod;
  timezone: string;
  current: StatsDateRange;
  previous: StatsDateRange;
};

const SUPPORTED_FRAMEWORKS: ComplianceFramework[] = [
  ComplianceFramework.HIPAA,
  ComplianceFramework.GDPR_EU,
  ComplianceFramework.GDPR_UK,
];

const EMPTY_TRENDS: DeIdStatsTrendDto = {
  totalDocumentsPct: DE_ID_STATS_FILTERS.ZERO,
  entitiesDetectedPct: DE_ID_STATS_FILTERS.ZERO,
  avgEntitiesPerDocPct: DE_ID_STATS_FILTERS.ZERO,
  successRatePct: DE_ID_STATS_FILTERS.ZERO,
};

const EMPTY_SUMMARY: DeIdStatsSummaryDto = {
  totalDocuments: DE_ID_STATS_FILTERS.ZERO,
  entitiesDetected: DE_ID_STATS_FILTERS.ZERO,
  avgEntitiesPerDoc: DE_ID_STATS_FILTERS.ZERO,
  successRate: DE_ID_STATS_FILTERS.ZERO,
  trends: EMPTY_TRENDS,
};

const EMPTY_CONFIDENCE_DISTRIBUTION: DeIdStatsConfidenceDistributionItemDto[] = [
  {
    bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.NINETY_TO_HUNDRED,
    value: DE_ID_STATS_FILTERS.ZERO,
  },
  {
    bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.EIGHTY_TO_NINETY,
    value: DE_ID_STATS_FILTERS.ZERO,
  },
  {
    bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.SEVENTY_TO_EIGHTY,
    value: DE_ID_STATS_FILTERS.ZERO,
  },
  {
    bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.SIXTY_TO_SEVENTY,
    value: DE_ID_STATS_FILTERS.ZERO,
  },
  {
    bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.UNDER_SIXTY,
    value: DE_ID_STATS_FILTERS.ZERO,
  },
];

@Injectable()
export default class StatsService {
  constructor(private readonly entityManager: EntityManager) {}

  public async getDashboardData(
    userUuid: string,
    query: DeIdStatsQueryDto = {},
  ): Promise<DeIdStatsResponseDto> {
    const dateWindow = StatsService.buildDateWindow(query);

    try {
      const summaryCurrent = await this.getSummaryAggregate(
        userUuid,
        dateWindow.current,
        dateWindow,
      );
      const summaryPrevious = await this.getSummaryAggregate(
        userUuid,
        dateWindow.previous,
        dateWindow,
      );

      const trends: DeIdStatsTrendDto = {
        totalDocumentsPct: StatsService.calculatePercentChange(
          summaryCurrent.totalDocuments,
          summaryPrevious.totalDocuments,
        ),
        entitiesDetectedPct: StatsService.calculatePercentChange(
          summaryCurrent.entitiesDetected,
          summaryPrevious.entitiesDetected,
        ),
        avgEntitiesPerDocPct: StatsService.calculatePercentChange(
          summaryCurrent.avgEntitiesPerDoc,
          summaryPrevious.avgEntitiesPerDoc,
        ),
        successRatePct: StatsService.calculatePercentChange(
          summaryCurrent.successRate,
          summaryPrevious.successRate,
        ),
      };

      const frameworkUsage = await this.getFrameworkUsage(userUuid, dateWindow.current, dateWindow);
      const entityTypes = await this.getEntityTypesDetected(
        userUuid,
        dateWindow.current,
        dateWindow,
      );
      const processingHistory = await this.getProcessingHistory(
        userUuid,
        dateWindow.current,
        dateWindow,
      );
      const confidenceDistribution = await this.getConfidenceScoreDistribution(
        userUuid,
        dateWindow.current,
        dateWindow,
      );
      const methodUsage = await this.getMethodUsage(userUuid, dateWindow.current, dateWindow);

      const meta: DeIdStatsMetaDto = {
        period: dateWindow.period,
        timezone: dateWindow.timezone,
        rangeStart: dateWindow.current.startDateTime,
        rangeEndExclusive: dateWindow.current.endDateTimeExclusive,
        previousRangeStart: dateWindow.previous.startDateTime,
        previousRangeEndExclusive: dateWindow.previous.endDateTimeExclusive,
      };

      const summary: DeIdStatsSummaryDto = {
        totalDocuments: summaryCurrent.totalDocuments,
        entitiesDetected: summaryCurrent.entitiesDetected,
        avgEntitiesPerDoc: summaryCurrent.avgEntitiesPerDoc,
        successRate: summaryCurrent.successRate,
        trends,
      };

      const charts: DeIdStatsChartsDto = {
        complianceFrameworkUsage: frameworkUsage,
        entityTypesDetected: entityTypes,
        processingHistory,
        confidenceScoreDistribution: confidenceDistribution,
        deIdentificationMethodUsage: methodUsage,
      };

      return {
        meta,
        summary,
        charts,
      };
    } catch {
      return StatsService.buildEmptyResponse(dateWindow);
    }
  }

  private async getSummaryAggregate(
    userUuid: string,
    range: StatsDateRange,
    dateWindow: StatsDateWindow,
  ): Promise<SummaryAggregate> {
    const totalDocumentsRows = (await this.entityManager.query(
      `
        SELECT COUNT(*) AS value
        FROM de_id_jobs dj
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as CountRow[];

    const totalEntitiesRows = (await this.entityManager.query(
      `
        SELECT COUNT(*) AS value
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as CountRow[];

    const statusCountRows = (await this.entityManager.query(
      `
        SELECT dj.status AS status, COUNT(*) AS value
        FROM de_id_jobs dj
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
        GROUP BY dj.status
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as StatusCountRow[];

    const totalDocuments = StatsService.normalizeNumber(totalDocumentsRows[0]?.value);
    const entitiesDetected = StatsService.normalizeNumber(totalEntitiesRows[0]?.value);
    const avgEntitiesPerDoc = StatsService.calculateAverage(entitiesDetected, totalDocuments);

    const successfulJobs = statusCountRows.reduce((total, row) => {
      if (row.status === DeIdJobStatus.SUCCESS) {
        return total + StatsService.normalizeNumber(row.value);
      }

      return total;
    }, DE_ID_STATS_FILTERS.ZERO);

    const successRate = StatsService.calculateSuccessRate(successfulJobs, totalDocuments);

    return {
      totalDocuments,
      entitiesDetected,
      avgEntitiesPerDoc,
      successRate,
    };
  }

  private async getFrameworkUsage(
    userUuid: string,
    range: StatsDateRange,
    dateWindow: StatsDateWindow,
  ): Promise<DeIdStatsFrameworkUsageItemDto[]> {
    const rows = (await this.entityManager.query(
      `
        SELECT dj.framework AS framework, COUNT(*) AS value
        FROM de_id_jobs dj
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
        GROUP BY dj.framework
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as FrameworkUsageRow[];

    const countsByFramework = rows.reduce<Record<string, number>>((accumulator, row) => {
      const framework = row.framework ?? '';
      accumulator[framework] = StatsService.normalizeNumber(row.value);
      return accumulator;
    }, {});

    const totalFrameworkCount = Object.values(countsByFramework).reduce(
      (sum, currentValue) => sum + currentValue,
      DE_ID_STATS_FILTERS.ZERO,
    );

    return SUPPORTED_FRAMEWORKS.map((framework) => {
      const count = countsByFramework[framework] ?? DE_ID_STATS_FILTERS.ZERO;
      let percentage = DE_ID_STATS_FILTERS.ZERO;

      if (totalFrameworkCount > DE_ID_STATS_FILTERS.ZERO) {
        percentage = StatsService.normalizePercent(
          (count / totalFrameworkCount) * DE_ID_STATS_FILTERS.PERCENT_MULTIPLIER,
        );
      }

      return {
        framework,
        count,
        percentage,
      };
    });
  }

  private async getEntityTypesDetected(
    userUuid: string,
    range: StatsDateRange,
    dateWindow: StatsDateWindow,
  ): Promise<DeIdStatsEntityTypeItemDto[]> {
    const rows = (await this.entityManager.query(
      `
        SELECT de.category AS label, COUNT(*) AS value
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
        GROUP BY de.category
        ORDER BY value DESC
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as LabelCountRow[];

    return rows.map((row) => ({
      label: row.label ?? '',
      value: StatsService.normalizeNumber(row.value),
    }));
  }

  private async getProcessingHistory(
    userUuid: string,
    range: StatsDateRange,
    dateWindow: StatsDateWindow,
  ): Promise<DeIdStatsProcessingHistoryItemDto[]> {
    const documentsRows = (await this.entityManager.query(
      `
        SELECT DATE(CONVERT_TZ(dj.createdAt, ?, ?)) AS dayLabel, COUNT(*) AS value
        FROM de_id_jobs dj
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
        GROUP BY dayLabel
        ORDER BY dayLabel ASC
      `,
      [
        DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
        dateWindow.timezone,
        userUuid,
        ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone),
      ],
    )) as ProcessingHistoryRow[];

    const entitiesRows = (await this.entityManager.query(
      `
        SELECT DATE(CONVERT_TZ(dj.createdAt, ?, ?)) AS dayLabel, COUNT(*) AS value
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
        GROUP BY dayLabel
        ORDER BY dayLabel ASC
      `,
      [
        DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
        dateWindow.timezone,
        userUuid,
        ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone),
      ],
    )) as ProcessingHistoryRow[];

    const documentsByDate = documentsRows.reduce<Record<string, number>>((accumulator, row) => {
      const dayLabel = row.dayLabel ?? '';
      accumulator[dayLabel] = StatsService.normalizeNumber(row.value);
      return accumulator;
    }, {});

    const entitiesByDate = entitiesRows.reduce<Record<string, number>>((accumulator, row) => {
      const dayLabel = row.dayLabel ?? '';
      accumulator[dayLabel] = StatsService.normalizeNumber(row.value);
      return accumulator;
    }, {});

    return StatsService.buildDateSeries(range).map((date) => ({
      date,
      documents: documentsByDate[date] ?? DE_ID_STATS_FILTERS.ZERO,
      entities: entitiesByDate[date] ?? DE_ID_STATS_FILTERS.ZERO,
    }));
  }

  private async getConfidenceScoreDistribution(
    userUuid: string,
    range: StatsDateRange,
    dateWindow: StatsDateWindow,
  ): Promise<DeIdStatsConfidenceDistributionItemDto[]> {
    const rows = (await this.entityManager.query(
      `
        SELECT
          SUM(CASE WHEN de.confidence >= 90 THEN 1 ELSE 0 END) AS bucket90To100,
          SUM(CASE WHEN de.confidence >= 80 AND de.confidence < 90 THEN 1 ELSE 0 END) AS bucket80To90,
          SUM(CASE WHEN de.confidence >= 70 AND de.confidence < 80 THEN 1 ELSE 0 END) AS bucket70To80,
          SUM(CASE WHEN de.confidence >= 60 AND de.confidence < 70 THEN 1 ELSE 0 END) AS bucket60To70,
          SUM(CASE WHEN de.confidence < 60 THEN 1 ELSE 0 END) AS bucketUnder60
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as ConfidenceDistributionRow[];

    const row = rows[0] ?? {};

    return [
      {
        bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.NINETY_TO_HUNDRED,
        value: StatsService.normalizeNumber(row.bucket90To100),
      },
      {
        bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.EIGHTY_TO_NINETY,
        value: StatsService.normalizeNumber(row.bucket80To90),
      },
      {
        bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.SEVENTY_TO_EIGHTY,
        value: StatsService.normalizeNumber(row.bucket70To80),
      },
      {
        bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.SIXTY_TO_SEVENTY,
        value: StatsService.normalizeNumber(row.bucket60To70),
      },
      {
        bucket: DE_ID_STATS_CONFIDENCE_BUCKETS.UNDER_SIXTY,
        value: StatsService.normalizeNumber(row.bucketUnder60),
      },
    ];
  }

  private async getMethodUsage(
    userUuid: string,
    range: StatsDateRange,
    dateWindow: StatsDateWindow,
  ): Promise<DeIdStatsMethodUsageItemDto[]> {
    const rows = (await this.entityManager.query(
      `
        SELECT de.proxyType AS label, COUNT(*) AS value
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
          AND dj.createdAt >= CONVERT_TZ(?, ?, ?)
          AND dj.createdAt < CONVERT_TZ(?, ?, ?)
        GROUP BY de.proxyType
        ORDER BY value DESC
      `,
      [userUuid, ...StatsService.buildDateRangeSqlParams(range, dateWindow.timezone)],
    )) as LabelCountRow[];

    return rows.map((row) => {
      let method = DE_ID_STATS_METHOD_LABELS.UNKNOWN;
      if (row.label && row.label.trim().length > DE_ID_STATS_FILTERS.ZERO) {
        method = row.label;
      }

      return {
        method,
        value: StatsService.normalizeNumber(row.value),
      };
    });
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

  private static normalizePercent(value: number): number {
    if (!Number.isFinite(value)) {
      return DE_ID_STATS_FILTERS.ZERO;
    }

    return Number(value.toFixed(DE_ID_STATS_FILTERS.PERCENT_PRECISION));
  }

  private static calculateAverage(numerator: number, denominator: number): number {
    if (denominator <= DE_ID_STATS_FILTERS.ZERO) {
      return DE_ID_STATS_FILTERS.ZERO;
    }

    return StatsService.normalizePercent(numerator / denominator);
  }

  private static calculateSuccessRate(successfulJobs: number, totalJobs: number): number {
    if (totalJobs <= DE_ID_STATS_FILTERS.ZERO) {
      return DE_ID_STATS_FILTERS.ZERO;
    }

    return StatsService.normalizePercent(
      (successfulJobs / totalJobs) * DE_ID_STATS_FILTERS.PERCENT_MULTIPLIER,
    );
  }

  private static calculatePercentChange(currentValue: number, previousValue: number): number {
    if (previousValue <= DE_ID_STATS_FILTERS.ZERO) {
      if (currentValue <= DE_ID_STATS_FILTERS.ZERO) {
        return DE_ID_STATS_FILTERS.ZERO;
      }

      return DE_ID_STATS_FILTERS.PERCENT_MULTIPLIER;
    }

    const delta =
      ((currentValue - previousValue) / previousValue) * DE_ID_STATS_FILTERS.PERCENT_MULTIPLIER;
    return StatsService.normalizePercent(delta);
  }

  private static buildEmptyResponse(dateWindow: StatsDateWindow): DeIdStatsResponseDto {
    const meta: DeIdStatsMetaDto = {
      period: dateWindow.period,
      timezone: dateWindow.timezone,
      rangeStart: dateWindow.current.startDateTime,
      rangeEndExclusive: dateWindow.current.endDateTimeExclusive,
      previousRangeStart: dateWindow.previous.startDateTime,
      previousRangeEndExclusive: dateWindow.previous.endDateTimeExclusive,
    };

    const charts: DeIdStatsChartsDto = {
      complianceFrameworkUsage: SUPPORTED_FRAMEWORKS.map((framework) => ({
        framework,
        count: DE_ID_STATS_FILTERS.ZERO,
        percentage: DE_ID_STATS_FILTERS.ZERO,
      })),
      entityTypesDetected: [],
      processingHistory: StatsService.buildDateSeries(dateWindow.current).map((date) => ({
        date,
        documents: DE_ID_STATS_FILTERS.ZERO,
        entities: DE_ID_STATS_FILTERS.ZERO,
      })),
      confidenceScoreDistribution: EMPTY_CONFIDENCE_DISTRIBUTION,
      deIdentificationMethodUsage: [],
    };

    return {
      meta,
      summary: EMPTY_SUMMARY,
      charts,
    };
  }

  private static buildDateWindow(query: DeIdStatsQueryDto): StatsDateWindow {
    const timezone = (query.timezone ?? DE_ID_STATS_FILTERS.DEFAULT_TIMEZONE).trim();
    StatsService.assertValidTimeZone(timezone);

    const period = query.period ?? DeIdStatsPeriod.TODAY;
    const todayDateInTimeZone = StatsService.getDateInTimeZone(timezone);

    const daysInRangeMap: Record<DeIdStatsPeriod, number> = {
      [DeIdStatsPeriod.TODAY]: DE_ID_STATS_FILTERS.TODAY_RANGE_DAYS,
      [DeIdStatsPeriod.LAST_7_DAYS]: DE_ID_STATS_FILTERS.LAST_7_DAYS_RANGE_DAYS,
      [DeIdStatsPeriod.LAST_14_DAYS]: DE_ID_STATS_FILTERS.LAST_14_DAYS_RANGE_DAYS,
      [DeIdStatsPeriod.MONTH]: DE_ID_STATS_FILTERS.MONTH_RANGE_DAYS,
    };

    const daysInRange = daysInRangeMap[period];
    const currentStartDate = StatsService.shiftDate(todayDateInTimeZone, -(daysInRange - 1));
    const currentEndDateExclusive = StatsService.shiftDate(todayDateInTimeZone, 1);
    const previousEndDateExclusive = new Date(currentStartDate);
    const previousStartDate = StatsService.shiftDate(previousEndDateExclusive, -daysInRange);

    return {
      period,
      timezone,
      current: {
        startDateTime: StatsService.toDateTimeString(currentStartDate),
        endDateTimeExclusive: StatsService.toDateTimeString(currentEndDateExclusive),
        dayCount: daysInRange,
      },
      previous: {
        startDateTime: StatsService.toDateTimeString(previousStartDate),
        endDateTimeExclusive: StatsService.toDateTimeString(previousEndDateExclusive),
        dayCount: daysInRange,
      },
    };
  }

  private static buildDateRangeSqlParams(range: StatsDateRange, timezone: string): string[] {
    return [
      range.startDateTime,
      timezone,
      DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
      range.endDateTimeExclusive,
      timezone,
      DE_ID_STATS_FILTERS.SOURCE_UTC_OFFSET,
    ];
  }

  private static buildDateSeries(range: StatsDateRange): string[] {
    const dates: string[] = [];
    const startDate = new Date(`${range.startDateTime}Z`);

    for (let dayIndex = 0; dayIndex < range.dayCount; dayIndex += 1) {
      const currentDate = StatsService.shiftDate(startDate, dayIndex);
      dates.push(StatsService.toDateOnlyString(currentDate));
    }

    return dates;
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

  private static toDateOnlyString(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    return `${year}${DE_ID_STATS_FILTERS.DATE_STRING_SEPARATOR}${month}${DE_ID_STATS_FILTERS.DATE_STRING_SEPARATOR}${day}`;
  }
}
