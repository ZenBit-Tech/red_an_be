import { EntityManager } from 'typeorm';
import { DetectedEntityStatus } from '@common/constants/compliance.constants';

import { DeIdStatsPeriod } from './de-identification.constants';
import { DeIdStatsQueryDto } from './dto/stats-query.dto';
import StatsService from './stats.service';

const TEST_USER_UUID = 'user-uuid-1';

describe('StatsService', () => {
  let service: StatsService;
  let entityManagerMock: { query: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-26T10:00:00.000Z'));

    entityManagerMock = { query: jest.fn() };
    service = new StatsService(entityManagerMock as unknown as EntityManager);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('should return dashboard data on success', async () => {
    const query: DeIdStatsQueryDto = {
      period: DeIdStatsPeriod.LAST_7_DAYS,
      timezone: 'Europe/Kyiv',
    };

    entityManagerMock.query
      .mockResolvedValueOnce([{ value: '5' }])
      .mockResolvedValueOnce([{ value: '10' }])
      .mockResolvedValueOnce([
        { status: 'SUCCESS', value: '4' },
        { status: 'FAILED', value: '1' },
      ])
      .mockResolvedValueOnce([{ value: '4' }])
      .mockResolvedValueOnce([{ value: '8' }])
      .mockResolvedValueOnce([
        { status: 'SUCCESS', value: '3' },
        { status: 'FAILED', value: '1' },
      ])
      .mockResolvedValueOnce([
        { framework: 'HIPAA', value: '2' },
        { framework: 'GDPR_EU', value: '2' },
        { framework: 'GDPR_UK', value: '1' },
      ])
      .mockResolvedValueOnce([
        { label: 'PERSON', value: '6' },
        { label: 'DATE_TIME', value: '4' },
      ])
      .mockResolvedValueOnce([
        { dayLabel: '2026-04-20', value: '1' },
        { dayLabel: '2026-04-21', value: '2' },
      ])
      .mockResolvedValueOnce([
        { dayLabel: '2026-04-20', value: '3' },
        { dayLabel: '2026-04-21', value: '4' },
      ])
      .mockResolvedValueOnce([
        {
          bucket90To100: '5',
          bucket80To90: '3',
          bucket70To80: '1',
          bucket60To70: '1',
          bucketUnder60: '0',
        },
      ])
      .mockResolvedValueOnce([
        { label: 'Redact', value: '5' },
        { label: 'Mask', value: '2' },
      ]);

    const result = await service.getDashboardData(TEST_USER_UUID, query);

    expect(entityManagerMock.query).toHaveBeenCalledTimes(12);
    const entityQueryCalls = entityManagerMock.query.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM detected_entities de'),
    );
    expect(entityQueryCalls).toHaveLength(6);
    entityQueryCalls.forEach(([sql, params]) => {
      expect(String(sql)).toContain('COALESCE(de.userStatus, de.systemStatus) = ?');
      expect((params as unknown[]).at(-1)).toBe(DetectedEntityStatus.ACTIVE);
    });

    expect(result.meta).toEqual({
      period: DeIdStatsPeriod.LAST_7_DAYS,
      timezone: 'Europe/Kyiv',
      rangeStart: '2026-04-20 00:00:00',
      rangeEndExclusive: '2026-04-27 00:00:00',
      previousRangeStart: '2026-04-13 00:00:00',
      previousRangeEndExclusive: '2026-04-20 00:00:00',
    });
    expect(result.summary).toEqual({
      totalDocuments: 5,
      entitiesDetected: 10,
      avgEntitiesPerDoc: 2,
      successRate: 80,
      trends: {
        totalDocumentsPct: 25,
        entitiesDetectedPct: 25,
        avgEntitiesPerDocPct: 0,
        successRatePct: 6.67,
      },
    });
    expect(result.charts.complianceFrameworkUsage).toEqual([
      { framework: 'HIPAA', count: 2, percentage: 40 },
      { framework: 'GDPR_EU', count: 2, percentage: 40 },
      { framework: 'GDPR_UK', count: 1, percentage: 20 },
    ]);
    expect(result.charts.entityTypesDetected).toEqual([
      { label: 'PERSON', value: 6 },
      { label: 'DATE_TIME', value: 4 },
    ]);
    expect(result.charts.confidenceScoreDistribution).toEqual([
      { bucket: '90-100%', value: 5 },
      { bucket: '80-90%', value: 3 },
      { bucket: '70-80%', value: 1 },
      { bucket: '60-70%', value: 1 },
      { bucket: '<60%', value: 0 },
    ]);
    expect(result.charts.deIdentificationMethodUsage).toEqual([
      { method: 'Redact', value: 5 },
      { method: 'Mask', value: 2 },
    ]);
    expect(result.charts.processingHistory).toHaveLength(7);
    expect(result.charts.processingHistory[0]).toEqual({
      date: '2026-04-20',
      documents: 1,
      entities: 3,
    });
  });

  it('should return zero-value fallback when a query fails', async () => {
    entityManagerMock.query.mockRejectedValue(new Error('db error'));

    const result = await service.getDashboardData(TEST_USER_UUID);

    expect(result).toEqual({
      meta: {
        period: DeIdStatsPeriod.TODAY,
        timezone: 'UTC',
        rangeStart: '2026-04-26 00:00:00',
        rangeEndExclusive: '2026-04-27 00:00:00',
        previousRangeStart: '2026-04-25 00:00:00',
        previousRangeEndExclusive: '2026-04-26 00:00:00',
      },
      summary: {
        totalDocuments: 0,
        entitiesDetected: 0,
        avgEntitiesPerDoc: 0,
        successRate: 0,
        trends: {
          totalDocumentsPct: 0,
          entitiesDetectedPct: 0,
          avgEntitiesPerDocPct: 0,
          successRatePct: 0,
        },
      },
      charts: {
        complianceFrameworkUsage: [
          { framework: 'HIPAA', count: 0, percentage: 0 },
          { framework: 'GDPR_EU', count: 0, percentage: 0 },
          { framework: 'GDPR_UK', count: 0, percentage: 0 },
        ],
        entityTypesDetected: [],
        processingHistory: [{ date: '2026-04-26', documents: 0, entities: 0 }],
        confidenceScoreDistribution: [
          { bucket: '90-100%', value: 0 },
          { bucket: '80-90%', value: 0 },
          { bucket: '70-80%', value: 0 },
          { bucket: '60-70%', value: 0 },
          { bucket: '<60%', value: 0 },
        ],
        deIdentificationMethodUsage: [],
      },
    });
  });

  it('should throw BadRequestException on invalid timezone', async () => {
    await expect(
      service.getDashboardData(TEST_USER_UUID, {
        period: DeIdStatsPeriod.MONTH,
        timezone: 'Invalid/Timezone',
      }),
    ).rejects.toThrow('Invalid timezone value');
  });
});
