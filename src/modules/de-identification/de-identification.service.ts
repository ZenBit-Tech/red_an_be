import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EntityManager, In } from 'typeorm';

import {
  ComplianceFramework,
  DE_ID_CONFIG,
  DE_ID_EXTERNAL_RECOGNIZERS_ENV,
  DE_ID_POST_VALIDATION_ENV,
  DE_ID_REMOTE_NLP_ENV,
  DeIdMethod,
} from '@common/constants/compliance.constants';
import DeIdJob, { DeIdJobStatus } from '@db/entities/de-id-job.entity';
import DetectedEntity from '@db/entities/detected-entity.entity';
import { shouldKeepOriginalByContext } from './context/context-aware.util';
import { normalizeAnonymizedText } from './context/normalization.util';
import { PhiLeakDetectedError, ValidationOptions, validatePhi } from './context/phi-validator.util';

import { AnalyzeRequestDto, PreviewRequestDto } from './dto/request.dto';
import PresidioClient from './presidio.client';
import RemoteNlpClient, { type RemoteNlpHealthStatus } from './remote-nlp.client';
import {
  CLINICAL_NLP_ENTITY_TYPES,
  DEFAULT_ENTITY_STRATEGY,
  SENSITIVE_CATEGORIES_ENTITY_TYPES,
  type ExternalRecognizersConfig,
  type PresidioOperator,
  getAnalyzableEntities,
  getComplianceStrategy,
} from './strategies/compliance.strategy';
import {
  GDPR_EU_ANALYZER_ALLOW_LIST,
  HIPAA_ANALYZER_ALLOW_LIST,
  MEDICAL_ALLOWLIST,
  isInMedicalAllowlist,
} from './recognizers/custom-recognizers.config';

const LOCATION_CONTEXT_KEYWORDS = [
  'address',
  'street',
  'city',
  'state',
  'zip',
  'country',
  'located',
  'lives',
  'resides',
];

const PHYSICAL_EXAM_CONTEXT_KEYWORDS = [
  'physical exam',
  'exam:',
  'vitals',
  'vital signs',
  // with colon (structured records or headers)
  'bp:',
  'bp :',
  'hr:',
  'hr :',
  'temp:',
  'temp :',
  'rr:',
  'spo2:',
  'o2 sat',
  'weight:',
  'height:',
  'bmi:',
  // without colon (inline record, e.g., "BP 120/80, HR 88, RR 18")
  ' bp ',
  ' hr ',
  ' rr ',
  ' spo2 ',
  ' bmi ',
  // section headers
  'vital signs:',
  'vs:',
  'vitals:',
];

const AGE_CONTEXT_KEYWORDS = [
  'age',
  'age:',
  'aged',
  'years old',
  'year-old',
  'yr-old',
  'yo',
  'y/o',
  'y.o.', // medical abbreviations
];
const DATE_TIME_CONTEXT_KEYWORDS = [
  'consultation',
  'visit',
  'appointment',
  'discharge',
  'admission',
  'issue',
  'issued',
];
const STRUCTURED_FIELD_LABELS = [
  'Clinic',
  'Date of Service',
  'Provider',
  'Patient Name',
  'Name',
  'DOB',
  'Date of Birth',
  'SSN',
  'MRN',
  'Gender',
  'Sex',
  'Address',
  'Phone',
  'Contact',
  'Chief Complaint',
  'History of Present Illness',
  'Past Medical History',
  'Past Surgical History',
  'Current Medications',
  'Allergies',
  'Social History',
  'Family History',
  'Review of Systems',
  'Vital Signs',
  'Physical Exam',
  'Assessment',
  'Plan',
  'Encounter Summary',
] as const;
const FIELD_MARKER_BOUNDARY_PATTERN = new RegExp(
  `\\b(?:${STRUCTURED_FIELD_LABELS.join('|')})\\s*:`,
  'i',
);
const SOFT_BOUNDARY_FIELD_LABELS = [
  'Clinic',
  'Date of Service',
  'Provider',
  'Patient Name',
  'DOB',
  'Date of Birth',
  'SSN',
  'MRN',
  'Gender',
  'Sex',
  'Address',
  'Phone',
  'Contact',
] as const;
const FIELD_LABEL_SOFT_BOUNDARY_PATTERN = new RegExp(
  `\\s+(?:${SOFT_BOUNDARY_FIELD_LABELS.join('|')})\\b:?`,
  'i',
);
const GENDER_TAIL_BOUNDARY_PATTERN =
  /^(?:Address|Phone|Contact|DOB|Date of Birth|SSN|MRN|Provider|Patient Name)\b:?/i;
const NON_PHI_GENDER_VALUE_PATTERN = /^(?:male|female|other|unknown|non-binary|nonbinary|m|f)$/i;
const ORGANIZATION_ENTITY_TYPE = 'ORGANIZATION';
const ABSOLUTE_DATE_PATTERN = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b/;
const CLINIC_HEADER_ORGANIZATION_PATTERN =
  /\bClinic:\s*([A-Z][A-Za-z.&-]+(?:\s+[A-Z][A-Za-z.&-]+){0,3}\s+Primary\s+Care\s+Associates)\b/g;
const HIGH_RISK_FACILITY_ORGANIZATION_PATTERN =
  /\b((?:Charit(?:e|\u00e9)\s*(?:–|-|,)\s*Universit(?:aets|ats|\u00e4ts)?medizin\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})|(?:Charit(?:e|\u00e9)\b(?!\s*(?:–|-|,)\s*Universit(?:aets|ats|\u00e4ts)?medizin\b))|(?:Universit(?:aets|ats|\u00e4ts)?medizin\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})|(?:Klinikum\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})|(?:Krankenhaus\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}))\b/gi;
const ITALIAN_CODICE_FISCALE_PATTERN = /\b[A-Z]{6,7}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
const ITALIAN_CODICE_FISCALE_LABEL_PATTERN =
  /\b(?:Codice\s+Fiscale|CF|Tax\s*Code)\s*:\s*([A-Z0-9]{11,20})\b/gi;
const GERMAN_KV_NUMBER_PATTERN = /\b[A-Z]\d{9}\b/gi;
const GERMAN_KV_NUMBER_LABEL_PATTERN =
  /\b(?:KV(?:-?Nr\.?|\s*No\.?)|Krankenversichertennummer|Versichertennummer|Insurance\s*No\.?)\s*:\s*([A-Z]\d{9})\b/gi;
const STRUCTURED_DOB_LABEL_PATTERN = /\b(?:DOB|Date\s+of\s+Birth)\s*:\s*/gi;
const STRUCTURED_ISSUE_DATE_LABEL_PATTERN =
  /\b(?:Date\s+of\s+Issue|Issue\s+Date|Issued(?:\s+on)?)\s*:\s*/gi;
const OCCUPATION_WORKS_AS_LABEL_PATTERN = /\b(?:works|worked|employed|serves)\s+as\s+(?:an?\s+)?/gi;
const OCCUPATION_FIELD_LABEL_PATTERN = /\b(?:Occupation|Profession|Employment|Job)\s*:\s*/gi;
const OCCUPATION_SOCIAL_HISTORY_LABEL_PATTERN = /\bSocial\s+History\s*:\s*/gi;
const OCCUPATION_SOCIAL_HISTORY_VALUE_PATTERN =
  /\b([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z-]+){0,5}\s(?:engineer|teacher|developer|programmer|nurse|physician|doctor|accountant|manager|analyst|technician|consultant|attorney|lawyer|pharmacist|therapist|scientist|designer|administrator))\b/gi;
