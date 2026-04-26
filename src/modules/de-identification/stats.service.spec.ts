import { EntityManager } from 'typeorm';

import { ComplianceFramework } from '@common/constants/compliance.constants';

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

    const summaryRow = {
      totalDocs: '5',
      totalEntities: '10',
      avgConfidence: '92.5',
      gdprCount: '3',
      hipaaCount: '2',
    };

    const distribution = [
      { label: 'PERSON', value: '6' },
      { label: 'DATE_TIME', value: '4' },
    ];

    entityManagerMock.query.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(distribution);

    const result = await service.getDashboardData(TEST_USER_UUID, query);

    expect(entityManagerMock.query).toHaveBeenCalledTimes(2);
    expect(entityManagerMock.query.mock.calls[0][1]).toEqual([
      ComplianceFramework.GDPR_EU,
      ComplianceFramework.HIPAA,
      TEST_USER_UUID,
      '+00:00',
      'Europe/Kyiv',
      '2026-04-20 00:00:00',
      '+00:00',
      'Europe/Kyiv',
      '2026-04-27 00:00:00',
    ]);
    expect(entityManagerMock.query.mock.calls[1][1]).toEqual([
      TEST_USER_UUID,
      '+00:00',
      'Europe/Kyiv',
      '2026-04-20 00:00:00',
      '+00:00',
      'Europe/Kyiv',
      '2026-04-27 00:00:00',
    ]);
    expect(result.summary).toEqual({
      totalDocs: 5,
      totalEntities: 10,
      avgConfidence: 92.5,
      gdprCount: 3,
      hipaaCount: 2,
    });
    expect(result.chartData).toEqual([
      { label: 'PERSON', value: 6 },
      { label: 'DATE_TIME', value: 4 },
    ]);
  });

  it('should return zero-value fallback when a query fails', async () => {
    entityManagerMock.query.mockRejectedValue(new Error('db error'));

    const result = await service.getDashboardData(TEST_USER_UUID);

    expect(result).toEqual({
      summary: {
        totalDocs: 0,
        totalEntities: 0,
        avgConfidence: 0,
        gdprCount: 0,
        hipaaCount: 0,
      },
      chartData: [],
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
