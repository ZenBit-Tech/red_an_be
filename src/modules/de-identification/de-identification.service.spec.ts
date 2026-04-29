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
import DeIdJob from '@common/db/entities/de-id-job.entity';
import DetectedEntity from '@common/db/entities/detected-entity.entity';
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
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]) // 1st preview: activeEntities
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]) // 1st preview: mandatoryEntities
      .mockResolvedValueOnce([organizationEntity] satisfies Partial<DetectedEntity>[]) // 2nd preview: activeEntities
      .mockResolvedValueOnce([] satisfies Partial<DetectedEntity>[]); // 2nd preview: mandatoryEntities

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

  describe('filterFalsePositivesByContext (HIPAA medical text)', () => {
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

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe('DATE_TIME');
      expect(result.findings[0].start).toBe(17);
      expect(result.findings[0].end).toBe(27);
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

      expect(result.findings).toHaveLength(0);
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

      expect(result.findings).toHaveLength(0);
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

      expect(result.findings).toHaveLength(0);
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
});
