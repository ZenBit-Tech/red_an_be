import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ComplianceFramework } from '@common/constants/compliance.constants';

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

  public async getDashboardData(userUuid: string): Promise<DeIdStatsResponseDto> {
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
        `,
        [ComplianceFramework.GDPR_EU, ComplianceFramework.HIPAA, userUuid],
      )) as SummaryRow[];

      const entityDistribution = (await this.entityManager.query(
        `
        SELECT category AS label, COUNT(*) AS value
        FROM detected_entities de
        INNER JOIN de_id_jobs dj ON dj.id = de.jobId
        WHERE dj.userUuid = ?
        GROUP BY category
      `,
        [userUuid],
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
}
