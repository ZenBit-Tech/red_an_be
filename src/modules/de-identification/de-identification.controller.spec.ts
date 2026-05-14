import { StreamableFile } from '@nestjs/common';
import DeIdController from './de-identification.controller';
import { DeIdStatsPeriod } from './de-identification.constants';
import DeIdService from './de-identification.service';
import {
  AnalyzeRequestDto,
  BulkUpdateEntityStatusesRequestDto,
  GenerateSyntheticTableRequestDto,
  PreviewRequestDto,
  PreviewValidationMode,
  RegenerateSyntheticTableRequestDto,
  SyntheticOutputFormat,
} from './dto/request.dto';
import { DeIdStatsQueryDto } from './dto/stats-query.dto';
import StatsService from './stats.service';

type DeIdServiceContract = Pick<
  DeIdService,
  | 'analyzeText'
  | 'bulkUpdateEntityStatuses'
  | 'downloadSyntheticArchive'
  | 'generateSyntheticTable'
  | 'getPreviewWithValidation'
  | 'getRemoteNlpHealth'
  | 'regenerateSyntheticTable'
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
    downloadSyntheticArchive: jest.Mock;
    generateSyntheticTable: jest.Mock;
    getPreviewWithValidation: jest.Mock;
    getRemoteNlpHealth: jest.Mock;
    regenerateSyntheticTable: jest.Mock;
  };
  let statsServiceMock: {
    getDashboardData: jest.Mock;
  };

  beforeEach(() => {
    deIdServiceMock = {
      analyzeText: jest.fn(),
      bulkUpdateEntityStatuses: jest.fn(),
      downloadSyntheticArchive: jest.fn(),
      generateSyntheticTable: jest.fn(),
      getPreviewWithValidation: jest.fn(),
      getRemoteNlpHealth: jest.fn(),
      regenerateSyntheticTable: jest.fn(),
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
      validationMode: PreviewValidationMode.WARN_ONLY,
    };

    deIdServiceMock.getPreviewWithValidation.mockResolvedValue({
      anonymizedText: '[REDACT] Doe',
      postValidation: {
        valid: true,
        mode: PreviewValidationMode.WARN_ONLY,
        leaks: [],
        summary: [],
      },
    });

    const result = await controller.preview(dto, TEST_USER);

    expect(deIdServiceMock.getPreviewWithValidation).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.getPreviewWithValidation).toHaveBeenCalledWith(dto, TEST_USER.uuid);
    expect(result).toEqual({
      anonymizedText: '[REDACT] Doe',
      postValidation: {
        valid: true,
        mode: PreviewValidationMode.WARN_ONLY,
        leaks: [],
        summary: [],
      },
    });
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

  it('should call service generateSyntheticTable and return table response', async () => {
    const dto: GenerateSyntheticTableRequestDto = {
      jobId: 'job-1',
      text: 'Patient John Doe visited on 2026-01-10',
      count: 3,
      outputFormat: SyntheticOutputFormat.TXT,
    };
    const serviceResponse = {
      generationId: 'gen-uuid-1',
      columns: ['PERSON', 'DATE & TIME'],
      rows: [{ variantNumber: 1, entities: { PERSON: 'Alex Reed', 'DATE & TIME': '1995-03-12' } }],
      summary: { totalRows: 1, generatedAt: '2026-05-14T10:00:00.000Z', framework: 'GDPR_EU' },
    };

    deIdServiceMock.generateSyntheticTable.mockResolvedValue(serviceResponse);

    const result = await controller.generateSyntheticTable(dto, TEST_USER);

    expect(deIdServiceMock.generateSyntheticTable).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.generateSyntheticTable).toHaveBeenCalledWith(dto, TEST_USER.uuid);
    expect(result).toEqual(serviceResponse);
  });

  it('should call service downloadSyntheticArchive and return StreamableFile', async () => {
    deIdServiceMock.downloadSyntheticArchive.mockResolvedValue({
      jobId: 'job-1',
      variantsGenerated: 3,
      outputFormat: SyntheticOutputFormat.TXT,
      mimeType: 'application/zip',
      filename: 'synthetic-variants-job-1.zip',
      archiveBuffer: Buffer.from('zip-content'),
    });

    const result = await controller.downloadSyntheticArchive('gen-uuid-1', TEST_USER);

    expect(deIdServiceMock.downloadSyntheticArchive).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.downloadSyntheticArchive).toHaveBeenCalledWith(
      'gen-uuid-1',
      TEST_USER.uuid,
    );
    expect(result).toBeInstanceOf(StreamableFile);
    expect(result.getHeaders()).toMatchObject({
      type: 'application/zip',
      disposition: 'attachment; filename="synthetic-variants-job-1.zip"',
    });
  });

  it('should call service regenerateSyntheticTable and return new table response', async () => {
    const dto: RegenerateSyntheticTableRequestDto = {
      count: 3,
      outputFormat: SyntheticOutputFormat.TXT,
    };
    const serviceResponse = {
      generationId: 'gen-uuid-2',
      columns: ['PERSON', 'DATE & TIME'],
      rows: [
        { variantNumber: 1, entities: { PERSON: 'Jordan Parker', 'DATE & TIME': '1988-07-04' } },
      ],
      summary: { totalRows: 1, generatedAt: '2026-05-14T10:01:00.000Z', framework: 'GDPR_EU' },
    };

    deIdServiceMock.regenerateSyntheticTable.mockResolvedValue(serviceResponse);

    const result = await controller.regenerateSyntheticTable('gen-uuid-1', dto, TEST_USER);

    expect(deIdServiceMock.regenerateSyntheticTable).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.regenerateSyntheticTable).toHaveBeenCalledWith(
      'gen-uuid-1',
      dto,
      TEST_USER.uuid,
    );
    expect(result).toEqual(serviceResponse);
  });
});
