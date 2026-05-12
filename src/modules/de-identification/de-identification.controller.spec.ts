import DeIdController from './de-identification.controller';
import { DeIdStatsPeriod } from './de-identification.constants';
import DeIdService from './de-identification.service';
import {
  AnalyzeRequestDto,
  BulkUpdateEntityStatusesRequestDto,
  GenerateSyntheticVariantsRequestDto,
  PreviewRequestDto,
  SyntheticOutputFormat,
} from './dto/request.dto';
import { DeIdStatsQueryDto } from './dto/stats-query.dto';
import StatsService from './stats.service';

type DeIdServiceContract = Pick<
  DeIdService,
  | 'analyzeText'
  | 'bulkUpdateEntityStatuses'
  | 'generateSyntheticVariants'
  | 'getPreview'
  | 'getRemoteNlpHealth'
>;
type StatsServiceContract = Pick<StatsService, 'getDashboardData'>;
const TEST_USER = {
  uuid: 'user-uuid-1',
  email: 'user@example.com',
};

describe('DeIdController', () => {
  let controller: DeIdController;
  let deIdServiceMock: {
    analyzeText: jest.Mock;
    bulkUpdateEntityStatuses: jest.Mock;
    generateSyntheticVariants: jest.Mock;
    getPreview: jest.Mock;
    getRemoteNlpHealth: jest.Mock;
  };
  let statsServiceMock: {
    getDashboardData: jest.Mock;
  };

  beforeEach(() => {
    deIdServiceMock = {
      analyzeText: jest.fn(),
      bulkUpdateEntityStatuses: jest.fn(),
      generateSyntheticVariants: jest.fn(),
      getPreview: jest.fn(),
      getRemoteNlpHealth: jest.fn(),
    };

    statsServiceMock = {
      getDashboardData: jest.fn(),
    };

    controller = new DeIdController(
      deIdServiceMock as unknown as DeIdServiceContract as DeIdService,
      statsServiceMock as unknown as StatsServiceContract as StatsService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should call service analyzeText', async () => {
    const dto: AnalyzeRequestDto = {
      text: 'John Doe',
      framework: 'GDPR_EU' as AnalyzeRequestDto['framework'],
      threshold: 0.85,
      preserveStructure: true,
      includeExternalRecognizers: true,
    };

    deIdServiceMock.analyzeText.mockResolvedValue({
      jobId: 'job-1',
      findings: [],
    });

    const result = await controller.analyze(dto, TEST_USER);

    expect(deIdServiceMock.analyzeText).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.analyzeText).toHaveBeenCalledWith(dto, TEST_USER.uuid);
    expect(result).toEqual({ jobId: 'job-1', findings: [] });
  });

  it('should call service getPreview and wrap anonymized text', async () => {
    const dto: PreviewRequestDto = {
      jobId: 'job-1',
      text: 'John Doe',
      framework: 'GDPR_EU' as PreviewRequestDto['framework'],
      activeIds: [],
    };

    deIdServiceMock.getPreview.mockResolvedValue('[REDACT] Doe');

    const result = await controller.preview(dto, TEST_USER);

    expect(deIdServiceMock.getPreview).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.getPreview).toHaveBeenCalledWith(dto, TEST_USER.uuid);
    expect(result).toEqual({ anonymizedText: '[REDACT] Doe' });
  });

  it('should call service bulkUpdateEntityStatuses', async () => {
    const dto: BulkUpdateEntityStatusesRequestDto = {
      jobId: 'job-1',
      activeEntityIds: ['entity-1', 'entity-2'],
    };

    deIdServiceMock.bulkUpdateEntityStatuses.mockResolvedValue({
      jobId: 'job-1',
      updatedCount: 2,
      findings: [],
    });

    const result = await controller.bulkUpdateEntityStatuses(dto, TEST_USER);

    expect(deIdServiceMock.bulkUpdateEntityStatuses).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.bulkUpdateEntityStatuses).toHaveBeenCalledWith(dto, TEST_USER.uuid);
    expect(result).toEqual({
      jobId: 'job-1',
      updatedCount: 2,
      findings: [],
    });
  });

  it('should return remote NLP health status', async () => {
    deIdServiceMock.getRemoteNlpHealth.mockResolvedValue({
      configured: true,
      reachable: true,
      latencyMs: 15,
      details: 'ok',
    });

    const result = await controller.remoteNlpHealth();

    expect(deIdServiceMock.getRemoteNlpHealth).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      configured: true,
      reachable: true,
      latencyMs: 15,
      details: 'ok',
    });
  });

  it('should return de-identification dashboard stats', async () => {
    const query: DeIdStatsQueryDto = {
      period: DeIdStatsPeriod.LAST_7_DAYS,
      timezone: 'Europe/Kyiv',
    };

    statsServiceMock.getDashboardData.mockResolvedValue({
      meta: {
        period: DeIdStatsPeriod.LAST_7_DAYS,
        timezone: 'Europe/Kyiv',
        rangeStart: '2026-04-20 00:00:00',
        rangeEndExclusive: '2026-04-27 00:00:00',
        previousRangeStart: '2026-04-13 00:00:00',
        previousRangeEndExclusive: '2026-04-20 00:00:00',
      },
      summary: {
        totalDocuments: 5,
        entitiesDetected: 10,
        avgEntitiesPerDoc: 2,
        successRate: 100,
        trends: {
          totalDocumentsPct: 12,
          entitiesDetectedPct: 8,
          avgEntitiesPerDocPct: 4,
          successRatePct: 0,
        },
      },
      charts: {
        complianceFrameworkUsage: [
          { framework: 'HIPAA', count: 2, percentage: 40 },
          { framework: 'GDPR_EU', count: 2, percentage: 40 },
          { framework: 'GDPR_UK', count: 1, percentage: 20 },
        ],
        entityTypesDetected: [
          { label: 'PERSON', value: 6 },
          { label: 'DATE_TIME', value: 4 },
        ],
        processingHistory: [{ date: '2026-04-26', documents: 5, entities: 10 }],
        confidenceScoreDistribution: [{ bucket: '90-100%', value: 7 }],
        deIdentificationMethodUsage: [{ method: 'Redact', value: 6 }],
      },
    });

    const result = await controller.getStats(TEST_USER, query);

    expect(statsServiceMock.getDashboardData).toHaveBeenCalledTimes(1);
    expect(statsServiceMock.getDashboardData).toHaveBeenCalledWith(TEST_USER.uuid, query);
    expect(result).toEqual({
      meta: {
        period: DeIdStatsPeriod.LAST_7_DAYS,
        timezone: 'Europe/Kyiv',
        rangeStart: '2026-04-20 00:00:00',
        rangeEndExclusive: '2026-04-27 00:00:00',
        previousRangeStart: '2026-04-13 00:00:00',
        previousRangeEndExclusive: '2026-04-20 00:00:00',
      },
      summary: {
        totalDocuments: 5,
        entitiesDetected: 10,
        avgEntitiesPerDoc: 2,
        successRate: 100,
        trends: {
          totalDocumentsPct: 12,
          entitiesDetectedPct: 8,
          avgEntitiesPerDocPct: 4,
          successRatePct: 0,
        },
      },
      charts: {
        complianceFrameworkUsage: [
          { framework: 'HIPAA', count: 2, percentage: 40 },
          { framework: 'GDPR_EU', count: 2, percentage: 40 },
          { framework: 'GDPR_UK', count: 1, percentage: 20 },
        ],
        entityTypesDetected: [
          { label: 'PERSON', value: 6 },
          { label: 'DATE_TIME', value: 4 },
        ],
        processingHistory: [{ date: '2026-04-26', documents: 5, entities: 10 }],
        confidenceScoreDistribution: [{ bucket: '90-100%', value: 7 }],
        deIdentificationMethodUsage: [{ method: 'Redact', value: 6 }],
      },
    });
  });

  it('should call service generateSyntheticVariants', async () => {
    const dto: GenerateSyntheticVariantsRequestDto = {
      jobId: 'job-1',
      text: 'Patient John Doe visited on 2026-01-10',
      count: 5,
      outputFormat: SyntheticOutputFormat.TXT,
    };

    deIdServiceMock.generateSyntheticVariants.mockResolvedValue({
      jobId: 'job-1',
      variantsGenerated: 5,
      outputFormat: SyntheticOutputFormat.TXT,
      mimeType: 'application/zip',
      filename: 'synthetic-variants-job-1.zip',
    });

    const result = await controller.generateSyntheticVariants(dto, TEST_USER);

    expect(deIdServiceMock.generateSyntheticVariants).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.generateSyntheticVariants).toHaveBeenCalledWith(dto, TEST_USER.uuid);
    expect(result).toEqual({
      jobId: 'job-1',
      variantsGenerated: 5,
      outputFormat: SyntheticOutputFormat.TXT,
      mimeType: 'application/zip',
      filename: 'synthetic-variants-job-1.zip',
    });
  });
});
