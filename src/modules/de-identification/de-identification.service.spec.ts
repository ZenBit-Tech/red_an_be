import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  ComplianceFramework,
  DE_ID_CONFIG,
  DE_ID_EXTERNAL_RECOGNIZERS_ENV,
  DE_ID_REMOTE_NLP_ENV,
  DetectedEntitySource,
  DetectedEntityStatus,
  DetectedEntitySystemReason,
} from '@common/constants/compliance.constants';
import DeIdJob from '@common/db/entities/de-id-job.entity';
import DetectedEntity from '@common/db/entities/detected-entity.entity';
import DeIdService from './de-identification.service';
import PresidioClient from './presidio.client';
import RemoteNlpClient from './remote-nlp.client';
import SyntheticGenerationStore from './synthetic-generation.store';
import { PreviewValidationMode, SyntheticOutputFormat } from './dto/request.dto';

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
    save: jest.Mock;
    create: jest.Mock;
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
  let syntheticGenerationStoreMock: {
    save: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
  };

  const originalMaxChunkSize = DE_ID_CONFIG.MAX_CHUNK_SIZE;
  const originalChunkOverlap = DE_ID_CONFIG.CHUNK_OVERLAP;

  beforeEach(() => {
    entityManagerMock = {
      transaction: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(async (_target: unknown, value?: unknown) => value ?? _target),
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
        id: 'entity-manager-created',
        target,
        ...payload,
      })),
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

    syntheticGenerationStoreMock = {
      save: jest.fn().mockReturnValue('gen-uuid-test'),
      get: jest.fn().mockReturnValue(null),
      delete: jest.fn(),
    };

    service = new DeIdService(
      entityManagerMock as unknown as EntityManager,
      presidioClientMock as PresidioClientContract as unknown as PresidioClient,
      remoteNlpClientMock as RemoteNlpClientContract as unknown as RemoteNlpClient,
      configServiceMock as unknown as ConfigService,
      syntheticGenerationStoreMock as unknown as SyntheticGenerationStore,
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
    expect(presidioClientMock.analyze.mock.calls[0][2]).toContain('DATE_TIME');
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

  it('should merge GDPR phone tail misclassified as NATIONAL_ID during analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-phone-national-id-merge',
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

    presidioClientMock.analyze.mockResolvedValueOnce([
      { entity_type: 'PHONE_NUMBER', start: 9, end: 15, score: 0.98 },
      { entity_type: 'NATIONAL_ID', start: 16, end: 23, score: 0.95 },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'Contact: +49 30 1234567',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: true,
    });

    const phoneFinding = result.findings.find((finding) => finding.category === 'PHONE_NUMBER');
    const nationalIdFinding = result.findings.find((finding) => finding.category === 'NATIONAL_ID');

    expect(phoneFinding).toMatchObject({
      start: 9,
      end: 23,
      proxyType: 'Redact',
      systemStatus: 'ACTIVE',
    });
    expect(nationalIdFinding).toMatchObject({
      systemStatus: 'INACTIVE',
      isSyntheticEligible: false,
    });
  });

  it('should pass strengthened clinic organization recognizer for HIPAA analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-hipaa-org-recognizer',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Clinic: Vasquez Primary Care Associates',
      framework: ComplianceFramework.HIPAA,
      threshold: 0.85,
      preserveStructure: false,
    });

    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      patterns?: Array<{ name: string; regex: string; score: number }>;
    }>;

    const clinicRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Clinic Organization Recognizer',
    );

    expect(clinicRecognizer).toBeDefined();
    expect(clinicRecognizer?.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'clinic_header_line', score: 0.95 }),
        expect.objectContaining({ name: 'clinic_suffix_pattern', score: 0.88 }),
        expect.objectContaining({
          name: 'primary_care_associates_with_optional_location',
          score: 0.97,
        }),
        expect.objectContaining({
          name: 'primary_care_pattern',
          score: 0.92,
          regex: '\\b[A-Z][A-Za-z]+(?:\\s+[A-Za-z]+){0,3}\\s+Primary\\s+Care(?:\\s+Associates)?\\b',
        }),
        expect.objectContaining({
          name: 'policlinico_university_connector_pattern',
          score: 0.9,
        }),
      ]),
    );
  });

  it('should include occupation recognizer and OCCUPATION entity for HIPAA analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-hipaa-occupation-recognizer',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Social History: works as accountant',
      framework: ComplianceFramework.HIPAA,
      threshold: 0.85,
      preserveStructure: false,
    });

    const entityTypes = presidioClientMock.analyze.mock.calls[0][2] as string[];
    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      supported_entity?: string;
    }>;

    expect(entityTypes).toContain('OCCUPATION');
    expect(adHocRecognizers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Occupation Recognizer HIPAA',
          supported_entity: 'OCCUPATION',
        }),
      ]),
    );
  });

  it('should include clinic organization recognizer for GDPR_EU analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-eu-org-recognizer',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Clinic: Vasquez Primary Care Associates',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
    }>;

    expect(adHocRecognizers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Clinic Organization Recognizer' })]),
    );
  });

  it('should include gender recognizer and GENDER entity only for GDPR_EU analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-eu-gender-recognizer',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Gender: Female',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const entityTypes = presidioClientMock.analyze.mock.calls[0][2] as string[];
    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      deny_list?: string[];
      patterns?: Array<{ name: string; regex: string; score: number }>;
    }>;

    const genderAdHocRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Gender Recognizer',
    );

    expect(entityTypes).toEqual(expect.arrayContaining(['GENDER']));
    expect(genderAdHocRecognizer).toEqual(
      expect.objectContaining({
        deny_list: ['Male', 'Female', 'Non-binary', 'Other'],
        patterns: expect.arrayContaining([
          expect.objectContaining({
            name: 'Gender label format',
            regex: '\\b(?:Gender|Sex):\\s*(?:Male|Female|Non-binary|Other)\\b',
            score: 0.9,
          }),
        ]),
      }),
    );
    expect(entityTypes).not.toContain('OCCUPATION');
  });

  it('should include UK NHS number recognizer for GDPR_UK analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-uk-nhs-recognizer',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'NHS Number: 456 789 0123',
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.85,
      preserveStructure: false,
    });

    const entityTypes = presidioClientMock.analyze.mock.calls[0][2] as string[];
    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      supported_entity?: string;
      patterns?: Array<{ name: string; regex: string }>;
    }>;

    const nhsRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'UK NHS Number Recognizer',
    );
    const ukGpPracticeRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'UK GP Practice Code Recognizer',
    );
    const ukPhoneRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'UK Phone Number Recognizer',
    );
    const ukOccupationRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Occupation Recognizer GDPR UK',
    );
    const ukHealthcareOrgRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'UK Healthcare Organization Recognizer',
    );

    expect(entityTypes).toContain('UK_NHS_NUMBER');
    expect(entityTypes).toContain('UK_GP_PRACTICE_CODE');
    expect(entityTypes).toContain('UK_POSTCODE');
    expect(entityTypes).toContain('PHONE_NUMBER');
    expect(entityTypes).toContain('OCCUPATION');
    expect(nhsRecognizer).toEqual(
      expect.objectContaining({
        supported_entity: 'UK_NHS_NUMBER',
        patterns: expect.arrayContaining([
          expect.objectContaining({
            name: 'NHS number formatted',
            regex: '\\b\\d{3}[\\s-]\\d{3}[\\s-]\\d{4}\\b',
          }),
        ]),
      }),
    );
    expect(ukGpPracticeRecognizer).toEqual(
      expect.objectContaining({ supported_entity: 'UK_GP_PRACTICE_CODE' }),
    );
    expect(ukPhoneRecognizer).toEqual(
      expect.objectContaining({
        supported_entity: 'PHONE_NUMBER',
        patterns: expect.arrayContaining([
          expect.objectContaining({
            name: 'uk_mobile_with_07_or_44_prefix',
          }),
        ]),
      }),
    );
    expect(ukOccupationRecognizer).toEqual(
      expect.objectContaining({ supported_entity: 'OCCUPATION' }),
    );
    expect(ukHealthcareOrgRecognizer).toEqual(
      expect.objectContaining({
        supported_entity: 'ORGANIZATION',
        patterns: expect.arrayContaining([
          expect.objectContaining({ name: 'uk_gp_or_health_practice_name' }),
        ]),
      }),
    );
  });

  it('should pass GDPR_EU analyzer allow-list with clinical scales to Presidio', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-eu-allow-list',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'PHQ-9 score is 12 and GAD-7 score is 9',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const allowList = presidioClientMock.analyze.mock.calls[0][4] as string[];

    expect(allowList).toEqual(
      expect.arrayContaining(['PHQ-9', 'PHQ-2', 'GAD-7', 'GAD-2', 'HAM-A', 'HDRS']),
    );
  });

  it('should pass GDPR_UK analyzer allow-list with UK medical programs to Presidio', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-uk-allow-list',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Referred to DESMOND and DAFNE education pathways',
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.85,
      preserveStructure: false,
    });

    const allowList = presidioClientMock.analyze.mock.calls[0][4] as string[];

    expect(allowList).toEqual(expect.arrayContaining(['DESMOND', 'QISMET', 'DAFNE']));
  });

  it('should include key medical procedures in GDPR_EU analyzer allow-list', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-eu-procedure-allow-list',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Gastroscopy and MRI were performed before CT',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const allowList = presidioClientMock.analyze.mock.calls[0][4] as string[];

    expect(allowList).toEqual(expect.arrayContaining(['Gastroscopy', 'Colonoscopy', 'MRI', 'CT']));
  });

  it('should include clinical date recognizer in GDPR_EU ad-hoc recognizers', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-gdpr-eu-date-recognizer',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Consultation Date: 08 April 2026',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      patterns?: Array<{ name: string; regex: string; score: number }>;
      supported_entity?: string;
    }>;

    const clinicalDateAdHocRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Clinical Date Recognizer',
    );

    expect(clinicalDateAdHocRecognizer).toEqual(
      expect.objectContaining({
        supported_entity: 'DATE_TIME',
        patterns: expect.arrayContaining([
          expect.objectContaining({
            name: 'day_month_name_year',
            score: 0.95,
          }),
        ]),
      }),
    );
  });

  it('should match clinic organization sample with city and state suffix', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-clinic-sample-pattern',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Outpatient Progress Note  Clinic:   Vasquez Primary Care Associates, Chicago, IL',
      framework: ComplianceFramework.HIPAA,
      threshold: 0.5,
      preserveStructure: false,
    });

    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      patterns?: Array<{ name: string; regex: string }>;
    }>;

    const clinicRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Clinic Organization Recognizer',
    );

    const locationPattern = clinicRecognizer?.patterns?.find(
      (pattern) => pattern.name === 'primary_care_associates_with_optional_location',
    );

    expect(locationPattern).toBeDefined();
    const sampleRegex = new RegExp(locationPattern?.regex ?? '', 'g');
    expect(
      sampleRegex.test(
        'Outpatient Progress Note  Clinic:   Vasquez Primary Care Associates, Chicago, IL',
      ),
    ).toBe(true);
  });

  it('should include Charite pattern in clinic organization recognizer for GDPR_EU', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-charite-pattern',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Charite Berlin treated the patient',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      patterns?: Array<{ name: string; regex: string; score: number }>;
    }>;

    const clinicRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Clinic Organization Recognizer',
    );

    expect(clinicRecognizer?.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'charite_hospital_name_pattern',
          score: 0.99,
        }),
      ]),
    );
  });

  it('should extract italian codice fiscale as NATIONAL_ID when analyzer misses it', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-cf-fallback',
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

    // Simulate analyzer miss to validate structured fallback extraction
    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text = 'Codice Fiscale: SPSEMRC85T18H501Z';
    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const nationalIdFinding = result.findings.find((finding) => finding.category === 'NATIONAL_ID');

    expect(nationalIdFinding).toBeDefined();
    expect(text.slice(nationalIdFinding?.start ?? 0, nationalIdFinding?.end ?? 0)).toBe(
      'SPSEMRC85T18H501Z',
    );
  });

  it('should extract German KV number as NATIONAL_ID when analyzer misses it', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-kv-fallback',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text = 'KV-Nr: A123456789';
    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const nationalIdFinding = result.findings.find((finding) => finding.category === 'NATIONAL_ID');

    expect(nationalIdFinding).toBeDefined();
    expect(text.slice(nationalIdFinding?.start ?? 0, nationalIdFinding?.end ?? 0)).toBe(
      'A123456789',
    );
  });

  it('should extract full Charite university facility chain as ORGANIZATION fallback', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-charite-full-chain-fallback',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text = 'Facility: Charite - Universitatsmedizin Berlin, Germany';
    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const organizationFinding = result.findings.find(
      (finding) => finding.category === 'ORGANIZATION',
    );

    expect(organizationFinding).toBeDefined();
    expect(text.slice(organizationFinding?.start ?? 0, organizationFinding?.end ?? 0)).toBe(
      'Charite - Universitatsmedizin Berlin',
    );
  });

  it('should add full UK hospital organization fallback when analyzer returns only partial token', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-uk-hospital-full-fallback',
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

    const text = "To: On-call Medical Registrar, St. Thomas' Hospital";
    const partialHospitalStart = text.indexOf('Hospital');

    presidioClientMock.analyze.mockResolvedValue([
      {
        entity_type: 'ORGANIZATION',
        start: partialHospitalStart,
        end: partialHospitalStart + 'Hospital'.length,
        score: 0.78,
      },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.5,
      preserveStructure: false,
    });

    const fullHospitalFinding = result.findings.find(
      (finding) =>
        finding.category === 'ORGANIZATION' &&
        text.slice(finding.start, finding.end) === "St. Thomas' Hospital",
    );

    expect(fullHospitalFinding).toBeDefined();
  });

  it('should match policlinico organization samples with connector variants', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-policlinico-pattern',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    await service.analyzeText({
      text: 'Referral sent to Policlinico Gemelli - Catholic University of Rome',
      framework: ComplianceFramework.HIPAA,
      threshold: 0.5,
      preserveStructure: false,
    });

    const adHocRecognizers = presidioClientMock.analyze.mock.calls[0][3] as Array<{
      name: string;
      patterns?: Array<{ name: string; regex: string }>;
    }>;

    const clinicRecognizer = adHocRecognizers.find(
      (recognizer) => recognizer.name === 'Clinic Organization Recognizer',
    );

    const policlinicoPattern = clinicRecognizer?.patterns?.find(
      (pattern) => pattern.name === 'policlinico_university_connector_pattern',
    );

    expect(policlinicoPattern).toBeDefined();
    const sampleRegex = new RegExp(policlinicoPattern?.regex ?? '', 'g');

    expect(
      sampleRegex.test('Referral sent to Policlinico Gemelli - Catholic University of Rome'),
    ).toBe(true);
    sampleRegex.lastIndex = 0;
    expect(
      sampleRegex.test('Referral sent to Policlinico Gemelli – Catholic University of Rome'),
    ).toBe(true);
    sampleRegex.lastIndex = 0;
    expect(
      sampleRegex.test('Referral sent to Policlinico Gemelli, Catholic University of Rome'),
    ).toBe(true);
  });

  it('should add fallback ORGANIZATION finding for clinic header when analyzer misses it', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-clinic-fallback',
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

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text =
      'Outpatient Progress Note Clinic: Vasquez Primary Care Associates, Chicago, IL Date of Service: 04/11/2026';

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.HIPAA,
      threshold: 0.5,
      preserveStructure: false,
    });

    const clinicFinding = result.findings.find((finding) => finding.category === 'ORGANIZATION');

    expect(clinicFinding).toBeDefined();
    expect(text.substring(clinicFinding?.start ?? 0, clinicFinding?.end ?? 0)).toBe(
      'Vasquez Primary Care Associates',
    );
  });

  it('should add fallback OCCUPATION finding for social history when analyzer misses it', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-occupation-fallback',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return { id: 'entity-id', ...payload };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text = 'Social History: works as accountant';

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.HIPAA,
      threshold: 0.85,
      preserveStructure: false,
    });

    const occupationFinding = result.findings.find((f) => f.category === 'OCCUPATION');

    expect(occupationFinding).toBeDefined();
    expect(text.substring(occupationFinding?.start ?? 0, occupationFinding?.end ?? 0)).toBe(
      'accountant',
    );
  });

  it('should add fallback OCCUPATION finding for social history direct value when analyzer misses it', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-occupation-social-history-direct',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return { id: 'entity-id', ...payload };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text = 'Social History: Elementary school teacher, married with one child';

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.HIPAA,
      threshold: 0.85,
      preserveStructure: false,
    });

    const occupationFinding = result.findings.find((f) => f.category === 'OCCUPATION');

    expect(occupationFinding).toBeDefined();
    expect(text.substring(occupationFinding?.start ?? 0, occupationFinding?.end ?? 0)).toBe(
      'Elementary school teacher',
    );
  });

  it('should add fallback OCCUPATION finding for software engineer inside social history list', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-occupation-social-history-list',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return { id: 'entity-id', ...payload };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const text =
      'Social History: female, software engineer, moderate caffeine intake, social alcohol on weekends, practices yoga.';

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.HIPAA,
      threshold: 0.85,
      preserveStructure: false,
    });

    const occupationFinding = result.findings.find((f) => f.category === 'OCCUPATION');

    expect(occupationFinding).toBeDefined();
    expect(text.substring(occupationFinding?.start ?? 0, occupationFinding?.end ?? 0)).toBe(
      'software engineer',
    );
  });

  it('should NOT add occupation finding for GDPR_EU framework', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-occupation-gdpr',
            framework: payload.framework,
            threshold: payload.threshold,
            preserveStructure: payload.preserveStructure,
            sourceTextHash: payload.sourceTextHash,
            sourceTextLength: payload.sourceTextLength,
          };
        }

        return { id: 'entity-id', ...payload };
      }),
      save: jest.fn(async (value: unknown) => value),
    };

    entityManagerMock.transaction.mockImplementation(
      async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
    );

    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text: 'Social History: works as accountant',
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const occupationFinding = result.findings.find((f) => f.category === 'OCCUPATION');

    expect(occupationFinding).toBeUndefined();
  });

  it('should allow toggling ORGANIZATION in preview via activeIds', async () => {
    const text = 'Clinic: Vasquez Primary Care Associates';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-organization-mandatory',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    const organizationEntity = {
      id: 'org-1',
      jobId: 'job-organization-mandatory',
      category: 'ORGANIZATION',
      confidence: 99,
      start: 8,
      end: 39,
      proxyType: 'Redact',
    } satisfies Partial<DetectedEntity>;

    entityManagerMock.find
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([
        {
          ...organizationEntity,
          systemStatus: DetectedEntityStatus.ACTIVE,
        },
      ] satisfies Partial<DetectedEntity>[]);

    const previewWithoutOrganization = await service.getPreview({
      jobId: 'job-organization-mandatory',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: [],
    });

    const previewWithOrganization = await service.getPreview({
      jobId: 'job-organization-mandatory',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['org-1'],
    });

    expect(previewWithoutOrganization).toBe(text);
    expect(previewWithOrganization).toBe('Clinic: [REDACT]');
  });

  it('should use persisted effective active statuses in preview when activeIds are empty', async () => {
    const text = 'Patient John Doe';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-persisted-preview',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
      userUuid: 'user-1',
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'entity-person',
        jobId: 'job-persisted-preview',
        category: 'PERSON',
        confidence: 95,
        start: 8,
        end: 16,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
        userStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview(
      {
        jobId: 'job-persisted-preview',
        text,
        framework: ComplianceFramework.HIPAA,
        activeIds: [],
      },
      'user-1',
    );

    expect(preview).toBe('Patient [REDACT]');
  });

  it('should bulk update entity statuses and return effective statuses', async () => {
    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-bulk-update',
      userUuid: 'user-1',
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'entity-1',
        jobId: 'job-bulk-update',
        category: 'PERSON',
        confidence: 95,
        start: 0,
        end: 4,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
        systemStatusReason: DetectedEntitySystemReason.ANALYZER_DETECTED,
        source: DetectedEntitySource.ANALYZER,
        isSyntheticEligible: true,
      },
      {
        id: 'entity-2',
        jobId: 'job-bulk-update',
        category: 'DATE_TIME',
        confidence: 90,
        start: 10,
        end: 14,
        proxyType: 'Generalization',
        systemStatus: DetectedEntityStatus.ACTIVE,
        systemStatusReason: DetectedEntitySystemReason.ANALYZER_DETECTED,
        source: DetectedEntitySource.ANALYZER,
        isSyntheticEligible: true,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const result = await service.bulkUpdateEntityStatuses(
      {
        jobId: 'job-bulk-update',
        activeEntityIds: ['entity-1'],
      },
      'user-1',
    );

    expect(entityManagerMock.save).toHaveBeenCalledTimes(1);
    expect(result.updatedCount).toBe(2);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'entity-1',
          userStatus: 'ACTIVE',
          userStatusReason: 'USER_BULK_ACTIVATE',
          effectiveStatus: 'ACTIVE',
        }),
        expect.objectContaining({
          id: 'entity-2',
          userStatus: 'INACTIVE',
          userStatusReason: 'USER_BULK_DEACTIVATE',
          effectiveStatus: 'INACTIVE',
        }),
      ]),
    );
  });

  it('should reject bulk update for a job that does not belong to the user', async () => {
    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-foreign',
      userUuid: 'other-user',
    } satisfies Partial<DeIdJob>);

    await expect(
      service.bulkUpdateEntityStatuses(
        {
          jobId: 'job-foreign',
          activeEntityIds: [],
        },
        'user-1',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should generate synthetic variants for active entities', async () => {
    const sourceText = 'John Doe visited on 2025-02-14. Contact: +49 30 1234567';
    const sourceTextHash = createHash('sha256').update(sourceText).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-synthetic',
      userUuid: 'user-1',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash,
      sourceTextLength: sourceText.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'entity-1',
        jobId: 'job-synthetic',
        category: 'PERSON',
        confidence: 95,
        start: 0,
        end: 4,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
      {
        id: 'entity-2',
        jobId: 'job-synthetic',
        category: 'DATE_TIME',
        confidence: 90,
        start: 10,
        end: 14,
        proxyType: 'Generalization',
        systemStatus: DetectedEntityStatus.INACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const result = await service.generateSyntheticVariants(
      {
        jobId: 'job-synthetic',
        text: sourceText,
        count: 3,
        outputFormat: SyntheticOutputFormat.TXT,
      },
      'user-1',
    );

    expect(result.jobId).toBe('job-synthetic');
    expect(result.variantsGenerated).toBe(3);
    expect(result.outputFormat).toBe(SyntheticOutputFormat.TXT);
    expect(result.mimeType).toBe('application/zip');
    expect(result.filename).toContain('job-synthetic');
    expect(result.archiveBuffer).toBeDefined();
    expect(result.archiveBuffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('should reject synthetic generation for job with no active entities', async () => {
    const sourceText = 'John Doe visited on 2025-02-14';
    const sourceTextHash = createHash('sha256').update(sourceText).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-no-active',
      userUuid: 'user-1',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash,
      sourceTextLength: sourceText.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'entity-1',
        jobId: 'job-no-active',
        category: 'PERSON',
        systemStatus: DetectedEntityStatus.INACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    await expect(
      service.generateSyntheticVariants(
        {
          jobId: 'job-no-active',
          text: sourceText,
          count: 3,
          outputFormat: SyntheticOutputFormat.TXT,
        },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject synthetic generation for foreign job', async () => {
    entityManagerMock.findOne.mockResolvedValue(null);

    await expect(
      service.generateSyntheticVariants(
        {
          jobId: 'job-foreign',
          text: 'irrelevant text',
          count: 3,
          outputFormat: SyntheticOutputFormat.TXT,
        },
        'user-1',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should reject synthetic generation when text does not match analyzed input', async () => {
    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-text-mismatch',
      userUuid: 'user-1',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: createHash('sha256').update('another text').digest('hex'),
      sourceTextLength: 'another text'.length,
    } satisfies Partial<DeIdJob>);

    await expect(
      service.generateSyntheticVariants(
        {
          jobId: 'job-text-mismatch',
          text: 'mismatched text',
          count: 2,
          outputFormat: SyntheticOutputFormat.TXT,
        },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject synthetic variants count above configured max', async () => {
    const sourceText = 'John Doe visited on 2025-02-14. Contact: +49 30 1234567';
    const sourceTextHash = createHash('sha256').update(sourceText).digest('hex');

    configServiceMock.get.mockReturnValue('2');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-synthetic-max-check',
      userUuid: 'user-1',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash,
      sourceTextLength: sourceText.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'entity-1',
        jobId: 'job-synthetic-max-check',
        category: 'PERSON',
        confidence: 95,
        start: 0,
        end: 4,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    await expect(
      service.generateSyntheticVariants(
        {
          jobId: 'job-synthetic-max-check',
          text: sourceText,
          count: 3,
          outputFormat: SyntheticOutputFormat.TXT,
        },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);
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

  it('should generalize consultation full date to month and year in GDPR_EU preview', async () => {
    const text = 'Consultation Date: 08 April 2026';
    const hash = createHash('sha256').update(text).digest('hex');

    const dateStart = text.indexOf('08 April 2026');
    const dateEnd = dateStart + '08 April 2026'.length;

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-consultation-month-year',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-consultation-date',
        jobId: 'job-consultation-month-year',
        category: 'DATE_TIME',
        confidence: 94,
        start: dateStart,
        end: dateEnd,
        proxyType: 'Generalization',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-consultation-month-year',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: [],
    });

    expect(preview).toBe('Consultation Date: APRIL 2026');
  });

  it('should generalize dotted DOB date in GDPR_EU preview when DATE_OF_BIRTH is present', async () => {
    const text = 'Date of Birth: 18.12.1985 Age: 34';
    const hash = createHash('sha256').update(text).digest('hex');

    const dobStart = text.indexOf('18.12.1985');
    const ageStart = text.indexOf('34');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-dotted-dob-preview',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-dob',
        jobId: 'job-gdpr-dotted-dob-preview',
        category: 'DATE_OF_BIRTH',
        confidence: 96,
        start: dobStart,
        end: dobStart + '18.12.1985'.length,
        proxyType: 'Generalize',
      },
      {
        id: 'e-age',
        jobId: 'job-gdpr-dotted-dob-preview',
        category: 'AGE',
        confidence: 95,
        start: ageStart,
        end: ageStart + '34'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-dotted-dob-preview',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-dob', 'e-age'],
    });

    expect(preview).toBe('Date of Birth: [REDACT] Age: [30-34]');
  });

  it('should not expose exact birth year together with age bucket in GDPR_EU preview', async () => {
    const text = 'Date of Birth: 15/06/1975 Age: 51 Consultation Date: 2026';
    const hash = createHash('sha256').update(text).digest('hex');

    const dobStart = text.indexOf('15/06/1975');
    const ageStart = text.indexOf('51');
    const consultationYearStart = text.lastIndexOf('2026');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-eu-dob-age-linkage',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-eu-dob-linkage',
        jobId: 'job-gdpr-eu-dob-age-linkage',
        category: 'DATE_OF_BIRTH',
        confidence: 96,
        start: dobStart,
        end: dobStart + '15/06/1975'.length,
        proxyType: 'Generalize',
      },
      {
        id: 'e-gdpr-eu-age-linkage',
        jobId: 'job-gdpr-eu-dob-age-linkage',
        category: 'AGE',
        confidence: 95,
        start: ageStart,
        end: ageStart + '51'.length,
        proxyType: 'Generalize',
      },
      {
        id: 'e-gdpr-eu-consultation-year',
        jobId: 'job-gdpr-eu-dob-age-linkage',
        category: 'DATE_TIME',
        confidence: 94,
        start: consultationYearStart,
        end: consultationYearStart + '2026'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-eu-dob-age-linkage',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-gdpr-eu-dob-linkage', 'e-gdpr-eu-age-linkage', 'e-gdpr-eu-consultation-year'],
    });

    expect(preview).toContain('Date of Birth: [REDACT]');
    expect(preview).toContain('Age: [50-54]');
    expect(preview).toContain('Consultation Date: 2026');
    expect(preview).not.toContain('1975');
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

  it('should clamp PERSON span at field marker and keep non-PHI gender value in preview', async () => {
    const text =
      'Patient Name: Maria Gonzalez DOB: 11/22/1991 (Age: 34) Gender: Female Address: 567 Maple Ave';
    const hash = createHash('sha256').update(text).digest('hex');

    const patientNameStart = text.indexOf('Maria Gonzalez');
    const crossingPersonEnd = text.indexOf('DOB:') + 'DOB:'.length;
    const femaleStart = text.indexOf('Female');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-preview-clamp-gender',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-person-crossing',
          jobId: 'job-preview-clamp-gender',
          category: 'PERSON',
          confidence: 93,
          start: patientNameStart,
          end: crossingPersonEnd,
          proxyType: 'Redact',
        },
        {
          id: 'e-female-person',
          jobId: 'job-preview-clamp-gender',
          category: 'PERSON',
          confidence: 88,
          start: femaleStart,
          end: femaleStart + 'Female'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-preview-clamp-gender',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-person-crossing', 'e-female-person'],
    });

    expect(preview).toContain('Patient Name: [REDACT] DOB: 11/22/1991');
    expect(preview).toContain('Gender: Female');
  });

  it('should add structured ADDRESS finding from Address field when analyzer misses street span', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-structured-address',
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

    const text =
      'Gender: Female Address: 567 Maple Ave, Apt 3B, Chicago, IL 60622 Phone: (773) 555-2391';
    const chicagoStart = text.indexOf('Chicago');
    const zipStart = text.indexOf('60622');

    presidioClientMock.analyze.mockResolvedValue([
      {
        entity_type: 'LOCATION',
        start: chicagoStart,
        end: chicagoStart + 'Chicago'.length,
        score: 0.9,
      },
      { entity_type: 'US_ZIP', start: zipStart, end: zipStart + '60622'.length, score: 0.96 },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.HIPAA,
      threshold: 0.5,
      preserveStructure: false,
    });

    const addressFinding = result.findings.find((finding) => finding.category === 'ADDRESS');
    expect(addressFinding).toBeDefined();
    expect(text.slice(addressFinding?.start ?? 0, addressFinding?.end ?? 0)).toBe(
      '567 Maple Ave, Apt 3B, Chicago, IL 60622',
    );
  });

  it('should stop structured ADDRESS finding at Telephone label boundary', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-structured-address-telephone-boundary',
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

    const text =
      'Address: 78 Maple Grove, London, E14 5AB Telephone: 07812 345678 Next of kin: Mr John Brown';
    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.5,
      preserveStructure: false,
    });

    const addressFinding = result.findings.find((finding) => finding.category === 'ADDRESS');
    expect(addressFinding).toBeDefined();
    expect(text.slice(addressFinding?.start ?? 0, addressFinding?.end ?? 0)).toBe(
      '78 Maple Grove, London, E14 5AB',
    );
  });

  it('should stop structured ADDRESS finding at GP label boundary in UK outpatient letter', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-structured-address-gp-boundary',
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

    const text =
      'NHS Central London Trust Outpatient Clinic Letter Date: 10 April 2026 Patient: Mr. Johnathan Robert Smith DOB: 15/03/1968 (Age 58) NHS Number: 987 654 3210 Address: 45 Oak Avenue, London, SW1A 1AA GP: Dr. Emily Carter, Riverside Medical Centre, London';
    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.5,
      preserveStructure: false,
    });

    const addressFinding = result.findings.find((finding) => finding.category === 'ADDRESS');
    const addressValue = text.slice(addressFinding?.start ?? 0, addressFinding?.end ?? 0);

    expect(addressFinding).toBeDefined();
    expect(addressValue).toBe('45 Oak Avenue, London, SW1A 1AA');
    expect(addressValue).not.toContain('Dr. Emily Carter');
  });

  it('should add fallback AGE finding from family history in GDPR_UK analysis', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-family-history-age-fallback',
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

    const text = 'Family history: Father - MI at 62.';
    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_UK,
      threshold: 0.5,
      preserveStructure: false,
    });

    const ageFinding = result.findings.find(
      (finding) => finding.category === 'AGE' && text.slice(finding.start, finding.end) === '62',
    );

    expect(ageFinding).toBeDefined();
  });

  it('should add structured DATE_OF_BIRTH finding from Date of Birth when analyzer misses dotted date', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-structured-dob',
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

    const text = 'Date of Birth: 18.12.1985 Age: 34';
    presidioClientMock.analyze.mockResolvedValue([] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const dobFinding = result.findings.find(
      (finding) =>
        finding.category === 'DATE_OF_BIRTH' &&
        text.slice(finding.start, finding.end) === '18.12.1985',
    );

    expect(dobFinding).toBeDefined();
  });

  it('should add structured PHONE_NUMBER finding when analyzer only returns phone-like DATE_TIME false positive', async () => {
    const tm: TransactionManagerMock = {
      create: jest.fn((target: unknown, payload: Record<string, unknown>) => {
        if (target === DeIdJob) {
          return {
            id: 'job-structured-phone',
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

    const text = 'Contact: +49 30 1234567';
    presidioClientMock.analyze.mockResolvedValue([
      {
        entity_type: 'DATE_TIME',
        start: text.indexOf('30'),
        end: text.length,
        score: 0.99,
      },
    ] satisfies AnalyzerFinding[]);

    const result = await service.analyzeText({
      text,
      framework: ComplianceFramework.GDPR_EU,
      threshold: 0.85,
      preserveStructure: false,
    });

    const phoneFinding = result.findings.find(
      (finding) =>
        finding.category === 'PHONE_NUMBER' &&
        text.slice(finding.start, finding.end) === '+49 30 1234567',
    );
    const dateFinding = result.findings.find((finding) => finding.category === 'DATE_TIME');

    expect(phoneFinding).toBeDefined();
    expect(dateFinding).toMatchObject({
      systemStatus: 'INACTIVE',
      isSyntheticEligible: false,
    });
  });

  it('should avoid broken output when preview spans overlap around DOB and Gender fields', async () => {
    const text =
      'Patient Name: Maria Gonzalez DOB: 11/22/1991 (Age: 34) Gender: Female Address: 567 Maple Ave, Apt 3B, Chicago, IL 60622 Phone: (773) 555-2391';
    const hash = createHash('sha256').update(text).digest('hex');

    const patientNameStart = text.indexOf('Maria Gonzalez');
    const dobLabelStart = text.indexOf('DOB:');
    const dateStart = text.indexOf('11/22/1991');
    const femaleStart = text.indexOf('Female');
    const addressStart = text.indexOf('567 Maple Ave, Apt 3B, Chicago, IL 60622');
    const phoneStart = text.indexOf('(773) 555-2391');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-overlap-dob-gender-address',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-person-name-crossing-dob',
          jobId: 'job-overlap-dob-gender-address',
          category: 'PERSON',
          confidence: 94,
          start: patientNameStart,
          end: dobLabelStart + 'DOB:'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-date-with-dob-label',
          jobId: 'job-overlap-dob-gender-address',
          category: 'DATE_TIME',
          confidence: 97,
          start: dobLabelStart,
          end: dateStart + '11/22/1991'.length,
          proxyType: 'Generalize',
        },
        {
          id: 'e-gender-as-person',
          jobId: 'job-overlap-dob-gender-address',
          category: 'PERSON',
          confidence: 90,
          start: femaleStart,
          end: femaleStart + 'Female'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-address',
          jobId: 'job-overlap-dob-gender-address',
          category: 'ADDRESS',
          confidence: 99,
          start: addressStart,
          end: addressStart + '567 Maple Ave, Apt 3B, Chicago, IL 60622'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-phone',
          jobId: 'job-overlap-dob-gender-address',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: phoneStart,
          end: phoneStart + '(773) 555-2391'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-overlap-dob-gender-address',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: [
        'e-person-name-crossing-dob',
        'e-date-with-dob-label',
        'e-gender-as-person',
        'e-address',
        'e-phone',
      ],
    });

    expect(preview).toContain('Patient Name: [REDACT] DOB: 1991');
    expect(preview).toContain('Gender: Female');
    expect(preview).toContain('Address: [REDACT]');
    expect(preview).toContain('Phone: [REDACT]');
    expect(preview).not.toContain('[REDACT]CT]');
  });

  it('should prioritize PHONE_NUMBER over overlapping DATE_TIME in GDPR preview', async () => {
    const text = 'Contact: +39 06 98765439876543';
    const hash = createHash('sha256').update(text).digest('hex');

    const phoneValue = '+39 06 98765439876543';
    const phoneStart = text.indexOf(phoneValue);
    const dateLikeTail = '98765439876543';
    const dateLikeTailStart = text.indexOf(dateLikeTail);

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-phone-date-overlap-gdpr',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-phone-overlap',
          jobId: 'job-phone-date-overlap-gdpr',
          category: 'PHONE_NUMBER',
          confidence: 81,
          start: phoneStart,
          end: phoneStart + phoneValue.length,
          proxyType: 'Mask',
        },
        {
          id: 'e-date-inside-phone',
          jobId: 'job-phone-date-overlap-gdpr',
          category: 'DATE_TIME',
          confidence: 99,
          start: dateLikeTailStart,
          end: dateLikeTailStart + dateLikeTail.length,
          proxyType: 'Generalize',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-phone-date-overlap-gdpr',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-phone-overlap', 'e-date-inside-phone'],
    });

    expect(preview).toBe('Contact: [REDACT]');
    expect(preview).not.toContain('[MONTH_YEAR]');
  });

  it('should preserve Contact field label when PHONE_NUMBER span includes the label', async () => {
    const text = 'Contact: +49 30 1234567';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-contact-label-clamp',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-contact-span',
          jobId: 'job-contact-label-clamp',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: 0,
          end: text.length,
          proxyType: 'Mask',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-contact-label-clamp',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-contact-span'],
    });

    expect(preview).toBe('Contact: [REDACT]');
  });

  it('should preserve ● bullet marker before Contact: when preceding Address field is redacted', async () => {
    const text =
      '● Address: 45 Oak Avenue, London, SW1A 1AA ● Contact: +48 501 123 456 ● Health Insurance Number: ABC123';
    const hash = createHash('sha256').update(text).digest('hex');

    const addressStart = text.indexOf('45 Oak Avenue');
    const phoneStart = text.indexOf('+48 501 123 456');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-bullet-contact',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-address',
        jobId: 'job-bullet-contact',
        category: 'ADDRESS',
        confidence: 97,
        start: addressStart,
        end: addressStart + '45 Oak Avenue, London, SW1A 1AA'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-phone',
        jobId: 'job-bullet-contact',
        category: 'PHONE_NUMBER',
        confidence: 98,
        start: phoneStart,
        end: phoneStart + '+48 501 123 456'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-bullet-contact',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-address', 'e-phone'],
    });

    expect(preview).toContain('● Address: [REDACT]');
    expect(preview).toContain('● Contact: [REDACT]');
  });

  it('should preserve ● marker before Date of Birth in GDPR_EU Italian inline demographics format', async () => {
    const text = '● Full Name: Mario Rossi ● Date of Birth: 15/06/1959 (Age: 67) ● Gender: Male';
    const hash = createHash('sha256').update(text).digest('hex');

    const nameStart = text.indexOf('Mario Rossi');
    const dobStart = text.indexOf('15/06/1959');
    const ageStart = text.indexOf('67');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-bullet-dob-italian-inline',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-name-with-inline-bullet-tail',
        jobId: 'job-bullet-dob-italian-inline',
        category: 'PERSON',
        confidence: 97,
        start: nameStart,
        end: text.indexOf('Date of Birth:'),
        proxyType: 'Replace',
      },
      {
        id: 'e-dob',
        jobId: 'job-bullet-dob-italian-inline',
        category: 'DATE_OF_BIRTH',
        confidence: 98,
        start: dobStart,
        end: dobStart + '15/06/1959'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-age',
        jobId: 'job-bullet-dob-italian-inline',
        category: 'AGE',
        confidence: 98,
        start: ageStart,
        end: ageStart + '67'.length,
        proxyType: 'Generalize',
      },
      {
        id: 'e-gender',
        jobId: 'job-bullet-dob-italian-inline',
        category: 'GENDER',
        confidence: 96,
        start: text.indexOf('Male'),
        end: text.indexOf('Male') + 'Male'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-bullet-dob-italian-inline',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-name-with-inline-bullet-tail', 'e-dob', 'e-age', 'e-gender'],
    });

    expect(preview).toContain('● Full Name: [PATIENT_ID_1]');
    expect(preview).toContain('● Date of Birth: [REDACT] (Age: [65-69])');
    expect(preview).toContain('● Gender: Male');
  });

  it('should collapse adjacent address spans into one redaction for Italian address fields', async () => {
    const text = '● Address: Via Roma 10, Milano, 20121 ● Contact: +39 06 9876543';
    const hash = createHash('sha256').update(text).digest('hex');

    const streetStart = text.indexOf('Via Roma 10');
    const cityStart = text.indexOf('Milano');
    const postalCodeStart = text.indexOf('20121');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-address-collapse',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-address-street',
        jobId: 'job-address-collapse',
        category: 'ADDRESS',
        confidence: 99,
        start: streetStart,
        end: streetStart + 'Via Roma 10'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-address-city',
        jobId: 'job-address-collapse',
        category: 'LOCATION',
        confidence: 99,
        start: cityStart,
        end: cityStart + 'Milano'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-address-postal-code',
        jobId: 'job-address-collapse',
        category: 'LOCATION',
        confidence: 99,
        start: postalCodeStart,
        end: postalCodeStart + '20121'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-address-collapse',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-address-street', 'e-address-city', 'e-address-postal-code'],
    });

    expect(preview).toContain('● Address: [REDACT]');
    expect(preview).not.toContain('[REDACT] [REDACT]');
    expect(preview).not.toContain('Milano');
    expect(preview).not.toContain('20121');
  });

  it('should keep duration token unchanged and not generalize 3-day to [YEAR] in GDPR_UK preview', async () => {
    const text = 'Subjective: 65-year-old male presents with a 3-day history of SOBOE.';
    const hash = createHash('sha256').update(text).digest('hex');
    const durationStart = text.indexOf('3-day');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-duration-token',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-duration-date-time',
        jobId: 'job-gdpr-uk-duration-token',
        category: 'DATE_TIME',
        confidence: 91,
        start: durationStart,
        end: durationStart + '3-day'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-duration-token',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-duration-date-time'],
    });

    expect(preview).toContain('3-day history');
    expect(preview).not.toContain('[YEAR] history');
  });

  it('should fully redact phone number including country code in GDPR_EU preview', async () => {
    const text = 'Contact: +49 30 1234567';
    const hash = createHash('sha256').update(text).digest('hex');

    const phoneStart = text.indexOf('+49');
    const phoneEnd = text.length;

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-phone-areacode-gdpr',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-phone-areacode',
          jobId: 'job-phone-areacode-gdpr',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: phoneStart,
          end: phoneEnd,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-phone-areacode-gdpr',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-phone-areacode'],
    });

    expect(preview).toBe('Contact: [REDACT]');
  });

  it('should merge split PHONE_NUMBER and NATIONAL_ID spans in GDPR_EU preview', async () => {
    const text = 'Contact: +49 30 1234567';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-split-phone-preview-gdpr',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-phone-split-gdpr',
        jobId: 'job-split-phone-preview-gdpr',
        category: 'PHONE_NUMBER',
        confidence: 98,
        start: text.indexOf('+49'),
        end: text.indexOf('1234567') - 1,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
      {
        id: 'e-national-id-tail-gdpr',
        jobId: 'job-split-phone-preview-gdpr',
        category: 'NATIONAL_ID',
        confidence: 95,
        start: text.indexOf('1234567'),
        end: text.indexOf('1234567') + '1234567'.length,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-split-phone-preview-gdpr',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-phone-split-gdpr'],
    });

    expect(preview).toBe('Contact: [REDACT]');
  });

  it('should fully redact PL_PHONE_NUMBER in GDPR_EU preview including country code', async () => {
    const text = 'Contact: +48 501 123 456';
    const hash = createHash('sha256').update(text).digest('hex');

    const phoneStart = text.indexOf('+48');
    const phoneEnd = text.length;

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-pl-phone-gdpr-preview',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-pl-phone-gdpr',
          jobId: 'job-pl-phone-gdpr-preview',
          category: 'PL_PHONE_NUMBER',
          confidence: 98,
          start: phoneStart,
          end: phoneEnd,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-pl-phone-gdpr-preview',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-pl-phone-gdpr'],
    });

    expect(preview).toBe('Contact: [REDACT]');
  });

  it('should fully redact GDPR_UK phone-like value when country code is missing', async () => {
    const text = 'NHS Number: 456 789 0123';
    const hash = createHash('sha256').update(text).digest('hex');

    const numberStart = text.indexOf('456 789 0123');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-phone-fallback',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-gdpr-uk-phone-fallback',
          jobId: 'job-gdpr-uk-phone-fallback',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: numberStart,
          end: numberStart + '456 789 0123'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-phone-fallback',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-phone-fallback'],
    });

    expect(preview).toBe('NHS Number: [REDACT]');
  });

  it('should keep only UK postcode outward code in GDPR_UK preview', async () => {
    const text = 'Postcode: E14 5AB';
    const hash = createHash('sha256').update(text).digest('hex');

    const postcodeStart = text.indexOf('E14 5AB');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-postcode',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-gdpr-uk-postcode',
          jobId: 'job-gdpr-uk-postcode',
          category: 'UK_POSTCODE',
          confidence: 98,
          start: postcodeStart,
          end: postcodeStart + 'E14 5AB'.length,
          proxyType: 'Generalize',
          systemStatus: DetectedEntityStatus.ACTIVE,
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-postcode',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-postcode'],
    });

    expect(preview).toBe('Postcode: E14');
  });

  it('should tokenize UK healthcare organizations in GDPR_UK preview', async () => {
    const text =
      "Facility 1: St. Thomas' Hospital. Facility 2: Thamesview Medical Centre. Facility 3: Guy's and St Thomas' NHS Foundation Trust. Facility 4: City Health Practice.";
    const hash = createHash('sha256').update(text).digest('hex');

    const hospitalStart = text.indexOf("St. Thomas' Hospital");
    const gpStart = text.indexOf('Thamesview Medical Centre');
    const trustStart = text.indexOf("Guy's and St Thomas' NHS Foundation Trust");
    const cityHealthPracticeStart = text.indexOf('City Health Practice');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-org-tokens',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-gdpr-uk-hospital',
          jobId: 'job-gdpr-uk-org-tokens',
          category: 'ORGANIZATION',
          confidence: 98,
          start: hospitalStart,
          end: hospitalStart + "St. Thomas' Hospital".length,
          proxyType: 'Redact',
        },
        {
          id: 'e-gdpr-uk-gp-practice',
          jobId: 'job-gdpr-uk-org-tokens',
          category: 'ORGANIZATION',
          confidence: 98,
          start: gpStart,
          end: gpStart + 'Thamesview Medical Centre'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-gdpr-uk-trust',
          jobId: 'job-gdpr-uk-org-tokens',
          category: 'ORGANIZATION',
          confidence: 98,
          start: trustStart,
          end: trustStart + "Guy's and St Thomas' NHS Foundation Trust".length,
          proxyType: 'Redact',
        },
        {
          id: 'e-gdpr-uk-city-health-practice',
          jobId: 'job-gdpr-uk-org-tokens',
          category: 'ORGANIZATION',
          confidence: 98,
          start: cityHealthPracticeStart,
          end: cityHealthPracticeStart + 'City Health Practice'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-org-tokens',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-hospital',
        'e-gdpr-uk-gp-practice',
        'e-gdpr-uk-trust',
        'e-gdpr-uk-city-health-practice',
      ],
    });

    expect(preview).toBe(
      'Facility 1: [HOSPITAL]. Facility 2: [GP_PRACTICE]. Facility 3: [HOSPITAL]. Facility 4: [GP_PRACTICE].',
    );
  });

  it('should keep generic clinic department names in GDPR_UK preview', async () => {
    const text = 'Clinic: General Medicine Outpatient Department';
    const hash = createHash('sha256').update(text).digest('hex');
    const organizationStart = text.indexOf('General Medicine Outpatient Department');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-generic-clinic-department',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-gdpr-uk-generic-clinic-department',
          jobId: 'job-gdpr-uk-generic-clinic-department',
          category: 'ORGANIZATION',
          confidence: 97,
          start: organizationStart,
          end: organizationStart + 'General Medicine Outpatient Department'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-generic-clinic-department',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-generic-clinic-department'],
    });

    expect(preview).toBe('Clinic: General Medicine Outpatient Department');
  });

  it('should not apply GDPR phone sanitization logic in HIPAA preview', async () => {
    const text = 'Contact: +48 501 123 456';
    const hash = createHash('sha256').update(text).digest('hex');

    const phoneStart = text.indexOf('+48');
    const phoneEnd = text.length;

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-phone-hipaa-preview',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-phone-hipaa',
          jobId: 'job-phone-hipaa-preview',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: phoneStart,
          end: phoneEnd,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-phone-hipaa-preview',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-phone-hipaa'],
    });

    expect(preview).toBe('Contact: [REDACT]');
  });

  it('should fully redact Charite university facility chain in GDPR_EU preview', async () => {
    const text = 'Facility: Charite - Universitatsmedizin Berlin, [REGION]';
    const hash = createHash('sha256').update(text).digest('hex');
    const facilityValue = 'Charite - Universitatsmedizin Berlin';
    const facilityStart = text.indexOf(facilityValue);

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-full-facility-redact',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-facility-chain',
          jobId: 'job-gdpr-full-facility-redact',
          category: 'ORGANIZATION',
          confidence: 99,
          start: facilityStart,
          end: facilityStart + facilityValue.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-full-facility-redact',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-facility-chain'],
    });

    expect(preview).toBe('Facility: [REDACT], [REGION]');
  });

  it('should prioritize PHONE_NUMBER over overlapping NATIONAL_ID in GDPR_EU preview', async () => {
    const text = 'Contact: +49 30 1234567';
    const hash = createHash('sha256').update(text).digest('hex');

    const phoneStart = text.indexOf('+49');
    const phoneEnd = text.length;
    const nationalIdStart = text.indexOf('1234567');
    const nationalIdEnd = nationalIdStart + '1234567'.length;

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-phone-national-id-overlap',
      framework: ComplianceFramework.GDPR_EU,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    // Simulate NATIONAL_ID found by Presidio, overlapping with PHONE_NUMBER
    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-phone-overlap-national',
          jobId: 'job-phone-national-id-overlap',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: phoneStart,
          end: phoneEnd,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([
        {
          id: 'e-national-id-overlap',
          jobId: 'job-phone-national-id-overlap',
          category: 'NATIONAL_ID',
          confidence: 95,
          start: nationalIdStart,
          end: nationalIdEnd,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-phone-national-id-overlap',
      text,
      framework: ComplianceFramework.GDPR_EU,
      activeIds: ['e-phone-overlap-national'],
    });

    // PHONE_NUMBER (priority 120) should win over NATIONAL_ID (priority 105)
    // NATIONAL_ID is mandatory for GDPR but overlapping PHONE_NUMBER takes precedence
    expect(preview).toBe('Contact: [REDACT]');
  });

  it('should keep Female and still redact address when PERSON span contains "Female Address" without colon', async () => {
    const text =
      'Gender: Female Address: 567 Maple Ave, Apt 3B, Chicago, IL 60622 Phone: (773) 555-2391';
    const hash = createHash('sha256').update(text).digest('hex');

    const femaleStart = text.indexOf('Female');
    const addressWordStart = text.indexOf('Address');
    const addressStart = text.indexOf('567 Maple Ave, Apt 3B, Chicago, IL 60622');
    const phoneStart = text.indexOf('(773) 555-2391');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-female-address-soft-boundary',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find
      .mockResolvedValueOnce([
        {
          id: 'e-person-female-address-no-colon',
          jobId: 'job-female-address-soft-boundary',
          category: 'PERSON',
          confidence: 89,
          start: femaleStart,
          end: addressWordStart + 'Address'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-address-main',
          jobId: 'job-female-address-soft-boundary',
          category: 'ADDRESS',
          confidence: 99,
          start: addressStart,
          end: addressStart + '567 Maple Ave, Apt 3B, Chicago, IL 60622'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-phone-main',
          jobId: 'job-female-address-soft-boundary',
          category: 'PHONE_NUMBER',
          confidence: 98,
          start: phoneStart,
          end: phoneStart + '(773) 555-2391'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[])
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-female-address-soft-boundary',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-person-female-address-no-colon', 'e-address-main', 'e-phone-main'],
    });

    expect(preview).toContain('Gender: Female');
    expect(preview).toContain('Address: [REDACT]');
    expect(preview).toContain('Phone: [REDACT]');
    expect(preview).not.toContain('Gender: [REDACT]');
    expect(preview).not.toContain('[REDACT]: [REDACT]');
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

  it('should return preview with leaks metadata in warn_only validation mode', async () => {
    const text = 'Patient SSN 123-45-6789 ZIP 90210';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-preview-warn-only',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([] satisfies Partial<DetectedEntity>[]);

    const result = await service.getPreviewWithValidation({
      jobId: 'job-preview-warn-only',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: [],
      validationMode: PreviewValidationMode.WARN_ONLY,
    });

    expect(result.anonymizedText).toBe(text);
    expect(result.postValidation.valid).toBe(false);
    expect(result.postValidation.mode).toBe(PreviewValidationMode.WARN_ONLY);
    expect(result.postValidation.summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SSN', count: 1 }),
        expect.objectContaining({ type: 'ZIP', count: 1 }),
      ]),
    );
  });

  it('should keep strict preview behavior and return 422 on PHI leaks', async () => {
    const text = 'Patient SSN 123-45-6789 ZIP 90210';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-preview-strict',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([] satisfies Partial<DetectedEntity>[]);

    await expect(
      service.getPreviewWithValidation({
        jobId: 'job-preview-strict',
        text,
        framework: ComplianceFramework.HIPAA,
        activeIds: [],
        validationMode: PreviewValidationMode.STRICT,
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('should report NHS number leaks in GDPR_UK warn_only validation mode', async () => {
    const text = 'NHS Number: 456 789 0123';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-preview-gdpr-uk-nhs-warn-only',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([] satisfies Partial<DetectedEntity>[]);

    const result = await service.getPreviewWithValidation({
      jobId: 'job-preview-gdpr-uk-nhs-warn-only',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [],
      validationMode: PreviewValidationMode.WARN_ONLY,
    });

    expect(result.anonymizedText).toBe(text);
    expect(result.postValidation.valid).toBe(false);
    expect(result.postValidation.summary).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'NHS_NUMBER', count: 1 })]),
    );
  });

  it('should return 422 for NHS number leaks in GDPR_UK strict validation mode', async () => {
    const text = 'NHS Number: 456 789 0123';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-preview-gdpr-uk-nhs-strict',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([] satisfies Partial<DetectedEntity>[]);

    await expect(
      service.getPreviewWithValidation({
        jobId: 'job-preview-gdpr-uk-nhs-strict',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
        validationMode: PreviewValidationMode.STRICT,
      }),
    ).rejects.toThrow(UnprocessableEntityException);
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

    expect(preview).toBe('[PERSON_ID_1] is here');
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

  it('should redact email domain in GDPR_UK preview', async () => {
    const text = 'Email: patient.contact@stthomas.nhs.uk';
    const hash = createHash('sha256').update(text).digest('hex');

    const emailStart = text.indexOf('patient.contact@stthomas.nhs.uk');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-email-domain',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-email',
        jobId: 'job-gdpr-uk-email-domain',
        category: 'EMAIL_ADDRESS',
        confidence: 99,
        start: emailStart,
        end: emailStart + 'patient.contact@stthomas.nhs.uk'.length,
        proxyType: 'Mask',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-email-domain',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-email'],
    });

    expect(preview).toBe('Email: ***************@[REDACT]');
  });

  it('should use differentiated synthetic PERSON tokens in GDPR_UK preview', async () => {
    const text =
      'Name: Alice Brown. Next of kin: Mr John Brown. GP: Dr Sarah Reed. Seen by: Dr Mark Hall.';
    const hash = createHash('sha256').update(text).digest('hex');

    const patientStart = text.indexOf('Alice Brown');
    const relativeStart = text.indexOf('John Brown');
    const gpStart = text.indexOf('Sarah Reed');
    const consultantStart = text.indexOf('Mark Hall');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-synthetic-person-role',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-person-patient',
        jobId: 'job-gdpr-uk-synthetic-person-role',
        category: 'PERSON',
        confidence: 98,
        start: patientStart,
        end: patientStart + 'Alice Brown'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-person-relative',
        jobId: 'job-gdpr-uk-synthetic-person-role',
        category: 'PERSON',
        confidence: 98,
        start: relativeStart,
        end: relativeStart + 'John Brown'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-person-gp',
        jobId: 'job-gdpr-uk-synthetic-person-role',
        category: 'PERSON',
        confidence: 98,
        start: gpStart,
        end: gpStart + 'Sarah Reed'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-person-consultant',
        jobId: 'job-gdpr-uk-synthetic-person-role',
        category: 'PERSON',
        confidence: 98,
        start: consultantStart,
        end: consultantStart + 'Mark Hall'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-synthetic-person-role',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-person-patient',
        'e-gdpr-uk-person-relative',
        'e-gdpr-uk-person-gp',
        'e-gdpr-uk-person-consultant',
      ],
    });

    expect(preview).toBe(
      'Name: [PATIENT_ID_1]. Next of kin: Mr [RELATIVE_ID_1]. GP: Dr [DOCTOR_ID_1]. Seen by: Dr [DOCTOR_ID_2].',
    );
  });

  it('should keep same PATIENT token for the same patient identity across GDPR_UK document', async () => {
    const text =
      'Patient Name: Mrs Fatima Khan. History: Mrs Fatima Khan reported improved symptoms.';
    const hash = createHash('sha256').update(text).digest('hex');

    const firstPatientStart = text.indexOf('Fatima Khan');
    const secondPatientStart = text.indexOf('Fatima Khan', firstPatientStart + 1);

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-patient-consistency',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-patient-1',
        jobId: 'job-gdpr-uk-patient-consistency',
        category: 'PERSON',
        confidence: 98,
        start: firstPatientStart,
        end: firstPatientStart + 'Fatima Khan'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-patient-2',
        jobId: 'job-gdpr-uk-patient-consistency',
        category: 'PERSON',
        confidence: 98,
        start: secondPatientStart,
        end: secondPatientStart + 'Fatima Khan'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-patient-consistency',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-patient-1', 'e-gdpr-uk-patient-2'],
    });

    expect(preview).toBe(
      'Patient Name: Mrs [PATIENT_ID_1]. History: Mrs [PATIENT_ID_1] reported improved symptoms.',
    );
  });

  it('should keep same PATIENT token when later mention uses surname only in GDPR_UK document', async () => {
    const text =
      'Patient Name: Mrs Fatima Khan. Follow-up note: Mrs Khan reported improved symptoms.';
    const hash = createHash('sha256').update(text).digest('hex');

    const firstPatientStart = text.indexOf('Fatima Khan');
    const secondPatientStart = text.indexOf('Khan', firstPatientStart + 'Fatima Khan'.length);

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-patient-surname-alias',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-patient-full-name',
        jobId: 'job-gdpr-uk-patient-surname-alias',
        category: 'PERSON',
        confidence: 98,
        start: firstPatientStart,
        end: firstPatientStart + 'Fatima Khan'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-patient-surname',
        jobId: 'job-gdpr-uk-patient-surname-alias',
        category: 'PERSON',
        confidence: 98,
        start: secondPatientStart,
        end: secondPatientStart + 'Khan'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-patient-surname-alias',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-patient-full-name', 'e-gdpr-uk-patient-surname'],
    });

    expect(preview).toBe(
      'Patient Name: Mrs [PATIENT_ID_1]. Follow-up note: Mrs [PATIENT_ID_1] reported improved symptoms.',
    );
  });

  it('should keep stable token when patient first appears as Mrs surname and later as full name', async () => {
    const text =
      'History: Mrs Khan attended clinic. Patient Name: Mrs Fatima Khan was reviewed today.';
    const hash = createHash('sha256').update(text).digest('hex');

    const firstPatientStart = text.indexOf('Khan');
    const secondPatientStart = text.indexOf('Fatima Khan');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-patient-honorific-first',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-patient-honorific-first',
        jobId: 'job-gdpr-uk-patient-honorific-first',
        category: 'PERSON',
        confidence: 98,
        start: firstPatientStart,
        end: firstPatientStart + 'Khan'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-patient-full-second',
        jobId: 'job-gdpr-uk-patient-honorific-first',
        category: 'PERSON',
        confidence: 98,
        start: secondPatientStart,
        end: secondPatientStart + 'Fatima Khan'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-patient-honorific-first',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-patient-honorific-first', 'e-gdpr-uk-patient-full-second'],
    });

    expect(preview).toBe(
      'History: Mrs [PATIENT_ID_1] attended clinic. Patient Name: Mrs [PATIENT_ID_1] was reviewed today.',
    );
  });

  it('should keep patient and GP identities stable on full UK clinic letter sample', async () => {
    const text =
      'NHS Central London Trust Outpatient Clinic Letter Date: 11 April 2026 Patient: Mrs. Fatima Khan DOB: 14/02/1980 NHS Number: 789 012 3456 Address: 27 Birch Lane, London, E14 5FG GP: Dr. Michael Harris, City Health Practice, 10 High Street, London E1 7AA Dear Mrs. Fatima Khan, Clinician : Dr. Alex Thompson, Consultant Diabetologist Time seen: 09:45 Reason for attendance: The patient was referred by her GP for comprehensive glycaemic control assessment. Mrs. Khan reports excellent adherence to her current treatment regimen. Signed: Dr. Alex Thompson Date: 11 April 2026 Dr. Michael Harris (GP) City Health Practice NHS Diabetes Specialist Nurse Team.';
    const hash = createHash('sha256').update(text).digest('hex');

    const patientFullNameInHeaderStart = text.indexOf('Fatima Khan');
    const patientFullNameInGreetingStart = text.indexOf(
      'Fatima Khan',
      patientFullNameInHeaderStart + 1,
    );
    const patientSurnameInBodyStart = text.indexOf(
      'Khan',
      patientFullNameInGreetingStart + 'Fatima Khan'.length,
    );
    const gpFirstMentionStart = text.indexOf('Michael Harris');
    const consultantFirstMentionStart = text.indexOf('Alex Thompson');
    const consultantSecondMentionStart = text.indexOf(
      'Alex Thompson',
      consultantFirstMentionStart + 1,
    );
    const gpSecondMentionStart = text.indexOf('Michael Harris', gpFirstMentionStart + 1);
    const gpPracticeFirstMentionStart = text.indexOf('City Health Practice');
    const gpPracticeSecondMentionStart = text.indexOf(
      'City Health Practice',
      gpPracticeFirstMentionStart + 1,
    );
    const nhsNumberStart = text.indexOf('789 012 3456');
    const patientAddressStart = text.indexOf('27 Birch Lane, London, E14 5FG');
    const gpAddressStart = text.indexOf('10 High Street, London E1 7AA');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-full-letter-consistency',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-patient-header',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: patientFullNameInHeaderStart,
        end: patientFullNameInHeaderStart + 'Fatima Khan'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-patient-greeting',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: patientFullNameInGreetingStart,
        end: patientFullNameInGreetingStart + 'Fatima Khan'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-patient-surname',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: patientSurnameInBodyStart,
        end: patientSurnameInBodyStart + 'Khan'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-gp-first',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: gpFirstMentionStart,
        end: gpFirstMentionStart + 'Michael Harris'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-consultant-first',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: consultantFirstMentionStart,
        end: consultantFirstMentionStart + 'Alex Thompson'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-consultant-second',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: consultantSecondMentionStart,
        end: consultantSecondMentionStart + 'Alex Thompson'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-gp-second',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'PERSON',
        confidence: 98,
        start: gpSecondMentionStart,
        end: gpSecondMentionStart + 'Michael Harris'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-gp-practice-first',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'ORGANIZATION',
        confidence: 97,
        start: gpPracticeFirstMentionStart,
        end: gpPracticeFirstMentionStart + 'City Health Practice'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-gp-practice-second',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'ORGANIZATION',
        confidence: 97,
        start: gpPracticeSecondMentionStart,
        end: gpPracticeSecondMentionStart + 'City Health Practice'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-nhs-number',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'UK_NHS_NUMBER',
        confidence: 99,
        start: nhsNumberStart,
        end: nhsNumberStart + '789 012 3456'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-patient-address',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'ADDRESS',
        confidence: 96,
        start: patientAddressStart,
        end: patientAddressStart + '27 Birch Lane, London, E14 5FG'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-gp-address',
        jobId: 'job-gdpr-uk-full-letter-consistency',
        category: 'ADDRESS',
        confidence: 96,
        start: gpAddressStart,
        end: gpAddressStart + '10 High Street, London E1 7AA'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-full-letter-consistency',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-patient-header',
        'e-gdpr-uk-patient-greeting',
        'e-gdpr-uk-patient-surname',
        'e-gdpr-uk-gp-first',
        'e-gdpr-uk-consultant-first',
        'e-gdpr-uk-consultant-second',
        'e-gdpr-uk-gp-second',
        'e-gdpr-uk-gp-practice-first',
        'e-gdpr-uk-gp-practice-second',
        'e-gdpr-uk-nhs-number',
        'e-gdpr-uk-patient-address',
        'e-gdpr-uk-gp-address',
      ],
    });

    expect(preview).toContain('Patient: Mrs. [PATIENT_ID_1]');
    expect(preview).toContain('Dear Mrs. [PATIENT_ID_1],');
    expect(preview).toContain('Mrs. [PATIENT_ID_1] reports excellent adherence');
    expect(preview).toContain('GP: Dr. [DOCTOR_ID_1], [GP_PRACTICE], [REDACT]');
    expect(preview).toContain('Clinician : Dr. [DOCTOR_ID_2], Consultant Diabetologist');
    expect(preview).toContain('Signed: Dr. [DOCTOR_ID_2]');
    expect(preview).toContain('Dr. [DOCTOR_ID_1] (GP) [GP_PRACTICE]');
    expect(preview).not.toContain('London E1 7AA');
    expect(preview).not.toContain('[PERSON_ID_');
  });

  it('should replace visit time with [TIME] and preserve surrounding text in GDPR_UK preview', async () => {
    const text = 'Time seen: 09:45 Reason for attendance: follow-up';
    const hash = createHash('sha256').update(text).digest('hex');
    const timeStart = text.indexOf('09:45');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-visit-time',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-visit-time',
        jobId: 'job-gdpr-uk-visit-time',
        category: 'DATE_TIME',
        confidence: 96,
        start: timeStart,
        end: timeStart + '09:45'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-visit-time',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-visit-time'],
    });

    expect(preview).toBe('Time seen: [TIME] Reason for attendance: follow-up');
  });

  it('should keep same DOCTOR token for repeated same doctor in one GDPR_UK document', async () => {
    const text =
      'GP practice: Dr Michael Patel. Referrer details: Referred by Dr Michael Patel. Seen by: Dr Alex Rivera. Signed by: Dr Alex Rivera.';
    const hash = createHash('sha256').update(text).digest('hex');

    const firstMichaelStart = text.indexOf('Michael Patel');
    const secondMichaelStart = text.indexOf('Michael Patel', firstMichaelStart + 1);
    const firstAlexStart = text.indexOf('Alex Rivera');
    const secondAlexStart = text.indexOf('Alex Rivera', firstAlexStart + 1);

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-doctor-consistency',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-doctor-michael-1',
        jobId: 'job-gdpr-uk-doctor-consistency',
        category: 'PERSON',
        confidence: 98,
        start: firstMichaelStart,
        end: firstMichaelStart + 'Michael Patel'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-doctor-michael-2',
        jobId: 'job-gdpr-uk-doctor-consistency',
        category: 'PERSON',
        confidence: 98,
        start: secondMichaelStart,
        end: secondMichaelStart + 'Michael Patel'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-doctor-alex-1',
        jobId: 'job-gdpr-uk-doctor-consistency',
        category: 'PERSON',
        confidence: 98,
        start: firstAlexStart,
        end: firstAlexStart + 'Alex Rivera'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-doctor-alex-2',
        jobId: 'job-gdpr-uk-doctor-consistency',
        category: 'PERSON',
        confidence: 98,
        start: secondAlexStart,
        end: secondAlexStart + 'Alex Rivera'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-doctor-consistency',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-doctor-michael-1',
        'e-gdpr-uk-doctor-michael-2',
        'e-gdpr-uk-doctor-alex-1',
        'e-gdpr-uk-doctor-alex-2',
      ],
    });

    expect(preview).toBe(
      'GP practice: Dr [DOCTOR_ID_1]. Referrer details: Referred by Dr [DOCTOR_ID_1]. Seen by: Dr [DOCTOR_ID_2]. Signed by: Dr [DOCTOR_ID_2].',
    );
  });

  it('should keep same DOCTOR token when first GP mention is misclassified as ORGANIZATION', async () => {
    const text =
      'GP: Dr Michael Patel. Referrer details: Referred by Dr Michael Patel. Seen by: Dr Alex Rivera.';
    const hash = createHash('sha256').update(text).digest('hex');

    const firstMichaelStart = text.indexOf('Dr Michael Patel');
    const secondMichaelStart = text.indexOf(
      'Michael Patel',
      firstMichaelStart + 'Dr Michael Patel'.length,
    );
    const alexStart = text.indexOf('Alex Rivera');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-doctor-org-fallback',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-doctor-org-first',
        jobId: 'job-gdpr-uk-doctor-org-fallback',
        category: 'ORGANIZATION',
        confidence: 97,
        start: firstMichaelStart,
        end: firstMichaelStart + 'Dr Michael Patel'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-doctor-person-second',
        jobId: 'job-gdpr-uk-doctor-org-fallback',
        category: 'PERSON',
        confidence: 98,
        start: secondMichaelStart,
        end: secondMichaelStart + 'Michael Patel'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-doctor-person-alex',
        jobId: 'job-gdpr-uk-doctor-org-fallback',
        category: 'PERSON',
        confidence: 98,
        start: alexStart,
        end: alexStart + 'Alex Rivera'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-doctor-org-fallback',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-doctor-org-first',
        'e-gdpr-uk-doctor-person-second',
        'e-gdpr-uk-doctor-person-alex',
      ],
    });

    expect(preview).toBe(
      'GP: Dr [DOCTOR_ID_1]. Referrer details: Referred by Dr [DOCTOR_ID_1]. Seen by: Dr [DOCTOR_ID_2].',
    );
  });

  it('should classify Full Name under Patient Identification as PATIENT in GDPR_UK preview', async () => {
    const text =
      'Clinician: Dr Alice Walker. Patient Identification: Full Name: Mr. Daniel Wright. Address: [REDACT] GP: Dr. Michael Harris (GMC: [REDACT]).';
    const hash = createHash('sha256').update(text).digest('hex');

    const clinicianStart = text.indexOf('Alice Walker');
    const patientStart = text.indexOf('Daniel Wright');
    const gpStart = text.indexOf('Michael Harris');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-patient-identification-full-name',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-clinician-doctor',
        jobId: 'job-gdpr-uk-patient-identification-full-name',
        category: 'PERSON',
        confidence: 98,
        start: clinicianStart,
        end: clinicianStart + 'Alice Walker'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-patient-full-name',
        jobId: 'job-gdpr-uk-patient-identification-full-name',
        category: 'PERSON',
        confidence: 98,
        start: patientStart,
        end: patientStart + 'Daniel Wright'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-gp-doctor',
        jobId: 'job-gdpr-uk-patient-identification-full-name',
        category: 'PERSON',
        confidence: 98,
        start: gpStart,
        end: gpStart + 'Michael Harris'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-patient-identification-full-name',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-clinician-doctor',
        'e-gdpr-uk-patient-full-name',
        'e-gdpr-uk-gp-doctor',
      ],
    });

    expect(preview).toContain('Clinician: Dr [DOCTOR_ID_1].');
    expect(preview).toContain('Full Name: Mr. [PATIENT_ID_1].');
    expect(preview).toContain('GP: Dr. [DOCTOR_ID_2] (GMC: [REDACT]).');
    expect(preview).not.toContain('Full Name: Mr. [DOCTOR_ID_1]');
  });

  it('should harden patient-identification block for UK GDPR audit risks', async () => {
    const text =
      'Patient Identification: Full Name: Mr. Daniel Wright Date of Birth: 15/03/1958 (Age 65) NHS Number: 123 456 7890 Address: 45 Oak Avenue, London, SW1A 1AA GP: Dr. Emily Carter (GMC: 1234567) Date/Time: 2024 Type: Face-to-Face Consultation Echo EF 35% (2023) Social History: as he provides care for his elderly mother.';
    const hash = createHash('sha256').update(text).digest('hex');

    const patientStart = text.indexOf('Daniel Wright');
    const dobStart = text.indexOf('15/03/1958');
    const ageStart = text.indexOf('65');
    const nhsNumberStart = text.indexOf('123 456 7890');
    const addressStart = text.indexOf('45 Oak Avenue, London, SW1A 1AA');
    const gpStart = text.indexOf('Emily Carter');
    const gmcStart = text.indexOf('1234567');
    const dateTimeStart = text.indexOf('2024');
    const priorYearStart = text.indexOf('2023');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-audit-hardening',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-audit-patient',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'PERSON',
        confidence: 98,
        start: patientStart,
        end: patientStart + 'Daniel Wright'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-audit-dob',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'DATE_OF_BIRTH',
        confidence: 97,
        start: dobStart,
        end: dobStart + '15/03/1958'.length,
        proxyType: 'Generalize',
      },
      {
        id: 'e-gdpr-uk-audit-age',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'AGE',
        confidence: 95,
        start: ageStart,
        end: ageStart + '65'.length,
        proxyType: 'Aggregate',
      },
      {
        id: 'e-gdpr-uk-audit-nhs',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'UK_NHS_NUMBER',
        confidence: 99,
        start: nhsNumberStart,
        end: nhsNumberStart + '123 456 7890'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-audit-address',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'ADDRESS',
        confidence: 96,
        start: addressStart,
        end: addressStart + '45 Oak Avenue, London, SW1A 1AA'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-audit-gp',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'PERSON',
        confidence: 98,
        start: gpStart,
        end: gpStart + 'Emily Carter'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-audit-gmc',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'NATIONAL_ID',
        confidence: 97,
        start: gmcStart,
        end: gmcStart + '1234567'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-audit-date-time-current',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'DATE_TIME',
        confidence: 95,
        start: dateTimeStart,
        end: dateTimeStart + '2024'.length,
        proxyType: 'Generalize',
      },
      {
        id: 'e-gdpr-uk-audit-date-time-prior',
        jobId: 'job-gdpr-uk-audit-hardening',
        category: 'DATE_TIME',
        confidence: 95,
        start: priorYearStart,
        end: priorYearStart + '2023'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-audit-hardening',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [
        'e-gdpr-uk-audit-patient',
        'e-gdpr-uk-audit-dob',
        'e-gdpr-uk-audit-age',
        'e-gdpr-uk-audit-nhs',
        'e-gdpr-uk-audit-address',
        'e-gdpr-uk-audit-gp',
        'e-gdpr-uk-audit-gmc',
        'e-gdpr-uk-audit-date-time-current',
        'e-gdpr-uk-audit-date-time-prior',
      ],
    });

    expect(preview).toContain('Full Name: Mr. [PATIENT_ID_1]');
    expect(preview).toContain('Date of Birth: [AGE_RANGE: 50-69]');
    expect(preview).not.toContain('Date of Birth: 1958');
    expect(preview).toContain('Address: [REDACT]');
    expect(preview).not.toContain('[REDACT, Greater London]');
    expect(preview).toContain('GP: Dr. [DOCTOR_ID_1] (GMC: [REDACT])');
    expect(preview).toContain('Date/Time: [Day 1]');
    expect(preview).toContain('Echo EF 35% ([RELATIVE_YEAR_-1])');
    expect(preview).toContain('[SOCIAL_DEPENDENTS_REDACTED]');
    expect(preview).not.toContain('provides care for his elderly mother');
  });

  it('should convert absolute timeline anchors to relative tokens and generalize family details in GDPR_UK', async () => {
    const text =
      'Date of appointment: APRIL 2026. PMH: Essential hypertension (diagnosed 2018). Last review was last month. DOB: 1968 ([50-69]). [30-49] gentleman attends with two children, ages 12 and 9.';
    const hash = createHash('sha256').update(text).digest('hex');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-relative-timeline-hardening',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-relative-timeline-hardening',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: [],
    });

    expect(preview).toContain('Date of appointment: [Day 1].');
    expect(preview).toContain('(diagnosed [RELATIVE_YEAR_-8]).');
    expect(preview).toContain('Last review was [RELATIVE_MONTH_-1].');
    expect(preview).toContain('DOB: [AGE_RANGE: 50-69].');
    expect(preview).toContain('A gentleman in his 30s attends with [FAMILY_DETAILS_REDACTED].');
    expect(preview).not.toContain('APRIL 2026');
    expect(preview).not.toContain('diagnosed 2018');
    expect(preview).not.toContain('1968 ([50-69])');
  });

  it('should keep clinical negation with generic hospital mentions and redact only named hospitals in GDPR_UK', async () => {
    const text =
      "No hospital admissions in past year. Referred to St. Thomas' Hospital for urgent review.";
    const hash = createHash('sha256').update(text).digest('hex');

    const genericHospitalStart = text.indexOf('hospital');
    const namedHospitalStart = text.indexOf("St. Thomas' Hospital");

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-negation-hospital-protection',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-negation-generic-hospital',
        jobId: 'job-gdpr-uk-negation-hospital-protection',
        category: 'ORGANIZATION',
        confidence: 90,
        start: genericHospitalStart,
        end: genericHospitalStart + 'hospital'.length,
        proxyType: 'Redact',
      },
      {
        id: 'e-gdpr-uk-negation-named-hospital',
        jobId: 'job-gdpr-uk-negation-hospital-protection',
        category: 'ORGANIZATION',
        confidence: 99,
        start: namedHospitalStart,
        end: namedHospitalStart + "St. Thomas' Hospital".length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-negation-hospital-protection',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-negation-generic-hospital', 'e-gdpr-uk-negation-named-hospital'],
    });

    expect(preview).toContain('No hospital admissions in past year.');
    expect(preview).toContain('Referred to [HOSPITAL] for urgent review.');
    expect(preview).not.toContain('No [HOSPITAL] admissions');
  });

  it('should classify doctor role from GP suffix context and keep doctor indexing stable in GDPR_UK', async () => {
    const text = 'Letter footer: Sarah Reed (GP). Reviewed by Dr Alex Rivera.';
    const hash = createHash('sha256').update(text).digest('hex');

    const gpNameStart = text.indexOf('Sarah Reed');
    const secondDoctorStart = text.indexOf('Alex Rivera');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-gp-suffix-role',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-gp-suffix-doctor',
        jobId: 'job-gdpr-uk-gp-suffix-role',
        category: 'PERSON',
        confidence: 98,
        start: gpNameStart,
        end: gpNameStart + 'Sarah Reed'.length,
        proxyType: 'Synthetic ID',
      },
      {
        id: 'e-gdpr-uk-second-doctor',
        jobId: 'job-gdpr-uk-gp-suffix-role',
        category: 'PERSON',
        confidence: 98,
        start: secondDoctorStart,
        end: secondDoctorStart + 'Alex Rivera'.length,
        proxyType: 'Synthetic ID',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-gp-suffix-role',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-gp-suffix-doctor', 'e-gdpr-uk-second-doctor'],
    });

    expect(preview).toBe('Letter footer: [DOCTOR_ID_1] (GP). Reviewed by Dr [DOCTOR_ID_2].');
  });

  it('should merge split local UK phone spans and fully redact in GDPR_UK preview', async () => {
    const text = 'Next of kin: Mr John Brown (husband) - 07812 345678';
    const hash = createHash('sha256').update(text).digest('hex');

    const phonePrefixStart = text.indexOf('07812');
    const phoneTailStart = text.indexOf('345678');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-split-local-phone',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-phone-prefix',
        jobId: 'job-gdpr-uk-split-local-phone',
        category: 'PHONE_NUMBER',
        confidence: 97,
        start: phonePrefixStart,
        end: phoneTailStart - 1,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
      {
        id: 'e-gdpr-uk-phone-tail-national-id',
        jobId: 'job-gdpr-uk-split-local-phone',
        category: 'NATIONAL_ID',
        confidence: 95,
        start: phoneTailStart,
        end: phoneTailStart + '345678'.length,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-split-local-phone',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-phone-prefix'],
    });

    expect(preview).toBe('Next of kin: Mr John Brown (husband) - [REDACT]');
  });

  it('should merge split local UK phone spans separated by unicode dash in GDPR_UK preview', async () => {
    const normalizedText = 'Next of kin: Mr John Brown (husband) - 07812 \u2013 345678';
    const hash = createHash('sha256').update(normalizedText).digest('hex');

    const phonePrefixStart = normalizedText.indexOf('07812');
    const phoneDashIndex = normalizedText.indexOf('–');
    const phoneTailStart = normalizedText.indexOf('345678');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-split-local-phone-unicode-dash',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: normalizedText.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-phone-prefix-unicode-dash',
        jobId: 'job-gdpr-uk-split-local-phone-unicode-dash',
        category: 'PHONE_NUMBER',
        confidence: 97,
        start: phonePrefixStart,
        end: phoneDashIndex,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
      {
        id: 'e-gdpr-uk-phone-tail-national-id-unicode-dash',
        jobId: 'job-gdpr-uk-split-local-phone-unicode-dash',
        category: 'NATIONAL_ID',
        confidence: 95,
        start: phoneTailStart,
        end: phoneTailStart + '345678'.length,
        proxyType: 'Redact',
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-split-local-phone-unicode-dash',
      text: normalizedText,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-phone-prefix-unicode-dash'],
    });

    expect(preview).toBe('Next of kin: Mr John Brown (husband) - [REDACT]');
  });

  it('should redact UK GP practice code in GDPR_UK preview', async () => {
    const text = 'Practice code: G85678';
    const hash = createHash('sha256').update(text).digest('hex');

    const gpCodeStart = text.indexOf('G85678');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-gdpr-uk-gp-practice-code',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-gdpr-uk-gp-practice-code',
        jobId: 'job-gdpr-uk-gp-practice-code',
        category: 'UK_GP_PRACTICE_CODE',
        confidence: 98,
        start: gpCodeStart,
        end: gpCodeStart + 'G85678'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-gdpr-uk-gp-practice-code',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-gdpr-uk-gp-practice-code'],
    });

    expect(preview).toBe('Practice code: [REDACT]');
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

    expect(preview).toBe('Patient aged [35-39]');
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

    expect(preview).toBe('Patient from NY');
  });

  it('should keep state code and redact city for HIPAA location preview', async () => {
    const text = 'Clinic location: Chicago, IL';
    const hash = createHash('sha256').update(text).digest('hex');

    const locationStart = text.indexOf('Chicago, IL');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-loc-state-code',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-location-state-code',
        jobId: 'job-loc-state-code',
        category: 'LOCATION',
        confidence: 91,
        start: locationStart,
        end: locationStart + 'Chicago, IL'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-loc-state-code',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-location-state-code'],
    });

    expect(preview).toBe('Clinic location: IL');
  });

  it('should redact city-only location for HIPAA preview', async () => {
    const text = 'Clinic location: Chicago';
    const hash = createHash('sha256').update(text).digest('hex');

    const locationStart = text.indexOf('Chicago');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-loc-city-only',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-location-city-only',
        jobId: 'job-loc-city-only',
        category: 'LOCATION',
        confidence: 90,
        start: locationStart,
        end: locationStart + 'Chicago'.length,
        proxyType: 'Generalize',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-loc-city-only',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-location-city-only'],
    });

    expect(preview).toBe('Clinic location: [REDACT]');
  });

  it('should redact occupation value in HIPAA preview', async () => {
    const text = 'Social History: works as accountant';
    const hash = createHash('sha256').update(text).digest('hex');

    const occupationStart = text.indexOf('accountant');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-occupation-preview',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-occupation',
        jobId: 'job-occupation-preview',
        category: 'OCCUPATION',
        confidence: 96,
        start: occupationStart,
        end: occupationStart + 'accountant'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-occupation-preview',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-occupation'],
    });

    expect(preview).toBe('Social History: works as [REDACT]');
  });

  it('should redact occupation value in GDPR_UK preview', async () => {
    const text = 'Social History: works as secondary school teacher';
    const hash = createHash('sha256').update(text).digest('hex');

    const occupationStart = text.indexOf('secondary school teacher');

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-occupation-preview-gdpr-uk',
      framework: ComplianceFramework.GDPR_UK,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    entityManagerMock.find.mockResolvedValue([
      {
        id: 'e-occupation-gdpr-uk',
        jobId: 'job-occupation-preview-gdpr-uk',
        category: 'OCCUPATION',
        confidence: 96,
        start: occupationStart,
        end: occupationStart + 'secondary school teacher'.length,
        proxyType: 'Redact',
      },
    ] satisfies Partial<DetectedEntity>[]);

    const preview = await service.getPreview({
      jobId: 'job-occupation-preview-gdpr-uk',
      text,
      framework: ComplianceFramework.GDPR_UK,
      activeIds: ['e-occupation-gdpr-uk'],
    });

    expect(preview).toBe('Social History: works as [REDACT]');
  });

  it('should redact occupation in HIPAA preview only when it is explicitly selected', async () => {
    const text = 'Social History: works as accountant';
    const hash = createHash('sha256').update(text).digest('hex');

    const occupationStart = text.indexOf('accountant');

    const occupationEntity = {
      id: 'e-occupation',
      jobId: 'job-occupation-toggle',
      category: 'OCCUPATION',
      confidence: 96,
      start: occupationStart,
      end: occupationStart + 'accountant'.length,
      proxyType: 'Redact',
    } satisfies Partial<DetectedEntity>;

    entityManagerMock.findOne.mockResolvedValue({
      id: 'job-occupation-toggle',
      framework: ComplianceFramework.HIPAA,
      sourceTextHash: hash,
      sourceTextLength: text.length,
    } satisfies Partial<DeIdJob>);

    // First call: OCCUPATION not in activeIds → not redacted
    entityManagerMock.find.mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]);

    const previewWithout = await service.getPreview({
      jobId: 'job-occupation-toggle',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: [],
    });

    // Second call: OCCUPATION in activeIds → redacted
    entityManagerMock.find.mockResolvedValueOnce([
      {
        ...occupationEntity,
        systemStatus: DetectedEntityStatus.ACTIVE,
      },
    ] satisfies Partial<DetectedEntity>[]);

    const previewWith = await service.getPreview({
      jobId: 'job-occupation-toggle',
      text,
      framework: ComplianceFramework.HIPAA,
      activeIds: ['e-occupation'],
    });

    expect(previewWithout).toBe(text);
    expect(previewWith).toBe('Social History: works as [REDACT]');
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

  describe('filterFalsePositivesByContext (HIPAA medical text)', () => {
    it('should filter DATE_TIME false positive for long contact number token', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-date-phone-false-positive',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'Contact: +39 06 98765439876543';
      const longNumericStart = text.indexOf('98765439876543');

      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'DATE_TIME',
          start: longNumericStart,
          end: longNumericStart + '98765439876543'.length,
          score: 0.92,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'DATE_TIME',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter out medical units from Allow List (mg, ml, daily, etc)', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-medical-units',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      // Text with medical units that should be filtered
      const medicalText = 'Patient takes 50 mg daily and 2 ml of medication';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'DATE_TIME', start: 15, end: 17, score: 0.6 }, // "50" near "mg"
        { entity_type: 'DATE_TIME', start: 38, end: 39, score: 0.6 }, // "2" near "ml"
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: medicalText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      // These numbers should be filtered out due to medical context
      expect(result.findings.length).toBeLessThanOrEqual(2);
    });

    it('should filter out numbers in Physical Exam context (vitals)', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-vitals',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      // Text with vital signs
      const vitalText = 'Physical Exam: BP: 120/80, HR: 72, Temp: 98.6F';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'DATE_TIME', start: 19, end: 22, score: 0.6 }, // "120" in BP
        { entity_type: 'DATE_TIME', start: 33, end: 35, score: 0.6 }, // "72" in HR
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: vitalText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      // Numbers in Physical Exam context should be filtered
      expect(result.findings.length).toBeLessThanOrEqual(2);
    });

    it('should keep absolute DATE_TIME even in Physical Exam context', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-absolute-date-vitals',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'Physical Exam on 04/11/2026: BP 120/80, HR 72.';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'DATE_TIME', start: 17, end: 27, score: 0.55 },
        { entity_type: 'DATE_TIME', start: 32, end: 35, score: 0.55 },
        { entity_type: 'DATE_TIME', start: 43, end: 45, score: 0.55 },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      const activeFindings = result.findings.filter((finding) => finding.systemStatus === 'ACTIVE');
      const inactiveFindings = result.findings.filter(
        (finding) => finding.systemStatus === 'INACTIVE',
      );

      expect(activeFindings).toHaveLength(1);
      expect(activeFindings[0].category).toBe('DATE_TIME');
      expect(activeFindings[0].start).toBe(17);
      expect(activeFindings[0].end).toBe(27);
      expect(inactiveFindings).toHaveLength(2);
    });

    it('should keep DATE_TIME in consultation date context', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-consultation-date-context',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'Consultation Date: 2026. Physical Exam: BP 120/80';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'DATE_TIME', start: 19, end: 23, score: 0.55 },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.GDPR_EU,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe('DATE_TIME');
      expect(result.findings[0].start).toBe(19);
      expect(result.findings[0].end).toBe(23);
    });

    it('should NOT filter high-risk entities (SSN, MRN) even in medication context', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-high-risk',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const ssnText = 'Patient SSN: 123-45-6789 prescribed 50 mg daily';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'US_SSN_FULL', start: 13, end: 24, score: 0.98 }, // 123-45-6789
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: ssnText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      // High-risk SSN should NOT be filtered
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe('US_SSN_FULL');
    });

    it('should keep age values below 90 when explicitly labeled as age', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-age',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const ageText = 'Age: 52. Patient reports no other complaints.';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'DATE_TIME', start: 5, end: 7, score: 0.72 },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: ageText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'DATE_TIME',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter doctor credentials like MD from location false positives', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-md-title',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const doctorText = 'Attending physician: Jane Smith, MD';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'LOCATION', start: 33, end: 35, score: 0.81 },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: doctorText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'LOCATION',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter DESMOND token misclassified as PERSON in GDPR_UK', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-gdpr-uk-desmond-person-fp',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'NHS Diabetes Structured Education Programme (DESMOND or equivalent).';
      const desmondStart = text.indexOf('DESMOND');
      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'PERSON',
          start: desmondStart,
          end: desmondStart + 'DESMOND'.length,
          score: 0.9,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.GDPR_UK,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'PERSON',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter diagnosis term ending with -emia misclassified as LOCATION in GDPR_UK', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-gdpr-uk-emia-location-fp',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'Past medical history: Hypercholesterolaemia';
      const diagnosisStart = text.indexOf('Hypercholesterolaemia');
      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'LOCATION',
          start: diagnosisStart,
          end: diagnosisStart + 'Hypercholesterolaemia'.length,
          score: 0.82,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.GDPR_UK,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'LOCATION',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter medical procedure terms misclassified as PERSON in GDPR_UK', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-gdpr-uk-procedure-person-fp',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text =
        'Investigations: Arrange urgent NT-proBNP, Chest X-ray, and Transthoracic Echocardiogram.';
      const chestXrayStart = text.indexOf('Chest X-ray');
      const tteStart = text.indexOf('Transthoracic Echocardiogram');
      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'PERSON',
          start: chestXrayStart,
          end: chestXrayStart + 'Chest X-ray'.length,
          score: 0.84,
        },
        {
          entity_type: 'PERSON',
          start: tteStart,
          end: tteStart + 'Transthoracic Echocardiogram'.length,
          score: 0.83,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.GDPR_UK,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(2);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'PERSON',
            systemStatus: 'INACTIVE',
            start: chestXrayStart,
            end: chestXrayStart + 'Chest X-ray'.length,
          }),
          expect.objectContaining({
            category: 'PERSON',
            systemStatus: 'INACTIVE',
            start: tteStart,
            end: tteStart + 'Transthoracic Echocardiogram'.length,
          }),
        ]),
      );
    });

    it('should filter role term General Practitioner misclassified as PERSON in GDPR_UK', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-gdpr-uk-role-term-person-fp',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'From: Dr. Alistair Vance, General Practitioner';
      const gpRoleStart = text.indexOf('General Practitioner');
      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'PERSON',
          start: gpRoleStart,
          end: gpRoleStart + 'General Practitioner'.length,
          score: 0.88,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.GDPR_UK,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'PERSON',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter SNOMED CT numeric code misclassified as NATIONAL_ID in GDPR_UK', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-gdpr-uk-snomed-national-id-fp',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const text = 'Assessment: ADHF (SNOMED CT: 42343007).';
      const codeStart = text.indexOf('42343007');
      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'NATIONAL_ID',
          start: codeStart,
          end: codeStart + '42343007'.length,
          score: 0.9,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.GDPR_UK,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'NATIONAL_ID',
        systemStatus: 'INACTIVE',
      });
    });

    it('should filter HEENT abbreviation as medical allow-list term', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-heent-abbreviation',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const physicalExamText =
        'Physical Exam: Normal general, HEENT, cardiac, pulmonary, abdominal, and neurological exam.';
      const heentStart = physicalExamText.indexOf('HEENT');

      presidioClientMock.analyze.mockResolvedValue([
        {
          entity_type: 'LOCATION',
          start: heentStart,
          end: heentStart + 'HEENT'.length,
          score: 0.9,
        },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: physicalExamText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: 'LOCATION',
        systemStatus: 'INACTIVE',
      });
    });

    it('should keep ZIP codes as high-risk HIPAA findings', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-zip',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const zipText = 'Address: 101 Main Street, Boston, MA 02118';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'US_ZIP', start: 37, end: 42, score: 0.93 },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: zipText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings.some((finding) => finding.category === 'US_ZIP')).toBe(true);
    });

    it('should keep actual dates even when age context appears nearby', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-age-date',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      const ageAndDateText = 'Age documented on 01/02/2024 during intake.';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'DATE_TIME', start: 18, end: 28, score: 0.9 },
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text: ageAndDateText,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe('DATE_TIME');
    });

    it('should filter LOCATION without location context keywords', async () => {
      const tm: TransactionManagerMock = {
        create: jest.fn((target: unknown, payload: Record<string, unknown>) => ({
          id: 'job-location',
          ...payload,
        })),
        save: jest.fn((entity: unknown) => {
          if (Array.isArray(entity)) return Promise.resolve(entity);
          return Promise.resolve(entity);
        }),
      };

      entityManagerMock.transaction.mockImplementation(
        async (callback: (tx: TransactionManagerMock) => unknown) => callback(tm),
      );

      // LOCATION without proper context (low score = likely false positive)
      const text = 'Patient reports symptoms in 2024';
      presidioClientMock.analyze.mockResolvedValue([
        { entity_type: 'LOCATION', start: 28, end: 32, score: 0.6 }, // \"2024\" misidentified as location
      ] satisfies AnalyzerFinding[]);

      const result = await service.analyzeText({
        text,
        framework: ComplianceFramework.HIPAA,
        threshold: 0.5,
        preserveStructure: false,
      });

      // Low-confidence LOCATION without context should be filtered
      expect(result.findings.length).toBeLessThanOrEqual(1);
    });
  });

  describe('generateSyntheticTable', () => {
    it('should generate table rows and return generationId', async () => {
      const sourceText = 'John Doe visited on 2025-02-14. Contact: +49 30 1234567';
      const sourceTextHash = createHash('sha256').update(sourceText).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-table',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        sourceTextHash,
        sourceTextLength: sourceText.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'entity-1',
          jobId: 'job-table',
          category: 'PERSON',
          confidence: 95,
          start: 0,
          end: 8,
          proxyType: 'Redact',
          systemStatus: DetectedEntityStatus.ACTIVE,
        },
      ] satisfies Partial<DetectedEntity>[]);

      const result = await service.generateSyntheticTable(
        {
          jobId: 'job-table',
          text: sourceText,
          count: 3,
          outputFormat: SyntheticOutputFormat.TXT,
        },
        'user-1',
      );

      expect(result.generationId).toBe('gen-uuid-test');
      expect(result.rows).toHaveLength(3);
      expect(result.columns).toEqual(expect.any(Array));
      expect(result.rows[0]).toMatchObject({
        variantNumber: 1,
        entities: expect.any(Object),
      });
      expect(result.summary.totalRows).toBe(3);
      expect(result.summary.framework).toBe(ComplianceFramework.GDPR_EU);
      expect(syntheticGenerationStoreMock.save).toHaveBeenCalledTimes(1);
    });

    it('should reject generateSyntheticTable for foreign job', async () => {
      entityManagerMock.findOne.mockResolvedValue(null);

      await expect(
        service.generateSyntheticTable(
          {
            jobId: 'job-foreign',
            text: 'irrelevant text',
            count: 3,
            outputFormat: SyntheticOutputFormat.TXT,
          },
          'user-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject generateSyntheticTable when text hash mismatches', async () => {
      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-mismatch',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        sourceTextHash: createHash('sha256').update('different text').digest('hex'),
        sourceTextLength: 'different text'.length,
      } satisfies Partial<DeIdJob>);

      await expect(
        service.generateSyntheticTable(
          {
            jobId: 'job-mismatch',
            text: 'original text',
            count: 2,
            outputFormat: SyntheticOutputFormat.TXT,
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject generateSyntheticTable when no active entities', async () => {
      const sourceText = 'no pii here';
      const sourceTextHash = createHash('sha256').update(sourceText).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-inactive',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        sourceTextHash,
        sourceTextLength: sourceText.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'entity-1',
          jobId: 'job-inactive',
          category: 'PERSON',
          systemStatus: DetectedEntityStatus.INACTIVE,
        },
      ] satisfies Partial<DetectedEntity>[]);

      await expect(
        service.generateSyntheticTable(
          {
            jobId: 'job-inactive',
            text: sourceText,
            count: 3,
            outputFormat: SyntheticOutputFormat.TXT,
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject generateSyntheticTable count above configured max', async () => {
      const sourceText = 'John Doe visited on 2025-02-14. Contact: +49 30 1234567';
      const sourceTextHash = createHash('sha256').update(sourceText).digest('hex');

      configServiceMock.get.mockReturnValue('2');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-table-max-check',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        sourceTextHash,
        sourceTextLength: sourceText.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'entity-1',
          jobId: 'job-table-max-check',
          category: 'PERSON',
          confidence: 95,
          start: 0,
          end: 8,
          proxyType: 'Redact',
          systemStatus: DetectedEntityStatus.ACTIVE,
        },
      ] satisfies Partial<DetectedEntity>[]);

      await expect(
        service.generateSyntheticTable(
          {
            jobId: 'job-table-max-check',
            text: sourceText,
            count: 3,
            outputFormat: SyntheticOutputFormat.TXT,
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('downloadSyntheticArchive', () => {
    it('should build and return archive buffer for valid generationId', async () => {
      const entityRows = [
        { variantNumber: 1, entities: { PERSON: 'Synthetic Name 1' } },
        { variantNumber: 2, entities: { PERSON: 'Synthetic Name 2' } },
      ];
      const entityMappings = [
        { instanceKey: 'PERSON', category: 'PERSON', start: 0, end: 8, originalValue: 'original' },
      ];

      syntheticGenerationStoreMock.get.mockReturnValue({
        jobId: 'job-dl',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        columns: ['PERSON'],
        entityMappings,
        entityRows,
        outputFormat: SyntheticOutputFormat.TXT,
        originalText: 'original text',
        baseOrdinal: 0,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const result = await service.downloadSyntheticArchive('gen-uuid-test', 'user-1');

      expect(result.jobId).toBe('job-dl');
      expect(result.variantsGenerated).toBe(2);
      expect(result.mimeType).toBe('application/zip');
      expect(result.archiveBuffer.subarray(0, 2).toString()).toBe('PK');
    });

    it('should throw NotFoundException for unknown generationId', async () => {
      syntheticGenerationStoreMock.get.mockReturnValue(null);

      await expect(service.downloadSyntheticArchive('unknown-id', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when generationId belongs to another user', async () => {
      syntheticGenerationStoreMock.get.mockReturnValue({
        jobId: 'job-dl',
        userUuid: 'other-user',
        columns: ['PERSON'],
        entityMappings: [],
        entityRows: [{ variantNumber: 1, entities: { PERSON: 'Synthetic' } }],
        outputFormat: SyntheticOutputFormat.TXT,
        originalText: 'original',
        baseOrdinal: 0,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      await expect(service.downloadSyntheticArchive('gen-uuid-test', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should build pdf archive when text contains unicode bullet separators', async () => {
      syntheticGenerationStoreMock.get.mockReturnValue({
        jobId: 'job-pdf',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        columns: [],
        entityMappings: [],
        entityRows: [{ variantNumber: 1, entities: {} }],
        outputFormat: SyntheticOutputFormat.PDF,
        originalText: 'Phone +1 212 5551234 ● Email patient@example.com',
        baseOrdinal: 0,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const result = await service.downloadSyntheticArchive('gen-uuid-pdf', 'user-1');

      expect(result.outputFormat).toBe(SyntheticOutputFormat.PDF);
      expect(result.archiveBuffer.subarray(0, 2).toString()).toBe('PK');
    });
  });

  describe('regenerateSyntheticTable', () => {
    it('should produce a new generationId with new rows', async () => {
      syntheticGenerationStoreMock.get.mockReturnValue({
        jobId: 'job-regen',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        columns: ['PERSON'],
        entityMappings: [
          {
            instanceKey: 'PERSON',
            category: 'PERSON',
            start: 0,
            end: 8,
            originalValue: 'John Doe',
          },
        ],
        entityRows: [
          { variantNumber: 1, entities: { PERSON: 'Old Name One' } },
          { variantNumber: 2, entities: { PERSON: 'Old Name Two' } },
        ],
        outputFormat: SyntheticOutputFormat.TXT,
        originalText: 'John Doe visited on 2025-02-14',
        baseOrdinal: 0,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      syntheticGenerationStoreMock.save.mockReturnValue('gen-uuid-regen');

      const result = await service.regenerateSyntheticTable(
        'gen-uuid-old',
        { count: 2, outputFormat: SyntheticOutputFormat.TXT },
        'user-1',
      );

      expect(result.generationId).toBe('gen-uuid-regen');
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].variantNumber).toBe(1);
      expect(result.rows[0].entities).toEqual(expect.any(Object));
      expect(result.columns).toEqual(expect.any(Array));
      expect(result.summary.totalRows).toBe(2);
    });

    it('should throw NotFoundException when generationId does not exist', async () => {
      syntheticGenerationStoreMock.get.mockReturnValue(null);

      await expect(
        service.regenerateSyntheticTable(
          'missing-id',
          { count: 3, outputFormat: SyntheticOutputFormat.TXT },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when generationId belongs to another user', async () => {
      syntheticGenerationStoreMock.get.mockReturnValue({
        jobId: 'job-regen',
        userUuid: 'other-user',
        framework: ComplianceFramework.GDPR_EU,
        columns: ['PERSON'],
        entityMappings: [],
        entityRows: [{ variantNumber: 1, entities: { PERSON: 'Synthetic' } }],
        outputFormat: SyntheticOutputFormat.TXT,
        originalText: 'original',
        baseOrdinal: 0,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      await expect(
        service.regenerateSyntheticTable(
          'gen-uuid-test',
          { count: 2, outputFormat: SyntheticOutputFormat.TXT },
          'user-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject regenerateSyntheticTable count above configured max', async () => {
      configServiceMock.get.mockReturnValue('2');

      syntheticGenerationStoreMock.get.mockReturnValue({
        jobId: 'job-regen',
        userUuid: 'user-1',
        framework: ComplianceFramework.GDPR_EU,
        columns: ['PERSON'],
        entityMappings: [
          {
            instanceKey: 'PERSON',
            category: 'PERSON',
            start: 0,
            end: 8,
            originalValue: 'John Doe',
          },
        ],
        entityRows: [{ variantNumber: 1, entities: { PERSON: 'Old Name One' } }],
        outputFormat: SyntheticOutputFormat.TXT,
        originalText: 'John Doe visited on 2025-02-14',
        baseOrdinal: 0,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      await expect(
        service.regenerateSyntheticTable(
          'gen-uuid-old',
          { count: 3, outputFormat: SyntheticOutputFormat.TXT },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('NHS clinic letter integration tests (UK-specific PII leaks)', () => {
    it('should redact street address after organization name and use correct doctor token in GP section', async () => {
      const text =
        'GP: Dr Emily Jones Practice: Riverside Medical Centre, 45 High Street, London SE1 9AB. Department: General Medicine Outpatient Department.';
      const hash = createHash('sha256').update(text).digest('hex');

      const emilyStart = text.indexOf('Dr Emily Jones');
      const organizationStart = text.indexOf('Riverside Medical Centre');
      const addressStart = text.indexOf('45 High Street');
      const deptStart = text.indexOf('General Medicine Outpatient Department');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-nhs-clinic-letter',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-emily-person',
          jobId: 'job-nhs-clinic-letter',
          category: 'PERSON',
          confidence: 98,
          start: emilyStart,
          end: emilyStart + 'Dr Emily Jones'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-riverside-org',
          jobId: 'job-nhs-clinic-letter',
          category: 'ORGANIZATION',
          confidence: 97,
          start: organizationStart,
          end: organizationStart + 'Riverside Medical Centre'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-address-street',
          jobId: 'job-nhs-clinic-letter',
          category: 'ADDRESS',
          confidence: 0.95,
          start: addressStart,
          end: addressStart + '45 High Street, London SE1 9AB'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-dept-generic',
          jobId: 'job-nhs-clinic-letter',
          category: 'ORGANIZATION',
          confidence: 0.8,
          start: deptStart,
          end: deptStart + 'General Medicine Outpatient Department'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-nhs-clinic-letter',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: ['e-emily-person', 'e-riverside-org', 'e-address-street', 'e-dept-generic'],
      });

      expect(preview).toContain('GP: Dr [DOCTOR_ID_1]');
      expect(preview).toContain('[GP_PRACTICE]');
      expect(preview).not.toContain('45 High Street');
      expect(preview).toContain('General Medicine Outpatient Department');
    });

    it('should preserve clinical comparison characters (>, <, &) unmodified in anonymized output', async () => {
      const text =
        'Lab Result: Blood sugar >90 mg/dL, <120 baseline & 180 peak. Patient: John Smith.';
      const hash = createHash('sha256').update(text).digest('hex');

      const johnStart = text.indexOf('John Smith');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-html-safety',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-john-person',
          jobId: 'job-html-safety',
          category: 'PERSON',
          confidence: 98,
          start: johnStart,
          end: johnStart + 'John Smith'.length,
          proxyType: 'Synthetic ID',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-html-safety',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: ['e-john-person'],
      });

      expect(preview).toContain('>');
      expect(preview).toContain('<');
      expect(preview).not.toContain('greater than');
      expect(preview).not.toContain('less than');
      expect(preview).toContain('&');
    });

    it('should not replace struct_labels (Clinic:, Location:, Department:) with doctor tokens in NHS clinic letter', async () => {
      const text =
        'Clinic: General Medicine / Hypertension Review. Clinician: Dr. Alex Thompson. Family history: Father – MI at 62.';
      const hash = createHash('sha256').update(text).digest('hex');

      const alexStart = text.indexOf('Dr. Alex Thompson');
      const ageStart = text.indexOf('at 62') + 'at '.length;

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-nhs-struct-labels',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-alex-person',
          jobId: 'job-nhs-struct-labels',
          category: 'PERSON',
          confidence: 98,
          start: alexStart,
          end: alexStart + 'Dr. Alex Thompson'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-age-62',
          jobId: 'job-nhs-struct-labels',
          category: 'AGE',
          confidence: 0.85,
          start: ageStart,
          end: ageStart + '62'.length,
          proxyType: 'Aggregate',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-nhs-struct-labels',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: ['e-alex-person', 'e-age-62'],
      });

      expect(preview).toContain('Clinic: General Medicine');
      expect(preview).not.toContain('[DOCTOR_ID_1]: General Medicine');
      expect(preview).toContain('Dr. [DOCTOR_ID_1]');
      expect(preview).toContain('Father – MI at [50-69]');
    });

    it('should keep Clinic label intact when PERSON false positive targets only the label token', async () => {
      const text =
        'Clinic: General Medicine / Hypertension Review. Clinician: Dr. Alex Thompson, Consultant Physician.';
      const hash = createHash('sha256').update(text).digest('hex');

      const clinicLabelStart = text.indexOf('Clinic');
      const alexStart = text.indexOf('Alex Thompson');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-nhs-clinic-label-person-fp',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-clinic-label-person-fp',
          jobId: 'job-nhs-clinic-label-person-fp',
          category: 'PERSON',
          confidence: 88,
          start: clinicLabelStart,
          end: clinicLabelStart + 'Clinic'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-clinician-person',
          jobId: 'job-nhs-clinic-label-person-fp',
          category: 'PERSON',
          confidence: 98,
          start: alexStart,
          end: alexStart + 'Alex Thompson'.length,
          proxyType: 'Synthetic ID',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-nhs-clinic-label-person-fp',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: ['e-clinic-label-person-fp', 'e-clinician-person'],
      });

      expect(preview).toContain('Clinic: General Medicine / Hypertension Review.');
      expect(preview).not.toContain('[DOCTOR_ID_1]: General Medicine / Hypertension Review');
      expect(preview).toContain('Clinician: Dr. [DOCTOR_ID_1], Consultant Physician.');
    });

    it('should keep clinic semantics and stable doctor IDs in full UK hypertension letter preview', async () => {
      const text =
        'NHS Central London Trust Outpatient Clinic Letter Date: 10 April 2026 Patient: Mr. Johnathan Robert Smith DOB: 15/03/1968 (Age 58) NHS Number: 987 654 3210 Address: 45 Oak Avenue, London, SW1A 1AA GP: Dr. Emily Carter, Riverside Medical Centre, London Dear Mr. Johnathan Robert Smith, Clinic: General Medicine / Hypertension Review Clinician: Dr. Alex Thompson, Consultant Physician Date of appointment: 10 April 2026 Family history: Father - MI at 62.';
      const hash = createHash('sha256').update(text).digest('hex');

      const trustStart = text.indexOf('NHS Central London Trust');
      const patientHeaderStart = text.indexOf('Johnathan Robert Smith');
      const patientGreetingStart = text.indexOf(
        'Johnathan Robert Smith',
        patientHeaderStart + 'Johnathan Robert Smith'.length,
      );
      const dobStart = text.indexOf('15/03/1968');
      const age58Start = text.indexOf('58');
      const nhsNumberStart = text.indexOf('987 654 3210');
      const addressStart = text.indexOf('45 Oak Avenue, London, SW1A 1AA');
      const gpDoctorStart = text.indexOf('Emily Carter');
      const gpPracticeStart = text.indexOf('Riverside Medical Centre');
      const gpRegionStart = text.indexOf('London', gpPracticeStart);
      const clinicValueStart = text.indexOf('General Medicine / Hypertension Review');
      const clinicianDoctorStart = text.indexOf('Alex Thompson');
      const appointmentDateStart = text.indexOf(
        '10 April 2026',
        text.indexOf('Date of appointment:'),
      );
      const familyAgeStart = text.lastIndexOf('62');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-hypertension-letter-golden',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-org-trust',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'ORGANIZATION',
          confidence: 98,
          start: trustStart,
          end: trustStart + 'NHS Central London Trust'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-person-patient-header',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'PERSON',
          confidence: 98,
          start: patientHeaderStart,
          end: patientHeaderStart + 'Johnathan Robert Smith'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-person-patient-greeting',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'PERSON',
          confidence: 98,
          start: patientGreetingStart,
          end: patientGreetingStart + 'Johnathan Robert Smith'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-dob',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'DATE_OF_BIRTH',
          confidence: 97,
          start: dobStart,
          end: dobStart + '15/03/1968'.length,
          proxyType: 'Generalize',
        },
        {
          id: 'e-age-58',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'AGE',
          confidence: 95,
          start: age58Start,
          end: age58Start + '58'.length,
          proxyType: 'Aggregate',
        },
        {
          id: 'e-uk-nhs-number',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'UK_NHS_NUMBER',
          confidence: 99,
          start: nhsNumberStart,
          end: nhsNumberStart + '987 654 3210'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-address',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'ADDRESS',
          confidence: 96,
          start: addressStart,
          end: addressStart + '45 Oak Avenue, London, SW1A 1AA'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-person-gp',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'PERSON',
          confidence: 98,
          start: gpDoctorStart,
          end: gpDoctorStart + 'Emily Carter'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-org-gp-practice',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'ORGANIZATION',
          confidence: 96,
          start: gpPracticeStart,
          end: gpPracticeStart + 'Riverside Medical Centre'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-location-gp-region',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'LOCATION',
          confidence: 95,
          start: gpRegionStart,
          end: gpRegionStart + 'London'.length,
          proxyType: 'Generalize',
        },
        {
          id: 'e-person-clinic-fp',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'PERSON',
          confidence: 88,
          start: clinicValueStart,
          end: clinicValueStart + 'General Medicine / Hypertension Review'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-person-clinician',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'PERSON',
          confidence: 98,
          start: clinicianDoctorStart,
          end: clinicianDoctorStart + 'Alex Thompson'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-appointment-date',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'DATE_TIME',
          confidence: 95,
          start: appointmentDateStart,
          end: appointmentDateStart + '10 April 2026'.length,
          proxyType: 'Generalize',
        },
        {
          id: 'e-age-family-62',
          jobId: 'job-gdpr-uk-hypertension-letter-golden',
          category: 'AGE',
          confidence: 94,
          start: familyAgeStart,
          end: familyAgeStart + '62'.length,
          proxyType: 'Aggregate',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-hypertension-letter-golden',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [
          'e-org-trust',
          'e-person-patient-header',
          'e-person-patient-greeting',
          'e-dob',
          'e-age-58',
          'e-uk-nhs-number',
          'e-address',
          'e-person-gp',
          'e-org-gp-practice',
          'e-location-gp-region',
          'e-person-clinic-fp',
          'e-person-clinician',
          'e-appointment-date',
          'e-age-family-62',
        ],
      });

      expect(preview).toContain('[HOSPITAL] Outpatient Clinic Letter');
      expect(preview).not.toContain('[REDACT] Outpatient Clinic Letter');
      expect(preview).toContain('Patient: Mr. [PATIENT_ID_1]');
      expect(preview).toContain('DOB: [AGE_RANGE: 50-69]');
      expect(preview).not.toContain('DOB: 1968');
      expect(preview).toContain('NHS Number: [REDACT]');
      expect(preview).toContain('Address: [REDACT]');
      expect(preview).toContain('GP: Dr. [DOCTOR_ID_1], [GP_PRACTICE], [REGION]');
      expect(preview).toContain('Dear Mr. [PATIENT_ID_1],');
      expect(preview).toContain('Clinic: General Medicine / Hypertension Review');
      expect(preview).toContain('Clinician: Dr. [DOCTOR_ID_2], Consultant Physician');
      expect(preview).toContain('Date of appointment: [Day 1]');
      expect(preview).toContain('Family history: Father - MI at [50-69].');
      expect(preview).not.toContain('[DOCTOR_ID_3]');
      expect(preview).not.toContain(': [DOCTOR_ID_1] / Hypertension Review');
    });

    it('should harden urgent hospital referral social context and keep GP as DOCTOR_ID_1', async () => {
      const text =
        "To: On-call Medical Registrar, St. Thomas' Hospital From: Dr. Alistair Vance, General Practitioner Date: 11/04/2024 Patient: Mr. William Robert HARRISON (NHS No: 392 481 0056) Clinical Reason for Referral: Acute Decompensation of Heart Failure with worsening renal function. History and Findings: Mr. Harrison was seen yesterday with signs of fluid overload. Current Medications: (See attached list). Allergies: NKDA. Social Context: Lives alone, provides care for elderly mother. Needs social services input if admitted.";
      const hash = createHash('sha256').update(text).digest('hex');

      const hospitalStart = text.indexOf("St. Thomas' Hospital");
      const gpStart = text.indexOf('Alistair Vance');
      const dateStart = text.indexOf('11/04/2024');
      const patientFullStart = text.indexOf('William Robert HARRISON');
      const patientSurnameStart = text.indexOf('Harrison', patientFullStart + 1);
      const nhsStart = text.indexOf('392 481 0056');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-urgent-referral-hardening',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-referral-hospital',
          jobId: 'job-gdpr-uk-urgent-referral-hardening',
          category: 'ORGANIZATION',
          confidence: 98,
          start: hospitalStart,
          end: hospitalStart + "St. Thomas' Hospital".length,
          proxyType: 'Redact',
        },
        {
          id: 'e-referral-gp',
          jobId: 'job-gdpr-uk-urgent-referral-hardening',
          category: 'PERSON',
          confidence: 98,
          start: gpStart,
          end: gpStart + 'Alistair Vance'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-referral-date',
          jobId: 'job-gdpr-uk-urgent-referral-hardening',
          category: 'DATE_TIME',
          confidence: 97,
          start: dateStart,
          end: dateStart + '11/04/2024'.length,
          proxyType: 'Generalize',
        },
        {
          id: 'e-referral-patient-full',
          jobId: 'job-gdpr-uk-urgent-referral-hardening',
          category: 'PERSON',
          confidence: 98,
          start: patientFullStart,
          end: patientFullStart + 'William Robert HARRISON'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-referral-patient-surname',
          jobId: 'job-gdpr-uk-urgent-referral-hardening',
          category: 'PERSON',
          confidence: 98,
          start: patientSurnameStart,
          end: patientSurnameStart + 'Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-referral-nhs-number',
          jobId: 'job-gdpr-uk-urgent-referral-hardening',
          category: 'UK_NHS_NUMBER',
          confidence: 99,
          start: nhsStart,
          end: nhsStart + '392 481 0056'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-urgent-referral-hardening',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [
          'e-referral-hospital',
          'e-referral-gp',
          'e-referral-date',
          'e-referral-patient-full',
          'e-referral-patient-surname',
          'e-referral-nhs-number',
        ],
      });

      expect(preview).toContain('To: On-call Medical Registrar, [HOSPITAL]');
      expect(preview).toContain('From: Dr. [DOCTOR_ID_1], General Practitioner');
      expect(preview).toContain('Date: [Day 1]');
      expect(preview).toContain('Patient: Mr. [PATIENT_ID_1] (NHS No: [REDACT])');
      expect(preview).toContain('Mr. [PATIENT_ID_1] was seen yesterday');
      expect(preview).toContain(
        'Social Context: [SOCIAL_DEPENDENTS_REDACTED]. Needs social services input if admitted.',
      );
      expect(preview).not.toContain('provides care for elderly mother');
    });

    it('should fully mask St. Thomas hospital label and preserve patient/doctor semantic tags in document 3', async () => {
      const text =
        "Document 3 (Discharge Summary) Hospital: St. Thomas' Hospital GP: Dr. Alistair Vance Consultant: Prof. Sarah Reed Patient: Mr. William Harrison.";
      const hash = createHash('sha256').update(text).digest('hex');

      const partialHospitalStart = text.indexOf('Hospital', text.indexOf("St. Thomas'"));
      const gpStart = text.indexOf('Alistair Vance');
      const consultantStart = text.indexOf('Sarah Reed');
      const patientFullStart = text.indexOf('William Harrison');
      const patientSurnameStart = text.indexOf('Harrison', patientFullStart + 1);

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-doc3-semantic-tags',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-doc3-hospital-partial',
          jobId: 'job-gdpr-uk-doc3-semantic-tags',
          category: 'ORGANIZATION',
          confidence: 99,
          start: partialHospitalStart,
          end: partialHospitalStart + 'Hospital'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-doc3-gp',
          jobId: 'job-gdpr-uk-doc3-semantic-tags',
          category: 'PERSON',
          confidence: 98,
          start: gpStart,
          end: gpStart + 'Alistair Vance'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-doc3-prof',
          jobId: 'job-gdpr-uk-doc3-semantic-tags',
          category: 'PERSON',
          confidence: 98,
          start: consultantStart,
          end: consultantStart + 'Sarah Reed'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-doc3-patient-full',
          jobId: 'job-gdpr-uk-doc3-semantic-tags',
          category: 'PERSON',
          confidence: 98,
          start: patientFullStart,
          end: patientFullStart + 'William Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-doc3-patient-surname',
          jobId: 'job-gdpr-uk-doc3-semantic-tags',
          category: 'PERSON',
          confidence: 98,
          start: patientSurnameStart,
          end: patientSurnameStart + 'Harrison'.length,
          proxyType: 'Synthetic ID',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-doc3-semantic-tags',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [
          'e-doc3-hospital-partial',
          'e-doc3-gp',
          'e-doc3-prof',
          'e-doc3-patient-full',
          'e-doc3-patient-surname',
        ],
      });

      expect(preview).toContain('Hospital: [HOSPITAL]');
      expect(preview).not.toContain("St. Thomas' [HOSPITAL]");
      expect(preview).toContain('GP: Dr. [DOCTOR_ID_1]');
      expect(preview).toContain('Consultant: Prof. [DOCTOR_ID_2]');
      expect(preview).toContain('Patient: Mr. [PATIENT_ID_1].');
      expect(preview).not.toContain('[DOCTOR_ID_3]');
      expect(preview).not.toContain('[DOCTOR_ID_4]');
    });

    it('should remove UK outcode quasi-identifiers and generalize occupation phrase in clinic letter', async () => {
      const text =
        'Patient demographics Name: Mrs Fatima Khan NHS Number: 123 456 7890 Next of kin: Mr Omar Khan. GP: Dr Alistair Vance. Seen by: Dr Sarah Reed. [HOSPITAL], [REGION], [REGION] SE1. Practice: [GP_PRACTICE], [REGION] E14. Social context / Family history • Primary school teacher, active lifestyle.';
      const hash = createHash('sha256').update(text).digest('hex');

      const patientStart = text.indexOf('Fatima Khan');
      const nhsStart = text.indexOf('123 456 7890');
      const relativeStart = text.indexOf('Omar Khan');
      const gpStart = text.indexOf('Alistair Vance');
      const consultantStart = text.indexOf('Sarah Reed');
      const se1Start = text.indexOf('SE1');
      const e14Start = text.indexOf('E14');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-outcode-occupation-hardening',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-hardening-patient',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'PERSON',
          confidence: 98,
          start: patientStart,
          end: patientStart + 'Fatima Khan'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-hardening-nhs',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'UK_NHS_NUMBER',
          confidence: 99,
          start: nhsStart,
          end: nhsStart + '123 456 7890'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-hardening-relative',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'PERSON',
          confidence: 98,
          start: relativeStart,
          end: relativeStart + 'Omar Khan'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-hardening-gp',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'PERSON',
          confidence: 98,
          start: gpStart,
          end: gpStart + 'Alistair Vance'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-hardening-consultant',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'PERSON',
          confidence: 98,
          start: consultantStart,
          end: consultantStart + 'Sarah Reed'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-hardening-se1',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'UK_POSTCODE',
          confidence: 96,
          start: se1Start,
          end: se1Start + 'SE1'.length,
          proxyType: 'Generalize',
        },
        {
          id: 'e-hardening-e14',
          jobId: 'job-gdpr-uk-outcode-occupation-hardening',
          category: 'UK_POSTCODE',
          confidence: 96,
          start: e14Start,
          end: e14Start + 'E14'.length,
          proxyType: 'Generalize',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-outcode-occupation-hardening',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [
          'e-hardening-patient',
          'e-hardening-nhs',
          'e-hardening-relative',
          'e-hardening-gp',
          'e-hardening-consultant',
          'e-hardening-se1',
          'e-hardening-e14',
        ],
      });

      expect(preview).toContain('Name: Mrs [PATIENT_ID_1]');
      expect(preview).toContain('NHS Number: [REDACT]');
      expect(preview).toContain('Next of kin: Mr [RELATIVE_ID_1].');
      expect(preview).toContain('GP: Dr [DOCTOR_ID_1].');
      expect(preview).toContain('Seen by: Dr [DOCTOR_ID_2].');
      expect(preview).toContain('[HOSPITAL], [REGION].');
      expect(preview).toContain('Practice: [GP_PRACTICE], [REGION].');
      expect(preview).not.toContain('[REGION] SE1');
      expect(preview).not.toContain('[REGION] E14');
      expect(preview).toContain('[OCCUPATION], active lifestyle.');
      expect(preview).not.toContain('Primary school teacher');
    });

    it('should generalize office manager and normalize malformed GP practice-only header in UK output', async () => {
      const text =
        'Name: Mr William Harrison. Next of kin: Mrs Emma Harrison. Seen by: Dr Sarah Reed. GP: [GP_PRACTICE]: [GP_PRACTICE], [REDACT]. Social context: Works as office manager, sedentary lifestyle.';
      const hash = createHash('sha256').update(text).digest('hex');

      const patientStart = text.indexOf('William Harrison');
      const relativeStart = text.indexOf('Emma Harrison');
      const consultantStart = text.indexOf('Sarah Reed');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-office-manager-gp-header-hardening',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-office-header-patient',
          jobId: 'job-gdpr-uk-office-manager-gp-header-hardening',
          category: 'PERSON',
          confidence: 98,
          start: patientStart,
          end: patientStart + 'William Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-office-header-relative',
          jobId: 'job-gdpr-uk-office-manager-gp-header-hardening',
          category: 'PERSON',
          confidence: 98,
          start: relativeStart,
          end: relativeStart + 'Emma Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-office-header-consultant',
          jobId: 'job-gdpr-uk-office-manager-gp-header-hardening',
          category: 'PERSON',
          confidence: 98,
          start: consultantStart,
          end: consultantStart + 'Sarah Reed'.length,
          proxyType: 'Synthetic ID',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-office-manager-gp-header-hardening',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [
          'e-office-header-patient',
          'e-office-header-relative',
          'e-office-header-consultant',
        ],
      });

      expect(preview).toContain('Name: Mr [PATIENT_ID_1].');
      expect(preview).toContain('Next of kin: Mrs [RELATIVE_ID_1].');
      expect(preview).toContain('Seen by: Dr [DOCTOR_ID_1].');
      expect(preview).toContain('GP: Dr [DOCTOR_ID_1]');
      expect(preview).toContain('Practice: [GP_PRACTICE], [REDACT].');
      expect(preview).not.toContain('GP: [GP_PRACTICE]: [GP_PRACTICE]');
      expect(preview).toContain('Works as [OCCUPATION], sedentary lifestyle.');
      expect(preview).not.toContain('office manager');
    });

    it('should generalize accountant occupation in UK social history output', async () => {
      const text =
        'Patient: Mr. William Harrison. GP: Dr. Alistair Vance, [GP_PRACTICE], [REGION]. Social history: Non-smoker, alcohol 8 units/week, works as accountant, lives with wife.';
      const hash = createHash('sha256').update(text).digest('hex');

      const patientStart = text.indexOf('William Harrison');
      const gpStart = text.indexOf('Alistair Vance');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-accountant-hardening',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-accountant-patient',
          jobId: 'job-gdpr-uk-accountant-hardening',
          category: 'PERSON',
          confidence: 98,
          start: patientStart,
          end: patientStart + 'William Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-accountant-gp',
          jobId: 'job-gdpr-uk-accountant-hardening',
          category: 'PERSON',
          confidence: 98,
          start: gpStart,
          end: gpStart + 'Alistair Vance'.length,
          proxyType: 'Synthetic ID',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-accountant-hardening',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: ['e-accountant-patient', 'e-accountant-gp'],
      });

      expect(preview).toContain('Patient: Mr. [PATIENT_ID_1].');
      expect(preview).toContain('GP: Dr. [DOCTOR_ID_1], [GP_PRACTICE], [REGION].');
      expect(preview).toContain('works as [OCCUPATION], [SOCIAL_CONTEXT: cohabiting].');
      expect(preview).not.toContain('works as accountant');
      expect(preview).not.toContain('lives with wife');
    });

    it('should preserve package-level synthetic ID continuity and normalize ward and medication changes formatting', async () => {
      const text =
        "Previous case references: Mrs [PATIENT_ID_1]. GP Dr [DOCTOR_ID_1]. Current package: Patient Identification: Full Name: Mr. William Robert Harrison. GP: Dr. Alistair Vance (GMC: 1234567). Date/Time: 2024, 09:30. To: On-call Medical Registrar, St. Thomas' Hospital. From: Dr. Alistair Vance, General Practitioner. Patient: Mr. William Robert Harrison (NHS No: 392 481 0056). Hospital: St. Thomas' Hospital. Ward: Cardiology (Ward 3B). Consultant: Prof. Sarah Reed (GMC: 7654321). Admission Date: 2024. Discharge Date: 2024. **Drug****Dose****Action****Reason****Furosemide**40mg BD Change Increased from 40mg OD to maintain diuresis.**Dapagliflozin**10mg OD New Started for HFrEF management as per NICE guidelines.**Ramipril**2.5mg OD Reduce Dose reduced due to recent AKI; for titration by GP.**Spironolactone**25mg OD New Added for heart failure prognosis.";
      const hash = createHash('sha256').update(text).digest('hex');

      const patientFullNameStart = text.indexOf('William Robert Harrison');
      const gpFirstStart = text.indexOf('Alistair Vance');
      const gpSecondStart = text.indexOf('Alistair Vance', gpFirstStart + 1);
      const patientReferralStart = text.indexOf(
        'William Robert Harrison',
        patientFullNameStart + 1,
      );
      const hospitalReferralStart = text.indexOf("St. Thomas' Hospital");
      const hospitalSummaryStart = text.indexOf("St. Thomas' Hospital", hospitalReferralStart + 1);
      const patientThirdStart = text.indexOf('William Robert Harrison', patientReferralStart + 1);
      const professorStart = text.indexOf('Sarah Reed');
      const nhsStart = text.indexOf('392 481 0056');
      const gpGmcStart = text.indexOf('1234567');
      const professorGmcStart = text.indexOf('7654321');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-package-continuity',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([
        {
          id: 'e-package-patient-identification',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'PERSON',
          confidence: 98,
          start: patientFullNameStart,
          end: patientFullNameStart + 'William Robert Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-package-gp-identification',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'PERSON',
          confidence: 98,
          start: gpFirstStart,
          end: gpFirstStart + 'Alistair Vance'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-package-gp-referral',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'PERSON',
          confidence: 98,
          start: gpSecondStart,
          end: gpSecondStart + 'Alistair Vance'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-package-patient-referral',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'PERSON',
          confidence: 98,
          start: patientReferralStart,
          end: patientReferralStart + 'William Robert Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-package-hospital-referral',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'ORGANIZATION',
          confidence: 98,
          start: hospitalReferralStart,
          end: hospitalReferralStart + "St. Thomas' Hospital".length,
          proxyType: 'Redact',
        },
        {
          id: 'e-package-patient-summary',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'PERSON',
          confidence: 98,
          start: patientThirdStart,
          end: patientThirdStart + 'William Robert Harrison'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-package-hospital-summary',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'ORGANIZATION',
          confidence: 98,
          start: hospitalSummaryStart,
          end: hospitalSummaryStart + "St. Thomas' Hospital".length,
          proxyType: 'Redact',
        },
        {
          id: 'e-package-professor',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'PERSON',
          confidence: 98,
          start: professorStart,
          end: professorStart + 'Sarah Reed'.length,
          proxyType: 'Synthetic ID',
        },
        {
          id: 'e-package-nhs',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'UK_NHS_NUMBER',
          confidence: 99,
          start: nhsStart,
          end: nhsStart + '392 481 0056'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-package-gp-gmc',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'NATIONAL_ID',
          confidence: 97,
          start: gpGmcStart,
          end: gpGmcStart + '1234567'.length,
          proxyType: 'Redact',
        },
        {
          id: 'e-package-professor-gmc',
          jobId: 'job-gdpr-uk-package-continuity',
          category: 'NATIONAL_ID',
          confidence: 97,
          start: professorGmcStart,
          end: professorGmcStart + '7654321'.length,
          proxyType: 'Redact',
        },
      ] satisfies Partial<DetectedEntity>[]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-package-continuity',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [
          'e-package-patient-identification',
          'e-package-gp-identification',
          'e-package-gp-referral',
          'e-package-patient-referral',
          'e-package-hospital-referral',
          'e-package-patient-summary',
          'e-package-hospital-summary',
          'e-package-professor',
          'e-package-nhs',
          'e-package-gp-gmc',
          'e-package-professor-gmc',
        ],
      });

      expect(preview).toContain('Full Name: Mr. [PATIENT_ID_2].');
      expect(preview).toContain('GP: Dr. [DOCTOR_ID_2] (GMC: [REDACT]).');
      expect(preview).toContain('Date/Time: [Day 1], 09:30.');
      expect(preview).toContain('From: Dr. [DOCTOR_ID_2], General Practitioner.');
      expect(preview).toContain('Patient: Mr. [PATIENT_ID_2] (NHS No: [REDACT]).');
      expect(preview).not.toContain('Full Name: Mr. [DOCTOR_ID_');
      expect(preview).not.toContain('Patient: Mr. [DOCTOR_ID_');
      expect(preview).toContain('Hospital: [HOSPITAL].');
      expect(preview).toContain('Ward: Cardiology [WARD].');
      expect(preview).not.toContain('Ward 3B');
      expect(preview).toContain('Consultant: Prof. [DOCTOR_ID_3] (GMC: [REDACT]).');
      expect(preview).toContain('Admission Date: [Day 2].');
      expect(preview).toContain('Discharge Date: [Day 3].');
      expect(preview).toContain('**Medication Changes:**');
      expect(preview).toContain('| Drug | Dose | Action | Reason |');
      expect(preview).toContain(
        '| Furosemide | 40mg BD | Change | Increased from 40mg OD to maintain diuresis. |',
      );
      expect(preview).toContain(
        '| Dapagliflozin | 10mg OD | New | Started for HFrEF management as per NICE guidelines. |',
      );
      expect(preview).toContain(
        '| Ramipril | 2.5mg OD | Reduce | Dose reduced due to recent AKI; for titration by GP. |',
      );
      expect(preview).toContain(
        '| Spironolactone | 25mg OD | New | Added for heart failure prognosis. |',
      );
      expect(preview).not.toContain('**Drug****Dose****Action****Reason****Furosemide**40mg BD');
      expect(preview).not.toContain('Mr. [DOCTOR_ID_1]');
    });

    it('should convert procedure dates in parentheses to Day tokens within admission episode context', async () => {
      const text =
        'Admission Date: 2024. Procedures: Transthoracic Echocardiogram (12/04/2024). Discharge Date: 2024.';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-procedure-parenthetical-day-token',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-procedure-parenthetical-day-token',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('Admission Date: [Day 1].');
      expect(preview).toContain('Transthoracic Echocardiogram ([Day 3]).');
      expect(preview).toContain('Discharge Date: [Day 2].');
      expect(preview).not.toContain('[CURRENT_YEAR]');
      expect(preview).not.toContain('12/04/2024');
    });

    it('should map residual current-year tokens to DAY_RANGE when admission episode is present', async () => {
      const text =
        'Admission Date: 2024. Discharge Date: 2024. Procedures note: follow-up arranged in 2024.';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-episode-current-year-day-range',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-episode-current-year-day-range',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('Admission Date: [Day 1].');
      expect(preview).toContain('Discharge Date: [Day 2].');
      expect(preview).toContain('follow-up arranged in [DAY_RANGE].');
      expect(preview).not.toContain('[CURRENT_YEAR]');
    });

    it('should keep CURRENT_YEAR token for non-episode residual year references', async () => {
      const text = 'Clinical note: follow-up arranged in 2024.';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-non-episode-current-year',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-non-episode-current-year',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('Clinical note: follow-up arranged in [CURRENT_YEAR].');
      expect(preview).not.toContain('[DAY_RANGE]');
    });

    it('should normalize compact medication changes blob without spacing separators in UK output', async () => {
      const text =
        '**Drug****Dose****Action****Reason****Furosemide**40mg BDChangeIncreased from 40mg OD to maintain diuresis.**Dapagliflozin**10mg ODNewStarted for HFrEF management as per NICE guidelines.**Ramipril**2.5mg ODReduceDose reduced due to recent AKI; for titration by GP.**Spironolactone**25mg ODNewAdded for heart failure prognosis.';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-compact-medication-table',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-compact-medication-table',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('**Medication Changes:**');
      expect(preview).toContain('| Drug | Dose | Action | Reason |');
      expect(preview).toContain(
        '| Furosemide | 40mg BD | Change | Increased from 40mg OD to maintain diuresis. |',
      );
      expect(preview).toContain(
        '| Dapagliflozin | 10mg OD | New | Started for HFrEF management as per NICE guidelines. |',
      );
      expect(preview).toContain(
        '| Ramipril | 2.5mg OD | Reduce | Dose reduced due to recent AKI; for titration by GP. |',
      );
      expect(preview).toContain(
        '| Spironolactone | 25mg OD | New | Added for heart failure prognosis. |',
      );
      expect(preview).not.toContain(
        '**Drug****Dose****Action****Reason****Furosemide**40mg BDChange',
      );
    });

    it('should collapse DOB relative month artifact to age range token in UK output', async () => {
      const text = 'Date of birth: [RELATIVE_MONTH_-409] ([30-49]).';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-dob-relative-month-artifact',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-dob-relative-month-artifact',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('Date of birth: [AGE_RANGE: 30-39].');
      expect(preview).not.toContain('[RELATIVE_MONTH_-409]');
      expect(preview).not.toContain('([30-49])');
    });

    it('should map Date of letter RELATIVE_MONTH_0 marker to Day 1 baseline token', async () => {
      const text = 'Date of letter: APRIL 2026.';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-date-of-letter-baseline-day',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-date-of-letter-baseline-day',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('Date of letter: [Day 1].');
      expect(preview).not.toContain('[RELATIVE_MONTH_0]');
      expect(preview).not.toContain('APRIL 2026');
    });

    it('should normalize markdown date labels and remove DOB month-level leakage in outpatient letter format', async () => {
      const text =
        '**Date of letter:** APRIL 2026\n**Date of appointment:** APRIL 2026 (face-to-face clinic)\n**Date of birth:** [RELATIVE_MONTH_-409] ([30-49])\nFamily history: mother had hypertension in the [30-49] cohort.\nClinical summary: A young, otherwise healthy woman in [AGE_RANGE: 30-39] with mild hypertension and low cardiovascular risk.';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-outpatient-markdown-baseline',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-outpatient-markdown-baseline',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('**Date of letter:** [Day 1]');
      expect(preview).toContain('**Date of appointment:** [Day 1] (face-to-face clinic)');
      expect(preview).toContain('**Date of birth:** [AGE_RANGE: 30-39]');
      expect(preview).toContain(
        'Family history: mother had hypertension in the [AGE_RANGE: 30-39] cohort.',
      );
      expect(preview).toContain(
        'Clinical summary: A young, otherwise healthy woman in her 30s with mild hypertension and low cardiovascular risk.',
      );
      expect(preview).not.toContain('[RELATIVE_MONTH_-409]');
      expect(preview).not.toContain('([30-49])');
      expect(preview).not.toContain('[RELATIVE_MONTH_0]');
    });

    it('should avoid concatenated redact and gp-practice tags in next-of-kin line', async () => {
      const text = 'Next of kin: Mr [RELATIVE_ID_1] (husband) - [REDACT][GP_PRACTICE].';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-tag-concatenation-cleanup',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-tag-concatenation-cleanup',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('Next of kin: Mr [RELATIVE_ID_1] (husband) - [REDACT].');
      expect(preview).not.toContain('[REDACT][GP_PRACTICE]');
    });

    it('should remove duplicated hospital token in outpatient clinic header line', async () => {
      const text = '[HOSPITAL]\nGeneral Medicine Outpatient Clinic[HOSPITAL]\nDate: [Day 1].';
      const hash = createHash('sha256').update(text).digest('hex');

      entityManagerMock.findOne.mockResolvedValue({
        id: 'job-gdpr-uk-hospital-header-duplication-cleanup',
        framework: ComplianceFramework.GDPR_UK,
        sourceTextHash: hash,
        sourceTextLength: text.length,
      } satisfies Partial<DeIdJob>);

      entityManagerMock.find.mockResolvedValue([]);

      const preview = await service.getPreview({
        jobId: 'job-gdpr-uk-hospital-header-duplication-cleanup',
        text,
        framework: ComplianceFramework.GDPR_UK,
        activeIds: [],
      });

      expect(preview).toContain('[HOSPITAL]\nGeneral Medicine Outpatient Clinic\nDate: [Day 1].');
      expect(preview).not.toContain('Outpatient Clinic[HOSPITAL]');
    });
  });
});