const OCCUPATION_VALUE_PREFIX_PATTERN =
  /^([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z-]+){0,5}?)(?=\s*(?:,|;|\.|$|\b(?:married|single|divorced|widowed|with|has|have|lives|living|smokes?|drinks?|denies)\b))/i;
const STRUCTURED_DOB_VALUE_PREFIX_PATTERN =
  /^\s*(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|(?:\d{1,2}\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/i;
const TEXTUAL_MONTH_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const STRICT_DATE_TOKEN_PATTERN =
  /^\s*(?:\d{1,2}[/. -]\d{1,2}(?:[/. -]\d{2,4})?|\d{1,2}[/. -]\d{4})\s*$/;
const PHONE_LIKE_VALUE_PATTERN = /^\s*\+?\d(?:[\d\s().-]{5,}\d)?\s*$/;
const PHONE_CONTEXT_KEYWORDS = ['phone', 'contact', 'tel', 'mobile', 'cell', 'fax'] as const;
const PREVIEW_CATEGORY_PRIORITY: Readonly<Record<string, number>> = {
  PHONE_NUMBER: 120,
  EMAIL_ADDRESS: 115,
  ADDRESS: 110,
  MEDICAL_RECORD_NUMBER: 105,
  US_SSN_FULL: 105,
  NATIONAL_ID: 105,
  DATE_TIME: 80,
};
const HIGH_RISK_ENTITY_TYPES = [
  'US_SSN_FULL',
  'MEDICAL_RECORD_NUMBER',
  'US_ZIP',
  'NATIONAL_ID',
  'HEALTH_PLAN_BENEFICIARY',
];
const MANDATORY_PREVIEW_ENTITY_CATEGORIES = [
  'US_SSN_FULL',
  'MEDICAL_RECORD_NUMBER',
  'PHONE_NUMBER',
  'EMAIL_ADDRESS',
  'ADDRESS',
  'US_ZIP',
] as const;

const GDPR_MANDATORY_PREVIEW_ENTITY_CATEGORIES = [
  'PHONE_NUMBER',
  'PL_PHONE_NUMBER',
  'EMAIL_ADDRESS',
  'ADDRESS',
  'NATIONAL_ID',
  'ORGANIZATION',
  'DATE_TIME',
  'DATE_OF_BIRTH',
  'AGE',
] as const;
const DEFAULT_PHI_VALIDATION_STRICT = true;
const DEFAULT_PHI_VALIDATION_ALLOW_ZIP3 = true;
const GDPR_PHI_SKIP_PATTERN_TYPES: ReadonlyArray<string> = ['SSN', 'ZIP', 'PHONE', 'IP'] as const;
const DEFAULT_ANALYSIS_FAILURE_CODE = 'ANALYSIS_FAILED';
const MAX_ERROR_CODE_LENGTH = 120;
const US_STATE_CODES = new Set<string>([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
]);
const US_STATE_NAME_TO_CODE: Readonly<Record<string, string>> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
};

type TextChunk = {
  text: string;
  offset: number;
};

type AnalyzerFinding = {
  entity_type: string;
  start: number;
  end: number;
  score: number;
};

type PreviewSpan = {
  id: string;
  category: string;
  confidence: number;
  start: number;
  end: number;
};

type AnalyzeResult = {
  jobId: string;
  findings: DetectedEntity[];
};

type RemoteNlpHealthResult = {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  details: string;
};

@Injectable()
export default class DeIdService {
  private readonly logger = new Logger(DeIdService.name);

  constructor(
    private readonly entityManager: EntityManager,
    private readonly presidioClient: PresidioClient,
    private readonly remoteNlpClient: RemoteNlpClient,
    private readonly configService: ConfigService,
  ) {}

  public async analyzeText(dto: AnalyzeRequestDto, userUuid?: string): Promise<AnalyzeResult> {
    return this.entityManager.transaction(async (tm): Promise<AnalyzeResult> => {
      try {
        const job = tm.create(DeIdJob, {
          framework: dto.framework,
          threshold: dto.threshold,
          preserveStructure: dto.preserveStructure,
          sourceTextHash: DeIdService.calculateTextHash(dto.text),
          sourceTextLength: dto.text.length,
          userUuid: userUuid ?? null,
          status: DeIdJobStatus.SUCCESS,
          processedAt: new Date(),
          errorCode: null,
        });
        await tm.save(job);

        const chunks = DeIdService.splitIntoChunks(dto.text);
        const findingsByChunk = await Promise.all(
          chunks.map(async (chunk) => {
            const results = await this.callAnalyzerPipeline(
              chunk.text,
              dto.threshold,
              dto.framework,
              dto.includeExternalRecognizers,
            );
            return results.map((res) => ({
              ...res,
              start: res.start + chunk.offset,
              end: res.end + chunk.offset,
            }));
          }),
        );

        const deduplicatedFindings = findingsByChunk
          .flat()
          .reduce<AnalyzerFinding[]>((acc, finding) => {
            const isDuplicate = acc.some(
              (existingFinding) =>
                existingFinding.entity_type === finding.entity_type &&
                existingFinding.start === finding.start &&
                existingFinding.end === finding.end,
            );

            if (!isDuplicate) {
              acc.push(finding);
            }

            return acc;
          }, []);

        const rawFindingsCount = findingsByChunk.reduce(
          (count, chunkFindings) => count + chunkFindings.length,
          0,
        );
        const sanitizedFindings = DeIdService.sanitizeSpans(dto.text, deduplicatedFindings);
        const clinicHeaderFindings = DeIdService.extractClinicHeaderOrganizations(dto.text);
        const structuredAddressFindings = DeIdService.extractStructuredAddressFindings(dto.text);
        const structuredDobFindings = DeIdService.extractStructuredDobFindings(dto.text);
        const structuredIssueDateFindings = DeIdService.extractStructuredIssueDateFindings(
          dto.text,
        );
        const structuredNationalIdFindings = DeIdService.extractStructuredNationalIdFindings(
          dto.text,
        );
        const occupationFindings =
          dto.framework === ComplianceFramework.HIPAA
            ? DeIdService.extractOccupationFindings(dto.text)
            : [];
        const enrichedFindings = DeIdService.mergeFindings(
          DeIdService.mergeFindings(sanitizedFindings, clinicHeaderFindings),
          DeIdService.mergeFindings(
            DeIdService.mergeFindings(structuredAddressFindings, structuredDobFindings),
            DeIdService.mergeFindings(
              DeIdService.mergeFindings(structuredIssueDateFindings, structuredNationalIdFindings),
              occupationFindings,
            ),
          ),
        );

        this.logger.log(
          `Analysis pipeline counts job=${job.id} framework=${dto.framework} raw=${rawFindingsCount} deduplicated=${deduplicatedFindings.length} sanitized=${sanitizedFindings.length} clinicHeader=${clinicHeaderFindings.length} structuredAddress=${structuredAddressFindings.length} occupation=${occupationFindings.length} enriched=${enrichedFindings.length}`,
        );

        // Apply context-based filtering to reduce false positives
        const contextFilteredFindings = this.filterFalsePositivesByContext(
          dto.text,
          enrichedFindings,
        );
        const guaranteedFindings = DeIdService.mergeFindings(
          DeIdService.mergeFindings(contextFilteredFindings, clinicHeaderFindings),
          DeIdService.mergeFindings(
            DeIdService.mergeFindings(structuredAddressFindings, structuredDobFindings),
            DeIdService.mergeFindings(
              DeIdService.mergeFindings(structuredIssueDateFindings, structuredNationalIdFindings),
              occupationFindings,
            ),
          ),
        );

        this.logger.log(
          `Analysis filter result job=${job.id} kept=${guaranteedFindings.length} dropped=${Math.max(
            enrichedFindings.length - guaranteedFindings.length,
            0,
          )}`,
        );

        const entities = guaranteedFindings.map((finding) =>
          tm.create(DetectedEntity, {
            jobId: job.id,
            category: finding.entity_type,
            confidence: finding.score * 100,
            start: finding.start,
            end: finding.end,
            proxyType: DeIdService.mapToProxyType(dto.framework, finding.entity_type),
          }),
        );

        const savedEntities = await tm.save(entities);
        return { jobId: job.id, findings: savedEntities };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Analysis failed: ${message}`);
        await this.persistFailedAnalysisJob(dto, userUuid, error);
        throw new InternalServerErrorException('Failed to analyze document');
      }
    });
  }

  private async persistFailedAnalysisJob(
    dto: AnalyzeRequestDto,
    userUuid: string | undefined,
    error: unknown,
  ): Promise<void> {
    if (!('save' in this.entityManager) || typeof this.entityManager.save !== 'function') {
      return;
    }

    const errorCode = DeIdService.extractErrorCode(error);

    const failedJob = this.entityManager.create(DeIdJob, {
      framework: dto.framework,
      threshold: dto.threshold,
      preserveStructure: dto.preserveStructure,
      sourceTextHash: DeIdService.calculateTextHash(dto.text),
      sourceTextLength: dto.text.length,
      userUuid: userUuid ?? null,
      status: DeIdJobStatus.FAILED,
      processedAt: new Date(),
      errorCode,
    });

    await this.entityManager.save(failedJob).catch(() => undefined);
  }

  private static extractErrorCode(error: unknown): string {
    if (error instanceof Error) {
      const normalizedErrorName = error.name
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .toUpperCase()
        .replace(/^_+|_+$/g, '');

      if (normalizedErrorName.length > 0) {
        return normalizedErrorName.slice(0, MAX_ERROR_CODE_LENGTH);
      }
    }

    return DEFAULT_ANALYSIS_FAILURE_CODE;
  }

  public async getPreview(dto: PreviewRequestDto, userUuid?: string): Promise<string> {
    try {
      const job = await this.entityManager.findOne(DeIdJob, {
        where: userUuid ? { id: dto.jobId, userUuid } : { id: dto.jobId },
      });

      if (!job) {
        throw new BadRequestException('Invalid de-identification job id');
      }

      const textHash = DeIdService.calculateTextHash(dto.text);
      const isFrameworkMatched = job.framework === dto.framework;
      const isTextHashMatched = job.sourceTextHash === textHash;
      const isTextLengthMatched = job.sourceTextLength === dto.text.length;

      if (!isFrameworkMatched || !isTextHashMatched || !isTextLengthMatched) {
        throw new BadRequestException('Preview text does not match analyzed input');
      }

      const activeEntities = await this.entityManager.find(DetectedEntity, {
        where: { jobId: dto.jobId, id: In(dto.activeIds) },
        order: { start: 'ASC' },
      });

      const isGdprFramework =
        dto.framework === ComplianceFramework.GDPR_EU ||
        dto.framework === ComplianceFramework.GDPR_UK;
      const mandatoryCategories = isGdprFramework
        ? GDPR_MANDATORY_PREVIEW_ENTITY_CATEGORIES
        : MANDATORY_PREVIEW_ENTITY_CATEGORIES;

      const mandatoryEntities = await this.entityManager.find(DetectedEntity, {
        where: {
          jobId: dto.jobId,
          category: In([...mandatoryCategories]),
        },
        order: { start: 'ASC' },
      });

      const mergedEntitiesById = [...activeEntities, ...mandatoryEntities].reduce<
        Record<string, DetectedEntity>
      >((acc, entity) => {
        acc[entity.id] = entity;
        return acc;
      }, {});

      const strategy = getComplianceStrategy(dto.framework);
      const previewSpans = DeIdService.buildNonOverlappingPreviewSpans(
        dto.text,
        Object.values(mergedEntitiesById),
      ).sort((first, second) => second.start - first.start);

      const anonymizedText = previewSpans.reduce((resultText, span) => {
        const originalValue = dto.text.substring(span.start, span.end);

        if (
          DeIdService.shouldKeepNonPhiGenderValue(dto.text, span.category, span.start, span.end)
        ) {
          return resultText;
        }

        // Limited context-aware layer: keep clinically meaningful relative-time/date-like values.
        if (shouldKeepOriginalByContext(span.category, originalValue, dto.text, span.start)) {
          return resultText;
        }

        const entityStrategy = strategy.entities[span.category] ?? DEFAULT_ENTITY_STRATEGY;
        const replacement = DeIdService.calculateReplacement(
          originalValue,
          entityStrategy.operators,
        );
        const trailingWhitespace = originalValue.match(/\s+$/)?.[0] ?? '';
        const replacementWithSpacing =
          trailingWhitespace && !/\s$/.test(replacement)
            ? `${replacement}${trailingWhitespace}`
            : replacement;

        return (
          resultText.slice(0, span.start) + replacementWithSpacing + resultText.slice(span.end)
        );
      }, dto.text);

      const normalizedText = normalizeAnonymizedText(anonymizedText);
      const validationOptions = this.getPhiValidationOptions(dto.framework);
      const validationResult = validatePhi(normalizedText, validationOptions);

      if (!validationResult.valid) {
        this.logger.warn(
          `PHI post-validation found ${validationResult.leaks.length} potential leaks`,
        );
      }

      return normalizedText;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error instanceof PhiLeakDetectedError) {
        this.logger.warn(error.message);
        const leakTypes = [...new Set(error.leaks.map((l) => l.type))].join(', ');
        throw new UnprocessableEntityException(
          `PHI leak detected after anonymization: ${leakTypes}`,
        );
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Preview failed: ${message}`);
      throw new InternalServerErrorException('Failed to generate anonymization preview');
    }
  }

  private getPhiValidationOptions(framework?: ComplianceFramework): ValidationOptions {
    const strictConfig = this.configService.get<string>(
      DE_ID_POST_VALIDATION_ENV.PHI_VALIDATION_STRICT,
    );
    const allowZip3Config = this.configService.get<string>(
      DE_ID_POST_VALIDATION_ENV.PHI_VALIDATION_ALLOW_ZIP3,
    );

    const isGdprFramework =
      framework === ComplianceFramework.GDPR_EU || framework === ComplianceFramework.GDPR_UK;

    return {
      strict: strictConfig ? strictConfig === 'true' : DEFAULT_PHI_VALIDATION_STRICT,
      allowZip3: allowZip3Config ? allowZip3Config === 'true' : DEFAULT_PHI_VALIDATION_ALLOW_ZIP3,
      skipPatternTypes: isGdprFramework ? GDPR_PHI_SKIP_PATTERN_TYPES : undefined,
    };
  }

  public async getRemoteNlpHealth(): Promise<RemoteNlpHealthResult> {
    if (!this.remoteNlpClient.isConfigured()) {
      return {
        configured: false,
        reachable: false,
        latencyMs: null,
        details: 'Remote NLP URL is not configured',
      };
    }

    const startedAt = Date.now();

    try {
      const response: RemoteNlpHealthStatus = await this.remoteNlpClient.healthCheck();
      const latencyMs = Date.now() - startedAt;
      this.logger.log(`Remote NLP health check latency=${latencyMs}ms status=${response.status}`);

      return {
        configured: true,
        reachable: response.status === 'ok',
        latencyMs,
        details: response.status,
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Remote NLP health check failed latency=${latencyMs}ms error=${message}`);

      return {
        configured: true,
        reachable: false,
        latencyMs,
        details: message,
      };
    }
  }

  private static splitIntoChunks(text: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const step = Math.max(DE_ID_CONFIG.MAX_CHUNK_SIZE - DE_ID_CONFIG.CHUNK_OVERLAP, 1);

    for (let i = 0; i < text.length; i += step) {
      const end = Math.min(i + DE_ID_CONFIG.MAX_CHUNK_SIZE, text.length);
      chunks.push({
        text: text.slice(i, end),
        offset: i,
      });

      if (end >= text.length) {
        break;
      }
    }

    return chunks;
  }

  private static mapToProxyType(framework: ComplianceFramework, entityType: string): string {
    const strategy = getComplianceStrategy(framework);
    const primaryOperator =
      strategy.entities[entityType]?.operators[0] ?? DEFAULT_ENTITY_STRATEGY.operators[0];

    switch (primaryOperator.type) {
      case 'replace': {
        const strategyType = DeIdService.getStringParam(primaryOperator, 'strategy');

        if (strategyType === 'synthetic') {
          return DeIdMethod.SYNTHETIC;
        }

        return DeIdMethod.REPLACE;
      }
      case 'hash':
        return DeIdMethod.HASH;
      case 'mask':
      case 'keep_domain':
        return DeIdMethod.MASK;
      case 'generalize':
      case 'aggregate':
      case 'truncate':
        return DeIdMethod.GENERALIZE;
      default:
        return DeIdMethod.REDACT;
    }
  }

  private static calculateReplacement(original: string, operators: PresidioOperator[]): string {
    return operators.reduce<string>(
      (currentValue, operator) => DeIdService.applyOperator(currentValue, operator),
      original,
    );
  }

  private static applyOperator(original: string, operator: PresidioOperator): string {
    switch (operator.type) {
      case 'replace': {
        const strategyType = DeIdService.getStringParam(operator, 'strategy');

        if (strategyType === 'synthetic') {
          return '[SYNTHETIC_ID]';
        }

        const replacementValue = DeIdService.getStringParam(operator, 'value');
        return replacementValue ?? '[REPLACE]';
      }
      case 'hash':
        return `[HASH_${original.length}]`;
      case 'mask':
        return DeIdService.applyMask(original, operator);
      case 'generalize':
        return DeIdService.applyGeneralization(original, operator);
      case 'aggregate':
        return DeIdService.applyAggregation(original, operator);
      case 'truncate':
        return DeIdService.applyTruncation(original, operator);
      case 'keep_domain':
        return DeIdService.applyKeepDomain(original);
      default:
        return '[REDACT]';
    }
  }

  private static applyKeepDomain(value: string): string {
    const [localPart, domain] = value.split('@');

    if (!localPart || !domain) {
      return value;
    }

    return `${'*'.repeat(localPart.length)}@${domain}`;
  }

  private static applyMask(value: string, operator: PresidioOperator): string {
    const keepFirst = DeIdService.getNumberParam(operator, 'keepFirst');

    if (keepFirst !== undefined) {
      const prefix = value.slice(0, keepFirst);
      return `${prefix}[REDACT]`;
    }

    const charsToMask = DeIdService.getNumberParam(operator, 'chars') ?? value.length;
    const keepLast = DeIdService.getNumberParam(operator, 'keepLast') ?? 0;

    const [localPart, domain] = value.split('@');
    if (localPart && domain) {
      const visibleLocalPartLength = Math.max(localPart.length - charsToMask, 0);
      const maskedLocalPart =
        '*'.repeat(localPart.length - visibleLocalPartLength) +
        localPart.slice(localPart.length - visibleLocalPartLength);

      return `${maskedLocalPart}@${domain}`;
    }

    if (keepLast > 0) {
      const maskedLength = Math.max(value.length - keepLast, 0);
      return `${'*'.repeat(maskedLength)}${value.slice(maskedLength)}`;
    }

    const visibleLength = Math.max(value.length - charsToMask, 0);
    return `${'*'.repeat(value.length - visibleLength)}${value.slice(value.length - visibleLength)}`;
  }

  private static applyGeneralization(value: string, operator: PresidioOperator): string {
    const keep = DeIdService.getStringParam(operator, 'keep');
    const strict =
      operator.params && typeof operator.params.strict === 'boolean'
        ? operator.params.strict
        : false;
    if (keep === 'year') {
      const textualMonthYearMatch = value.match(
        /\b(?:\d{1,2}\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
      );
      if (textualMonthYearMatch) {
        return `${textualMonthYearMatch[1].toUpperCase()} ${textualMonthYearMatch[2]}`;
      }

      // strict=true only makes sense for strings that actually look like a date
      const looksLikeDate =
        /\b\d{1,2}[/.\s-]\d{1,2}[/.\s-]\d{2,4}\b/.test(value) ||
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(value);

      if (strict && looksLikeDate) {
        const yearMatch = value.match(/\b(\d{4})\b/);
        if (yearMatch) {
          const year = parseInt(yearMatch[1], 10);
          const currentYear = new Date().getFullYear();
          if (year >= 1900 && year <= currentYear) return yearMatch[1];
        }
        return '[DATE]';
      }
      // if value don`t contain digits — it is not a date, ignore
      if (!/\d/.test(value)) {
        return value; // return as is, do not replace
      }
      // number < 200 without date context — cannot be a year (HR 88, RR 18, SpO2 98)
      const trimmed = value.trim();
      if (/^\d{1,3}$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        // Less than 1900 — not a year; return as is (keep the number)
        if (num < 1900) return value;
      }
      const yearMatch = value.match(/\b(\d{4})\b/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1], 10);
        const currentYear = new Date().getFullYear();
        if (year >= 1900 && year <= currentYear) return yearMatch[1];
      }
      // There are digits, but not in year format → [YEAR] as the least destructive fallback
      return '[YEAR]';
    }

    if (keep === 'month_year') {
      const textualMonthYearMatch = value.match(
        /\b(?:\d{1,2}\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
      );
      if (textualMonthYearMatch) {
        return `${textualMonthYearMatch[1].toUpperCase()} ${textualMonthYearMatch[2]}`;
      }

      const looksLikeDate =
        STRICT_DATE_TOKEN_PATTERN.test(value) || TEXTUAL_MONTH_PATTERN.test(value);
      if (!looksLikeDate) {
        return value;
      }

      const monthYearMatch = value.match(/\b\d{1,2}[/.-]\d{4}\b/);
      return monthYearMatch ? monthYearMatch[0] : '[MONTH_YEAR]';
    }

    const level = DeIdService.getStringParam(operator, 'level');
    if (level === 'state') {
      const stateCode = DeIdService.extractUsStateCode(value);
      return stateCode ?? '[REDACT]';
    }

    if (level) {
      return `[${level.toUpperCase()}]`;
    }

    return '[GENERALIZED]';
  }

  private static extractUsStateCode(value: string): string | undefined {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return undefined;
    }

    const cityWithCodeMatch = trimmedValue.match(/,\s*([A-Za-z]{2})\b/);
    if (cityWithCodeMatch) {
      const stateCode = cityWithCodeMatch[1].toUpperCase();

      if (US_STATE_CODES.has(stateCode)) {
        return stateCode;
      }
    }

    const standaloneCodeMatch = trimmedValue.match(/^([A-Za-z]{2})$/);
    if (standaloneCodeMatch) {
      const stateCode = standaloneCodeMatch[1].toUpperCase();

      if (US_STATE_CODES.has(stateCode)) {
        return stateCode;
      }
    }

    const normalizedValue = trimmedValue
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalizedValue) {
      return undefined;
    }

    const exactStateCode = US_STATE_NAME_TO_CODE[normalizedValue];
    if (exactStateCode) {
      return exactStateCode;
    }

    const commaSeparatedParts = trimmedValue.split(',');
    if (commaSeparatedParts.length > 1) {
      const lastPart = commaSeparatedParts[commaSeparatedParts.length - 1]
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const stateCodeFromLastPart = US_STATE_NAME_TO_CODE[lastPart];

      if (stateCodeFromLastPart) {
        return stateCodeFromLastPart;
      }
    }

    return undefined;
  }

  private static applyAggregation(value: string, operator: PresidioOperator): string {
    const buckets = DeIdService.getNumberArrayParam(operator, 'buckets');
    // Extract the first integer from labeled formats like "(Age: 66)" or "Age: 66"
    const rawDigits = /\b(\d{1,3})\b/.exec(value);
    const numericValue = rawDigits ? Number.parseInt(rawDigits[1], 10) : Number.parseInt(value, 10);

    if (!Number.isFinite(numericValue) || buckets.length < 2) {
      return '[AGGREGATED]';
    }

    for (let index = 0; index < buckets.length - 1; index += 1) {
      const lowerBound = buckets[index];
      const upperBound = buckets[index + 1];

      if (numericValue >= lowerBound && numericValue < upperBound) {
        return `[${lowerBound}-${upperBound - 1}]`;
      }
    }

    const lastBucket = buckets[buckets.length - 1];
    return `[${lastBucket}+]`;
  }

  private static applyTruncation(value: string, operator: PresidioOperator): string {
    const subnet = DeIdService.getNumberParam(operator, 'subnet');
    const firstDigits = DeIdService.getNumberParam(operator, 'firstDigits');

    // ZIP: keep the first N digits, replace the rest with **
    if (firstDigits !== undefined && /^\d{5}(-\d{4})?$/.test(value)) {
      return `${value.slice(0, firstDigits)}**`;
    }

    // IP truncation
    const octets = value.split('.');
    if (subnet === 24 && octets.length === 4) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
    }

    return '[TRUNCATED]';
  }

  private static getStringParam(operator: PresidioOperator, key: string): string | undefined {
    const value = operator.params?.[key];

    if (typeof value === 'string') {
      return value;
    }

    return undefined;
  }

  private static getNumberParam(operator: PresidioOperator, key: string): number | undefined {
    const value = operator.params?.[key];

    if (typeof value === 'number') {
      return value;
    }

    return undefined;
  }

  private static getNumberArrayParam(operator: PresidioOperator, key: string): number[] {
    const value = operator.params?.[key];

    if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
      return value;
    }

    return [];
  }

  private async callAnalyzerPipeline(
    text: string,
    threshold: number,
    framework: ComplianceFramework,
    includeExternalRecognizers?: boolean,
  ): Promise<AnalyzerFinding[]> {
    const presidioResults = await this.callPresidioAnalyzer(
      text,
      threshold,
      framework,
      includeExternalRecognizers,
    );
    const sanitizedPresidioResults = DeIdService.sanitizeSpans(text, presidioResults);
    const externalConfig = this.buildExternalRecognizersConfig(includeExternalRecognizers);
    const remoteNlpEntities = DeIdService.getRemoteNlpEntities(framework, externalConfig);

    if (remoteNlpEntities.length === 0 || !this.remoteNlpClient.isConfigured()) {
      return sanitizedPresidioResults;
    }

    const startedAt = Date.now();

    try {
      const remoteNlpResults = await this.remoteNlpClient.analyze({
        text,
        threshold,
        framework,
        entities: remoteNlpEntities,
      });
      const latencyMs = Date.now() - startedAt;
      this.logger.log(
        `Remote NLP analyze latency=${latencyMs}ms entities=${remoteNlpEntities.length} findings=${remoteNlpResults.length}`,
      );

      const mergedResults = DeIdService.mergeFindings(sanitizedPresidioResults, remoteNlpResults);
      return this.filterFalsePositivesByContext(text, mergedResults);
    } catch (error: unknown) {
      const latencyMs = Date.now() - startedAt;
      const isStrictMode =
        this.configService.get<string>(DE_ID_REMOTE_NLP_ENV.STRICT_MODE) === 'true';

      if (isStrictMode) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Remote NLP unavailable latency=${latencyMs}ms, fallback to Presidio only: ${message}`,
      );
      return this.filterFalsePositivesByContext(text, sanitizedPresidioResults);
    }
  }

  private async callPresidioAnalyzer(
    text: string,
    threshold: number,
    framework: ComplianceFramework,
    includeExternalRecognizers?: boolean,
  ): Promise<AnalyzerFinding[]> {
    const strategy = getComplianceStrategy(framework);
    const externalConfig = this.buildExternalRecognizersConfig(includeExternalRecognizers);
    const analyzableEntities = getAnalyzableEntities(framework, externalConfig);
    const startedAt = Date.now();

    const findings = await this.presidioClient.analyze(
      text,
      threshold,
      analyzableEntities,
      strategy.adHocRecognizers,
      DeIdService.getAnalyzerAllowList(framework),
    );
    const latencyMs = Date.now() - startedAt;
    this.logger.log(
      `Presidio analyze latency=${latencyMs}ms entities=${analyzableEntities.length} findings=${findings.length}`,
    );

    return findings;
  }

  private static getAnalyzerAllowList(framework: ComplianceFramework): string[] {
    if (framework === ComplianceFramework.HIPAA) {
      return HIPAA_ANALYZER_ALLOW_LIST;
    }

    if (framework === ComplianceFramework.GDPR_EU) {
      return GDPR_EU_ANALYZER_ALLOW_LIST;
    }

    return [];
  }

  private static getRemoteNlpEntities(
    framework: ComplianceFramework,
    externalConfig: ExternalRecognizersConfig,
  ): string[] {
    const strategy = getComplianceStrategy(framework);
    const entityTypes = Object.keys(strategy.entities);

    return entityTypes.filter((entityType) => {
      if (externalConfig.clinicalNlpEnabled && CLINICAL_NLP_ENTITY_TYPES.has(entityType)) {
        return true;
      }

      if (
        externalConfig.sensitiveCategoriesEnabled &&
        SENSITIVE_CATEGORIES_ENTITY_TYPES.has(entityType)
      ) {
        return true;
      }

      return false;
    });
  }

  private static mergeFindings(
    baseFindings: AnalyzerFinding[],
    incomingFindings: AnalyzerFinding[],
  ): AnalyzerFinding[] {
    const sortedFindings = [...baseFindings, ...incomingFindings].sort(
      (first, second) =>
        first.start - second.start ||
        first.end - second.end ||
        second.score - first.score ||
        first.entity_type.localeCompare(second.entity_type),
    );

    return sortedFindings.reduce<AnalyzerFinding[]>((acc, finding) => {
      const overlapIndex = acc.findIndex(
        (existingFinding) =>
          existingFinding.entity_type === finding.entity_type &&
          DeIdService.hasOverlap(existingFinding, finding),
      );

      if (overlapIndex < 0) {
        acc.push(finding);
        return acc;
      }

      const existingFinding = acc[overlapIndex];
      const existingSpanLength = existingFinding.end - existingFinding.start;
      const findingSpanLength = finding.end - finding.start;
      const shouldReplaceExisting =
        finding.score > existingFinding.score ||
        (finding.score === existingFinding.score && findingSpanLength < existingSpanLength);

      if (shouldReplaceExisting) {
        acc[overlapIndex] = finding;
      }

      return acc;
    }, []);
  }

  private static sanitizeSpans(text: string, findings: AnalyzerFinding[]): AnalyzerFinding[] {
    return findings
      .map((finding) => {
        const value = text.substring(finding.start, finding.end);
        // Truncate span at the first newline — Presidio must not capture across lines
        const newlineIdx = value.indexOf('\n');
        if (newlineIdx > 0) {
          return { ...finding, end: finding.start + newlineIdx };
        }

        const markerIdx = value.search(FIELD_MARKER_BOUNDARY_PATTERN);
        if (markerIdx > 0) {
          return { ...finding, end: finding.start + markerIdx };
        }

        // Trim trailing whitespace and punctuation
        const trailingCharsMatch = value.match(/[\s,;:]+$/);
        const trailingCharsLength = trailingCharsMatch?.[0].length ?? 0;
        const trimmedEnd = finding.end - trailingCharsLength;
        return { ...finding, end: trimmedEnd };
      })
      .filter((finding) => finding.end > finding.start);
  }

  private static extractStructuredAddressFindings(text: string): AnalyzerFinding[] {
    const addressLabelPattern = /\bAddress\s*:\s*/gi;
    return Array.from(text.matchAll(addressLabelPattern))
      .map((match) => {
        if (match.index === undefined) {
          return null;
        }

        const addressStart = match.index + match[0].length;
        const tail = text.slice(addressStart);
        const boundaryMatch = tail.match(FIELD_MARKER_BOUNDARY_PATTERN);
        const rawEnd =
          boundaryMatch && boundaryMatch.index !== undefined
            ? addressStart + boundaryMatch.index
            : text.length;

        const valueChunk = text.slice(addressStart, rawEnd);
        const leadingWhitespaceLength = valueChunk.match(/^\s*/)?.[0].length ?? 0;
        const trailingWhitespaceLength = valueChunk.match(/\s*$/)?.[0].length ?? 0;
        const normalizedStart = addressStart + leadingWhitespaceLength;
        const normalizedEnd = rawEnd - trailingWhitespaceLength;

        if (normalizedEnd <= normalizedStart) {
          return null;
        }

        return {
          entity_type: 'ADDRESS',
          start: normalizedStart,
          end: normalizedEnd,
          score: 0.99,
        } satisfies AnalyzerFinding;
      })
      .filter((finding): finding is AnalyzerFinding => finding !== null);
  }

  private static extractStructuredDobFindings(text: string): AnalyzerFinding[] {
    return Array.from(text.matchAll(STRUCTURED_DOB_LABEL_PATTERN))
      .map((match) => {
        if (match.index === undefined) {
          return null;
        }

        const valueStart = match.index + match[0].length;
        const tail = text.slice(valueStart);
        const valueMatch = tail.match(STRUCTURED_DOB_VALUE_PREFIX_PATTERN);

        if (!valueMatch) {
          return null;
        }

        const rawValue = valueMatch[0];
        const leadingWhitespaceLength = rawValue.match(/^\s*/)?.[0].length ?? 0;
        const trailingWhitespaceLength = rawValue.match(/\s*$/)?.[0].length ?? 0;
        const normalizedStart = valueStart + leadingWhitespaceLength;
        const normalizedEnd = valueStart + rawValue.length - trailingWhitespaceLength;

        if (normalizedEnd <= normalizedStart) {
          return null;
        }

        return {
          entity_type: 'DATE_OF_BIRTH',
          start: normalizedStart,
          end: normalizedEnd,
          score: 0.99,
        } satisfies AnalyzerFinding;
      })
      .filter((finding): finding is AnalyzerFinding => finding !== null);
  }

  private static extractStructuredIssueDateFindings(text: string): AnalyzerFinding[] {
    return Array.from(text.matchAll(new RegExp(STRUCTURED_ISSUE_DATE_LABEL_PATTERN.source, 'gi')))
      .map((match) => {
        if (match.index === undefined) {
          return null;
        }

        const valueStart = match.index + match[0].length;
        const tail = text.slice(valueStart);
        const valueMatch = tail.match(STRUCTURED_DOB_VALUE_PREFIX_PATTERN);

        if (!valueMatch) {
          return null;
        }

        const rawValue = valueMatch[0];
        const leadingWhitespaceLength = rawValue.match(/^\s*/)?.[0].length ?? 0;
        const trailingWhitespaceLength = rawValue.match(/\s*$/)?.[0].length ?? 0;
        const normalizedStart = valueStart + leadingWhitespaceLength;
        const normalizedEnd = valueStart + rawValue.length - trailingWhitespaceLength;

        if (normalizedEnd <= normalizedStart) {
          return null;
        }

        return {
          entity_type: 'DATE_TIME',
          start: normalizedStart,
          end: normalizedEnd,
          score: 0.99,
        } satisfies AnalyzerFinding;
      })
      .filter((finding): finding is AnalyzerFinding => finding !== null);
  }

  private static extractStructuredNationalIdFindings(text: string): AnalyzerFinding[] {
    const italianLabelPattern = new RegExp(ITALIAN_CODICE_FISCALE_LABEL_PATTERN.source, 'gi');
    const codiceFiscalePattern = new RegExp(ITALIAN_CODICE_FISCALE_PATTERN.source, 'gi');
    const germanKvLabelPattern = new RegExp(GERMAN_KV_NUMBER_LABEL_PATTERN.source, 'gi');
    const germanKvPattern = new RegExp(GERMAN_KV_NUMBER_PATTERN.source, 'gi');

    const createLabeledFindings = (labelPattern: RegExp): AnalyzerFinding[] =>
      Array.from(text.matchAll(labelPattern)).map((match) => {
        const matchedValue = match[1] ?? '';
        const fullMatch = match[0];
        const fullMatchStart = match.index ?? 0;
        const start = fullMatchStart + fullMatch.lastIndexOf(matchedValue);

        return {
          entity_type: 'NATIONAL_ID',
          start,
          end: start + matchedValue.length,
          score: 0.99,
        } satisfies AnalyzerFinding;
      });

    const italianLabeledFindings = createLabeledFindings(italianLabelPattern);
    const germanKvLabeledFindings = createLabeledFindings(germanKvLabelPattern);

    const createStrictPatternFindings = (pattern: RegExp): AnalyzerFinding[] =>
      Array.from(text.matchAll(pattern)).map((match) => {
        const matchedValue = match[0];
        const start = match.index ?? 0;

        return {
          entity_type: 'NATIONAL_ID',
          start,
          end: start + matchedValue.length,
          score: 0.99,
        } satisfies AnalyzerFinding;
      });

    const italianStrictFindings = createStrictPatternFindings(codiceFiscalePattern);
    const germanKvStrictFindings = createStrictPatternFindings(germanKvPattern);

    return DeIdService.mergeFindings(
      DeIdService.mergeFindings(italianLabeledFindings, germanKvLabeledFindings),
      DeIdService.mergeFindings(italianStrictFindings, germanKvStrictFindings),
    );
  }

  private static extractOccupationFindings(text: string): AnalyzerFinding[] {
    const worksAsPattern = new RegExp(OCCUPATION_WORKS_AS_LABEL_PATTERN.source, 'gi');
    const fieldLabelPattern = new RegExp(OCCUPATION_FIELD_LABEL_PATTERN.source, 'gi');
    const socialHistoryPattern = new RegExp(OCCUPATION_SOCIAL_HISTORY_LABEL_PATTERN.source, 'gi');
    const socialHistoryValuePattern = new RegExp(
      OCCUPATION_SOCIAL_HISTORY_VALUE_PATTERN.source,
      'gi',
    );
    const findings: AnalyzerFinding[] = [];

    const addFinding = (match: RegExpExecArray, score: number): void => {
      const valueStart = (match.index ?? 0) + match[0].length;
      const tail = text.slice(valueStart);
      const valueMatch = tail.match(OCCUPATION_VALUE_PREFIX_PATTERN);
      if (!valueMatch) return;
      const value = valueMatch[1].trimEnd();
      if (!value) return;
      findings.push({
        entity_type: 'OCCUPATION',
        start: valueStart,
        end: valueStart + value.length,
        score,
      } satisfies AnalyzerFinding);
    };

    Array.from(text.matchAll(worksAsPattern)).forEach((match) => {
      addFinding(match, 0.9);
    });
    Array.from(text.matchAll(fieldLabelPattern)).forEach((match) => {
      addFinding(match, 0.95);
    });
    Array.from(text.matchAll(socialHistoryPattern)).forEach((match) => {
      const sectionStart = (match.index ?? 0) + match[0].length;
      const tail = text.slice(sectionStart);
      const sectionMarkerMatch = tail.match(FIELD_MARKER_BOUNDARY_PATTERN);
      const section = tail.slice(0, sectionMarkerMatch?.index ?? tail.length);

      Array.from(section.matchAll(socialHistoryValuePattern)).forEach((segmentMatch) => {
        const value = segmentMatch[1]?.trim();
        const segmentStart = segmentMatch.index ?? 0;

        if (!value) {
          return;
        }

        findings.push({
          entity_type: 'OCCUPATION',
          start: sectionStart + segmentStart,
          end: sectionStart + segmentStart + value.length,
          score: 0.88,
        } satisfies AnalyzerFinding);
      });
    });

    return findings;
  }

  private static clampEndToFieldMarker(text: string, start: number, end: number): number {
    const value = text.substring(start, end);
    const markerIdx = value.search(FIELD_MARKER_BOUNDARY_PATTERN);

    if (markerIdx > 0) {
      return start + markerIdx;
    }

    const softBoundaryIdx = value.search(FIELD_LABEL_SOFT_BOUNDARY_PATTERN);
    if (softBoundaryIdx > 0) {
      // Keep one whitespace before the next label to preserve token separation after replacement.
      return start + softBoundaryIdx + 1;
    }

    return end;
  }

  private static clampStartAfterFieldMarker(text: string, start: number, end: number): number {
    const value = text.substring(start, end);
    const markerPrefixMatch = value.match(
      /^\s*(?:Clinic|Date of Service|Provider|Patient Name|Name|DOB|Date of Birth|SSN|MRN|Gender|Sex|Address|Phone|Contact)\s*:\s*/i,
    );

    if (!markerPrefixMatch) {
      return start;
    }

    return start + markerPrefixMatch[0].length;
  }

  private static buildNonOverlappingPreviewSpans(
    text: string,
    entities: DetectedEntity[],
  ): PreviewSpan[] {
    const sanitizedSpans = entities
      .map((entity) => {
        const safeStart = DeIdService.clampStartAfterFieldMarker(text, entity.start, entity.end);
        const safeEnd = DeIdService.clampEndToFieldMarker(text, safeStart, entity.end);

        return {
          id: entity.id,
          category: entity.category,
          confidence: entity.confidence,
          start: safeStart,
          end: safeEnd,
        } satisfies PreviewSpan;
      })
      .filter((span) => span.end > span.start);

    const prioritizedSpans = sanitizedSpans.sort(
      (first, second) =>
        DeIdService.getPreviewCategoryPriority(second.category) -
          DeIdService.getPreviewCategoryPriority(first.category) ||
        second.confidence - first.confidence ||
        second.end - second.start - (first.end - first.start) ||
        first.start - second.start ||
        first.id.localeCompare(second.id),
    );

    return prioritizedSpans.reduce<PreviewSpan[]>((acc, span) => {
      const hasOverlap = acc.some((existing) => DeIdService.hasOverlap(existing, span));

      if (!hasOverlap) {
        acc.push(span);
      }

      return acc;
    }, []);
  }

  private static getPreviewCategoryPriority(category: string): number {
    return PREVIEW_CATEGORY_PRIORITY[category] ?? 100;
  }

  private static shouldKeepNonPhiGenderValue(
    text: string,
    category: string,
    start: number,
    end: number,
  ): boolean {
    if (category === 'ADDRESS') {
      return false;
    }

    const before = text.slice(Math.max(0, start - 30), start);
    if (!/\b(?:Gender|Sex)\s*:\s*$/i.test(before)) {
      return false;
    }

    const value = text.slice(start, end).trim();
    if (NON_PHI_GENDER_VALUE_PATTERN.test(value)) {
      return true;
    }

    const genderValuePrefixMatch = value.match(
      /^(?:male|female|other|unknown|non-binary|nonbinary|m|f)\b/i,
    );
    if (!genderValuePrefixMatch) {
      return false;
    }

    const tail = value.slice(genderValuePrefixMatch[0].length).trimStart();
    return tail.length > 0 && GENDER_TAIL_BOUNDARY_PATTERN.test(tail);
  }

  private static extractClinicHeaderOrganizations(text: string): AnalyzerFinding[] {
    const clinicHeaderFindings = Array.from(text.matchAll(CLINIC_HEADER_ORGANIZATION_PATTERN)).map(
      (match) => {
        const matchedValue = match[1];
        const fullMatch = match[0];
        const fullMatchStart = match.index ?? 0;
        const organizationStart = fullMatchStart + fullMatch.indexOf(matchedValue);

        return {
          entity_type: ORGANIZATION_ENTITY_TYPE,
          start: organizationStart,
          end: organizationStart + matchedValue.length,
          score: 0.99,
        };
      },
    );

    const highRiskFacilityFindings = Array.from(
      text.matchAll(HIGH_RISK_FACILITY_ORGANIZATION_PATTERN),
    ).map((match) => {
      const matchedValue = match[1];
      const start = match.index ?? 0;

      return {
        entity_type: ORGANIZATION_ENTITY_TYPE,
        start,
        end: start + matchedValue.length,
        score: 0.99,
      };
    });

    return DeIdService.mergeFindings(clinicHeaderFindings, highRiskFacilityFindings);
  }

  private static hasOverlap(
    first: Pick<AnalyzerFinding, 'start' | 'end'>,
    second: Pick<AnalyzerFinding, 'start' | 'end'>,
  ): boolean {
    return first.start < second.end && second.start < first.end;
  }

  private buildExternalRecognizersConfig(
    includeExternalRecognizers?: boolean,
  ): ExternalRecognizersConfig {
    const envConfig: ExternalRecognizersConfig = {
      clinicalNlpEnabled:
        this.configService.get<string>(DE_ID_EXTERNAL_RECOGNIZERS_ENV.CLINICAL_NLP_ENABLED) ===
        'true',
      sensitiveCategoriesEnabled:
        this.configService.get<string>(
          DE_ID_EXTERNAL_RECOGNIZERS_ENV.SENSITIVE_CATEGORIES_ENABLED,
        ) === 'true',
    };

    if (includeExternalRecognizers === false) {
      return {
        clinicalNlpEnabled: false,
        sensitiveCategoriesEnabled: false,
      };
    }

    if (includeExternalRecognizers === true) {
      return envConfig;
    }

    return envConfig;
  }

  private static calculateTextHash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Filter false positives based on context keywords and medical measurement patterns.
   * Removes findings that:
   * 1. Are in the MEDICAL_ALLOWLIST (unit names, frequencies, etc.)
   * 2. Are numbers in Physical Exam context
   * 3. Are LOCATION entities without proper location context keywords
   * 4. Are dates/numbers adjacent to medical units (dosage patterns)
   */
  private filterFalsePositivesByContext(
    text: string,
    findings: AnalyzerFinding[],
  ): AnalyzerFinding[] {
    return findings.filter((finding) => {
      const rawFoundText = text.substring(finding.start, finding.end);
      const foundText = rawFoundText.toLowerCase().trim();
      const contextStart = Math.max(0, finding.start - 80);
      const contextEnd = Math.min(text.length, finding.end + 80);
      const context = text.substring(contextStart, contextEnd).toLowerCase();
      const isNumericToken = /^\d+$/.test(foundText);

      if (finding.entity_type === 'DATE_TIME') {
        const digitsOnlyLength = foundText.replace(/\D/g, '').length;
        const looksLikeDateToken =
          ABSOLUTE_DATE_PATTERN.test(rawFoundText) ||
          STRICT_DATE_TOKEN_PATTERN.test(rawFoundText) ||
          TEXTUAL_MONTH_PATTERN.test(rawFoundText);
        const looksLikePhoneToken = PHONE_LIKE_VALUE_PATTERN.test(rawFoundText);
        const hasPhoneContext = PHONE_CONTEXT_KEYWORDS.some((keyword) => context.includes(keyword));

        if (!looksLikeDateToken && digitsOnlyLength >= 8) {
          this.logger.debug(`Filtered: DATE_TIME "${foundText}" is a long non-date numeric token`);
          return false;
        }

        if (looksLikePhoneToken && hasPhoneContext) {
          this.logger.debug(`Filtered: DATE_TIME "${foundText}" overlaps phone-like value`);
          return false;
        }
      }

      if (finding.entity_type === 'DATE_TIME' && ABSOLUTE_DATE_PATTERN.test(rawFoundText)) {
        return true;
      }

      if (
        finding.entity_type === 'DATE_TIME' &&
        DATE_TIME_CONTEXT_KEYWORDS.some((kw) => context.includes(kw))
      ) {
        return true;
      }

      // Skip if text is in Allow List
      if (isInMedicalAllowlist(foundText)) {
        this.logger.debug(`Filtered: "${foundText}" is in medical allowlist`);
        return false;
      }

      // Filter ICD-10 diagnosis codes (e.g. E03.9, J18.0) — not PHI
      if (/^[a-z]\d{2}(?:\.\d{1,4})?$/.test(foundText)) {
        this.logger.debug(`Filtered: "${foundText}" matches ICD-10 code pattern`);
        return false;
      }

      const isHighRiskEntity = HIGH_RISK_ENTITY_TYPES.includes(finding.entity_type);
      if (isHighRiskEntity && finding.score > 0.8) {
        return true;
      }

      // Do not treat doctor credentials as LOCATION / STATE-like entities.
      if (finding.entity_type === 'LOCATION' && isInMedicalAllowlist(foundText)) {
        this.logger.debug(`Filtered: doctor credential "${foundText}" as location false positive`);
        return false;
      }

      // Safe Harbor: keep explicit age values below 90 when they are not part of a date.
      if (
        (finding.entity_type === 'DATE_TIME' || isNumericToken) &&
        DeIdService.isAllowedAgeValue(foundText, context)
      ) {
        this.logger.debug(`Filtered: age "${foundText}" is allowed under Safe Harbor`);
        return false;
      }

      // If LOCATION or ADDRESS — check street pattern in a wide context
      if (finding.entity_type === 'LOCATION' || finding.entity_type === 'ADDRESS') {
        const wideContext = text
          .substring(Math.max(0, finding.start - 120), Math.min(text.length, finding.end + 120))
          .toLowerCase();
        const hasStreetPattern =
          /\b\d+\s+\w+\s+(?:st|ave|blvd|dr|rd|ln|way|pl|street|avenue)\b/i.test(wideContext) ||
          /\b(?:via|corso|piazza|viale|vicolo|largo|strada)\s+[a-z]/i.test(wideContext);
        if (hasStreetPattern) {
          // If there is a street in the context — forcibly consider it as ADDRESS (high risk)
          return true;
        }
      }

      // Filter LOCATION entities that lack proper location context
      if (finding.entity_type === 'LOCATION') {
        const hasLocationContext = LOCATION_CONTEXT_KEYWORDS.some((kw) => context.includes(kw));
        if (!hasLocationContext && finding.score < 0.85) {
          this.logger.debug(`Filtered: LOCATION "${foundText}" without proper context keywords`);
          return false;
        }
      }

      // Filter numbers in Physical Exam context (vitals, measurements)
      if ((finding.entity_type === 'DATE_TIME' || isNumericToken) && finding.score < 0.8) {
        const isInPhysicalExam = PHYSICAL_EXAM_CONTEXT_KEYWORDS.some((kw) => context.includes(kw));
        if (isInPhysicalExam) {
          this.logger.debug(`Filtered: Number "${foundText}" in Physical Exam context (vitals)`);
          return false;
        }
      }

      // Filter small numbers adjacent to medical units (dosage patterns)
      const numberValue = Number.parseInt(foundText, 10);
      if (!Number.isNaN(numberValue) && numberValue < 100 && finding.entity_type === 'DATE_TIME') {
        const hasMedicalUnitAdjacent = Object.values(MEDICAL_ALLOWLIST)
          .flat()
          .some((unit) => {
            const beforePattern = new RegExp(`\\b${numberValue}\\s*${unit}\\b`, 'i');
            const afterPattern = new RegExp(`${unit}\\s*${numberValue}\\b`, 'i');
            return beforePattern.test(text) || afterPattern.test(text);
          });

        if (hasMedicalUnitAdjacent) {
          this.logger.debug(
            `Filtered: Number "${foundText}" adjacent to medical unit (dosage pattern)`,
          );
          return false;
        }
      }

      return true;
    });
  }

  private static isAllowedAgeValue(foundText: string, context: string): boolean {
    const ageValue = Number.parseInt(foundText, 10);
    if (Number.isNaN(ageValue) || ageValue >= 90) return false;

    // if this is a 4-digit number — check if it's a year, not an age
    if (ageValue >= 1900 && ageValue <= new Date().getFullYear()) return false;

    const hasAgeContext = AGE_CONTEXT_KEYWORDS.some((kw) => context.includes(kw));
    // Check patterns like "52-year-old" and "52yo" directly in foundText+context
    const ageInlinePattern = /\b\d{1,2}[-\s]?(?:year|yr)[-\s]?old\b|\b\d{1,2}\s*y\.?o\.?\b/i;

    if (!hasAgeContext && !ageInlinePattern.test(context)) return false;

    const hasDatePattern = /\b\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}\b/.test(context);
    return !hasDatePattern;
  }
}
