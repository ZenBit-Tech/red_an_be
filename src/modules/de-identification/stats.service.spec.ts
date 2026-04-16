import { EntityManager } from 'typeorm';

import { ComplianceFramework } from '@common/constants/compliance.constants';

import StatsService from './stats.service';

describe('StatsService', () => {
  let service: StatsService;
  let entityManagerMock: { query: jest.Mock };

  beforeEach(() => {
    entityManagerMock = { query: jest.fn() };
    service = new StatsService(entityManagerMock as unknown as EntityManager);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return dashboard data on success', async () => {
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

    const result = await service.getDashboardData();

    expect(entityManagerMock.query).toHaveBeenCalledTimes(2);
    expect(entityManagerMock.query.mock.calls[0][1]).toEqual([
      ComplianceFramework.GDPR_EU,
      ComplianceFramework.HIPAA,
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

    const result = await service.getDashboardData();

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
});
