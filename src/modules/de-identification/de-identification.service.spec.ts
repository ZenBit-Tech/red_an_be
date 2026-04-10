import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  ComplianceFramework,
  DE_ID_CONFIG,
  DE_ID_EXTERNAL_RECOGNIZERS_ENV,
  DE_ID_REMOTE_NLP_ENV,
} from '@common/constants/compliance.constants';
import DeIdJob from '@db/entities/de-id-job.entity';
import DetectedEntity from '@db/entities/detected-entity.entity';
import DeIdService from './de-identification.service';
import PresidioClient from './presidio.client';
import RemoteNlpClient from './remote-nlp.client';

type AnalyzerFinding = {
  entity_type: string;
  start: number;
  end: number;
  score: number;
};

type TransactionManagerMock = {
  create: jest.Mock;
  save: jest.Mock;
};

type PresidioClientContract = Pick<PresidioClient, 'analyze'>;
type RemoteNlpClientContract = Pick<RemoteNlpClient, 'analyze' | 'isConfigured' | 'healthCheck'>;

describe('DeIdService', () => {
  let service: DeIdService;
  let entityManagerMock: {
    transaction: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let presidioClientMock: {
    analyze: jest.Mock;
  };
  let remoteNlpClientMock: {
    analyze: jest.Mock;
    isConfigured: jest.Mock;
    healthCheck: jest.Mock;
  };
  let configServiceMock: {
    get: jest.Mock;
  };

  const originalMaxChunkSize = DE_ID_CONFIG.MAX_CHUNK_SIZE;
  const originalChunkOverlap = DE_ID_CONFIG.CHUNK_OVERLAP;

  beforeEach(() => {
    entityManagerMock = {
      transaction: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    presidioClientMock = {
      analyze: jest.fn(),
    };

    remoteNlpClientMock = {
      analyze: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(false),
      healthCheck: jest.fn(),
    };

    configServiceMock = {
      get: jest.fn().mockReturnValue(undefined),
    };

    service = new DeIdService(
      entityManagerMock as unknown as EntityManager,
      presidioClientMock as PresidioClientContract as unknown as PresidioClient,
      remoteNlpClientMock as RemoteNlpClientContract as unknown as RemoteNlpClient,
      configServiceMock as unknown as ConfigService,
    );
  });

  afterEach(() => {
    DE_ID_CONFIG.MAX_CHUNK_SIZE = originalMaxChunkSize;
    DE_ID_CONFIG.CHUNK_OVERLAP = originalChunkOverlap;
    jest.clearAllMocks();
  });

  it('should analyze with overlap chunks and deduplicate overlapped findings', async () => {
    DE_ID_CONFIG.MAX_CHUNK_SIZE = 6;
    DE_ID_CONFIG.CHUNK_OVERLAP = 2;

    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-1',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return {
          id: 'entity-id',
          ...payload,
        };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    presidioClientMock.analyze
      .mockResolvedValueOnce([
        { entity_type: 'PERSON', start: 5, end: 6, score: 0.9 },
      ] satisfies AnalyzerFinding[])
      .mockResolvedValueOnce([
        { entity_type: 'PERSON', start: 1, end: 2, score: 0.9 },
      ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'abcdefghij',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: true,
    });

    expect(presidioClientMock.analyze).toHaveBeenCalledTimes(2);
    expect(presidioClientMock.analyze.mock.calls[0][2]).toContain('PERSON');
    expect(presidioClientMock.analyze.mock.calls[0][2]).toContain('AGE');
    // IMAGE always excluded (requires separate Image Redactor API)
    expect(presidioClientMock.analyze.mock.calls[0][2]).not.toContain('IMAGE');
    // Clinical NLP flag off by default → FREE_TEXT and HEALTH_DATA excluded
    expect(presidioClientMock.analyze.mock.calls[0][2]).not.toContain('FREE_TEXT');
    expect(result.jobId).toBe('job-1');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      category: 'PERSON',
      start: 5,
      end: 6,
      proxyType: 'Hash',
    });
  });

  it('should reject preview when text is inconsistent with analyzed input', async () => {
    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-1',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: 'another-hash',
      sourceTextLength: 5,
    } satisfies Partial<DeIdJob>);

    await expect(
      service.getPreview({
        jobId: 'job-1',
        text: 'changed text',
        framework: ComplianceFramework.GDPR_EU,
        activeIds: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should produce preview when text is consistent with analyzed input', async () => {
    const text = 'John met 2020';

    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-1',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e2',
        jobId: 'job-1',
        category: 'DATE_TIME',
        confidence: 90,
        start: 9,
        end: 13,
        proxyType: 'Date Shifting',
      },
      {
        id: 'e1',
        jobId: 'job-1',
        category: 'PERSON',
        confidence: 95,
        start: 0,
        end: 4,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-1',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e1', 'e2'],
    });

    expect(preview).toBe('[REDACT] met 2020');
  });

  it('should wrap unexpected preview failures with internal error', async () => {
    entityManagerMock.findOne.mockRejectedValue(new Error('db error'));

    await expect(
      service.getPreview({
        jobId: 'job-1',
        text: 'text',
        framework: ComplianceFramework.GDPR_EU,
        activeIds: [],
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('should keep surrounding characters intact for multiple precise spans in preview', async () => {
    const text =
      'He is a conservative and identifies as gay. Patient has diabetes and says he is muslim.';

    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-precise',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e4',
        jobId: 'job-precise',
        category: 'RELIGION',
        confidence: 96.9,
        start: 80,
        end: 86,
        proxyType: 'Redact',
      },
      {
        id: 'e3',
        jobId: 'job-precise',
        category: 'HEALTH_DATA',
        confidence: 90,
        start: 56,
        end: 64,
        proxyType: 'Redact',
      },
      {
        id: 'e2',
        jobId: 'job-precise',
        category: 'SEXUAL_ORIENTATION',
        confidence: 99.9,
        start: 39,
        end: 42,
        proxyType: 'Redact',
      },
      {
        id: 'e1',
        jobId: 'job-precise',
        category: 'POLITICAL_VIEWS',
        confidence: 99.6,
        start: 8,
        end: 20,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-precise',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e1', 'e2', 'e3', 'e4'],
    });

    expect(preview).toBe(
      'He is a [REDACT] and identifies as [REDACT]. Patient has [REDACT] and says he is [REDACT].',
    );
  });

  it('should merge remote NLP findings when external recognizers are enabled', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-remote',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return {
          id: `entity-${payload.category as string}`,
          ...payload,
        };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    configServiceMock.get.mockImplementation((key: string) => {
      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.CLINICAL_NLP_ENABLED) {
        return 'true';
      }

      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.SENSITIVE_CATEGORIES_ENABLED) {
        return 'true';
      }

      if (key === DE_ID_REMOTE_NLP_ENV.STRICT_MODE) {
        return 'false';
      }

      return undefined;
    });

    remoteNlpClientMock.isConfigured.mockReturnValue(true);

    presidioClientMock.analyze.mockResolvedValue([
      { entity_type: 'PERSON', start: 0, end: 4, score: 0.8 },
    ] satisfies AnalyzerFinding[]);

    remoteNlpClientMock.analyze.mockResolvedValue([
      { entity_type: 'FREE_TEXT', start: 10, end: 20, score: 0.92 },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'John says sensitive details',
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.85,
      preserveStructure: true,
    });

    expect(remoteNlpClientMock.analyze).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.some((finding) => finding.category === 'FREE_TEXT')).toBe(true);
  });

  it('should fallback to Presidio findings when remote NLP fails in non-strict mode', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-fallback',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return {
          id: `entity-${payload.category as string}`,
          ...payload,
        };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    configServiceMock.get.mockImplementation((key: string) => {
      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.CLINICAL_NLP_ENABLED) {
        return 'true';
      }

      if (key === DE_ID_REMOTE_NLP_ENV.STRICT_MODE) {
        return 'false';
      }

      return undefined;
    });

    remoteNlpClientMock.isConfigured.mockReturnValue(true);
    remoteNlpClientMock.analyze.mockRejectedValue(new Error('remote nlp unavailable'));

    presidioClientMock.analyze.mockResolvedValue([
      { entity_type: 'PERSON', start: 0, end: 4, score: 0.9 },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'John',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: true,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('PERSON');
  });

  it('should fail analysis when remote NLP fails in strict mode', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-strict',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return {
          id: `entity-${payload.category as string}`,
          ...payload,
        };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    configServiceMock.get.mockImplementation((key: string) => {
      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.CLINICAL_NLP_ENABLED) {
        return 'true';
      }

      if (key === DE_ID_REMOTE_NLP_ENV.STRICT_MODE) {
        return 'true';
      }

      return undefined;
    });

    remoteNlpClientMock.isConfigured.mockReturnValue(true);
    remoteNlpClientMock.analyze.mockRejectedValue(new Error('remote nlp unavailable'));

    presidioClientMock.analyze.mockResolvedValue([
      { entity_type: 'PERSON', start: 0, end: 4, score: 0.9 },
    ] satisfies AnalyzerFinding[]);

    await expect(
      service.analyzeText({
        text: 'John',
        framework: ComplianceFramework.GDPR_EU,
        threshold: 0.85,
        preserveStructure: true,
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('should not call remote NLP when request override disables external recognizers', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-override-off',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return {
          id: `entity-${payload.category as string}`,
          ...payload,
        };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    configServiceMock.get.mockImplementation((key: string) => {
      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.CLINICAL_NLP_ENABLED) {
        return 'true';
      }

      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.SENSITIVE_CATEGORIES_ENABLED) {
        return 'true';
      }

      return undefined;
    });

    remoteNlpClientMock.isConfigured.mockReturnValue(true);
    remoteNlpClientMock.analyze.mockResolvedValue([
      { entity_type: 'FREE_TEXT', start: 10, end: 20, score: 0.95 },
    ] satisfies AnalyzerFinding[]);

    presidioClientMock.analyze.mockResolvedValue([
      { entity_type: 'PERSON', start: 0, end: 4, score: 0.9 },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'John says sensitive details',
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.85,
      preserveStructure: true,
      includeExternalRecognizers: false,
    });

    expect(remoteNlpClientMock.analyze).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('PERSON');
  });

  it('should return not configured status for remote NLP health', async () => {
    remoteNlpClientMock.isConfigured.mockReturnValue(false);

    const result = await service.getRemoteNlpHealth();

    expect(result).toEqual({
      configured: false,
      reachable: false,
      latencyMs: null,
      details: 'Remote NLP URL is not configured',
    });
  });

  it('should return reachable status for remote NLP health', async () => {
    remoteNlpClientMock.isConfigured.mockReturnValue(true);
    remoteNlpClientMock.healthCheck.mockResolvedValue({ status: 'ok' });

    const result = await service.getRemoteNlpHealth();

    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.details).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('should return unreachable status when remote NLP health fails', async () => {
    remoteNlpClientMock.isConfigured.mockReturnValue(true);
    remoteNlpClientMock.healthCheck.mockRejectedValue(new Error('health failed'));

    const result = await service.getRemoteNlpHealth();

    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.details).toContain('health failed');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('should reject preview when job is not found', async () => {
    entityManagerMock.findOne.mockResolvedValue(null);

    await expect(
      service.getPreview({
        jobId: 'non-existent',
        text: 'some text',
        framework: ComplianceFramework.GDPR_EU,
        activeIds: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should apply hash operator in preview', async () => {
    const text = 'ABC12345';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-hash',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-hash',
        category: 'DEVICE_ID',
        confidence: 90,
        start: 0,
        end: 8,
        proxyType: 'Hash',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-hash',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e1'],
    });

    expect(preview).toBe('[HASH_8]');
  });

  it('should apply replace synthetic operator in preview', async () => {
    const text = 'John is here';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-synthetic',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-synthetic',
        category: 'PERSON',
        confidence: 95,
        start: 0,
        end: 4,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-synthetic',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e1'],
    });

    expect(preview).toBe('[SYNTHETIC_ID] is here');
  });

  it('should apply keep_domain and mask operators for email in preview', async () => {
    const text = 'Contact john@example.com now';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-email',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-email',
        category: 'EMAIL_ADDRESS',
        confidence: 98,
        start: 8,
        end: 24,
        proxyType: 'Mask',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-email',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e1'],
    });

    expect(preview).toBe('Contact ****@example.com now');
  });

  it('should apply mask with keepLast operator for credit card in preview', async () => {
    const text = '1234567890121234';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-cc',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-cc',
        category: 'CREDIT_CARD',
        confidence: 99,
        start: 0,
        end: 16,
        proxyType: 'Mask',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-cc',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e1'],
    });

    expect(preview).toBe('************1234');
  });

  it('should apply aggregate buckets operator for age in preview', async () => {
    const text = 'Patient aged 35';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-age',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-age',
        category: 'AGE',
        confidence: 93,
        start: 13,
        end: 15,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-age',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e1'],
    });

    expect(preview).toBe('Patient aged [30-49]');
  });

  it('should apply truncate and hash operators for IP address in preview', async () => {
    const text = 'IP: 192.168.1.100';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-ip',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-ip',
        category: 'IP_ADDRESS',
        confidence: 97,
        start: 4,
        end: 17,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-ip',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e1'],
    });

    // truncate(subnet:24) → '192.168.1.0' (length 11), then hash → '[HASH_11]'
    expect(preview).toBe('IP: [HASH_11]');
  });

  it('should apply generalize level operator for location in preview', async () => {
    const text = 'Patient from New York';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-loc',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e1',
        jobId: 'job-loc',
        category: 'LOCATION',
        confidence: 91,
        start: 13,
        end: 21,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-loc',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e1'],
    });

    expect(preview).toBe('Patient from [STATE]');
  });

  it('should resolve overlapping findings by keeping the higher-score result', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-overlap',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return {
          id: `entity-${payload.category as string}`,
          ...payload,
        };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    configServiceMock.get.mockImplementation((key: string) => {
      if (key === DE_ID_EXTERNAL_RECOGNIZERS_ENV.CLINICAL_NLP_ENABLED) {
        return 'true';
      }

      if (key === DE_ID_REMOTE_NLP_ENV.STRICT_MODE) {
        return 'false';
      }

      return undefined;
    });

    remoteNlpClientMock.isConfigured.mockReturnValue(true);

    // Presidio: lower score, wider span
    presidioClientMock.analyze.mockResolvedValue([
      { entity_type: 'FREE_TEXT', start: 0, end: 10, score: 0.7 },
    ] satisfies AnalyzerFinding[]);

    // Remote NLP: higher score, narrower span — should win
    remoteNlpClientMock.analyze.mockResolvedValue([
      { entity_type: 'FREE_TEXT', start: 0, end: 8, score: 0.92 },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'sensitive information here',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.5,
      preserveStructure: false,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].start).toBe(0);
    expect(result.findings[0].end).toBe(8);
  });

  it('should wrap analyzeText db save failure with internal error', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
        id: 'job-fail',
        ...payload,
      })),
      save: jest.fn().mockRejectedValue(new Error('db write error')),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    await expect(
      service.analyzeText({
        text: 'test text',
        framework: ComplianceFramework.GDPR_EU,
        threshold: 0.85,
        preserveStructure: false,
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
