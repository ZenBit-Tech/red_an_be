import DeIdController from './de-identification.controller';
import DeIdService from './de-identification.service';
import { AnalyzeRequestDto, PreviewRequestDto } from './dto/request.dto';
import StatsService from './stats.service';

type DeIdServiceContract = Pick<DeIdService, 'analyzeText' | 'getPreview' | 'getRemoteNlpHealth'>;
type StatsServiceContract = Pick<StatsService, 'getDashboardData'>;

describe('DeIdController', () => {
  let controller: DeIdController;
  let deIdServiceMock: {
    analyzeText: jest.Mock;
    getPreview: jest.Mock;
    getRemoteNlpHealth: jest.Mock;
  };
  let statsServiceMock: {
    getDashboardData: jest.Mock;
  };

  beforeEach(() => {
    deIdServiceMock = {
      analyzeText: jest.fn(),
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

    const result = await controller.analyze(dto);

    expect(deIdServiceMock.analyzeText).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.analyzeText).toHaveBeenCalledWith(dto);
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

    const result = await controller.preview(dto);

    expect(deIdServiceMock.getPreview).toHaveBeenCalledTimes(1);
    expect(deIdServiceMock.getPreview).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ anonymizedText: '[REDACT] Doe' });
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
    statsServiceMock.getDashboardData.mockResolvedValue({
      summary: {
        totalDocs: 5,
        totalEntities: 10,
        avgConfidence: 92.5,
        gdprCount: 3,
        hipaaCount: 2,
      },
      chartData: [
        { label: 'PERSON', value: 6 },
        { label: 'DATE_TIME', value: 4 },
      ],
    });

    const result = await controller.getStats();

    expect(statsServiceMock.getDashboardData).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      summary: {
        totalDocs: 5,
        totalEntities: 10,
        avgConfidence: 92.5,
        gdprCount: 3,
        hipaaCount: 2,
      },
      chartData: [
        { label: 'PERSON', value: 6 },
        { label: 'DATE_TIME', value: 4 },
      ],
    });
  });
});
