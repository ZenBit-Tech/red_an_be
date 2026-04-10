import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EntityManager, In } from 'typeorm';

import {
  DE_ID_CONFIG,
  DE_ID_EXTERNAL_RECOGNIZERS_ENV,
  DE_ID_REMOTE_NLP_ENV,
  DeIdMethod,
  type ComplianceFramework,
} from '@common/constants/compliance.constants';
import DeIdJob from '@db/entities/de-id-job.entity';
import DetectedEntity from '@db/entities/detected-entity.entity';

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

  public async analyzeText(dto: AnalyzeRequestDto): Promise<AnalyzeResult> {
    return this.entityManager.transaction(async (tm): Promise<AnalyzeResult> => {
      try {
        const job = tm.create(DeIdJob, {
          framework: dto.framework,
          threshold: dto.threshold,
          preserveStructure: dto.preserveStructure,
          sourceTextHash: DeIdService.calculateTextHash(dto.text),
          sourceTextLength: dto.text.length,
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

        const entities = deduplicatedFindings.map((finding) =>
          tm.create(DetectedEntity, {
            jobId: job.id,
            category: finding.entity_type,
            confidence: finding.score * 100,
            start: finding.start,
            end: finding.end,
            proxyType: DeIdService.mapToProxyType(dto.framework, finding.entity_type),
          }),
        );

        await tm.save(entities);
        return { jobId: job.id, findings: entities };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Analysis failed: ${message}`);
        throw new InternalServerErrorException('Failed to analyze document');
      }
    });
  }

  public async getPreview(dto: PreviewRequestDto): Promise<string> {
    try {
      const job = await this.entityManager.findOne(DeIdJob, {
        where: { id: dto.jobId },
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
        order: { start: 'DESC' },
      });

      const strategy = getComplianceStrategy(dto.framework);

      return activeEntities.reduce((resultText, entity) => {
        const entityStrategy = strategy.entities[entity.category] ?? DEFAULT_ENTITY_STRATEGY;
        const replacement = DeIdService.calculateReplacement(
          dto.text.substring(entity.start, entity.end),
          entityStrategy.operators,
        );

        return resultText.slice(0, entity.start) + replacement + resultText.slice(entity.end);
      }, dto.text);
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Preview failed: ${message}`);
      throw new InternalServerErrorException('Failed to generate anonymization preview');
    }
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
    if (keep === 'year') {
      const yearMatch = value.match(/\b\d{4}\b/);
      return yearMatch ? yearMatch[0] : '[YEAR]';
    }

    if (keep === 'month_year') {
      const monthYearMatch = value.match(/\b\d{1,2}[/.-]\d{4}\b/);
      return monthYearMatch ? monthYearMatch[0] : '[MONTH_YEAR]';
    }

    const level = DeIdService.getStringParam(operator, 'level');
    if (level) {
      return `[${level.toUpperCase()}]`;
    }

    return '[GENERALIZED]';
  }

  private static applyAggregation(value: string, operator: PresidioOperator): string {
    const buckets = DeIdService.getNumberArrayParam(operator, 'buckets');
    const numericValue = Number.parseInt(value, 10);

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
    const externalConfig = this.buildExternalRecognizersConfig(includeExternalRecognizers);
    const remoteNlpEntities = DeIdService.getRemoteNlpEntities(framework, externalConfig);

    if (remoteNlpEntities.length === 0 || !this.remoteNlpClient.isConfigured()) {
      return presidioResults;
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

      return DeIdService.mergeFindings(presidioResults, remoteNlpResults);
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
      return presidioResults;
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
    );
    const latencyMs = Date.now() - startedAt;
    this.logger.log(
      `Presidio analyze latency=${latencyMs}ms entities=${analyzableEntities.length} findings=${findings.length}`,
    );

    return findings;
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

  private static hasOverlap(first: AnalyzerFinding, second: AnalyzerFinding): boolean {
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
}
