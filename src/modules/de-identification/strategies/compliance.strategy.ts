import { ComplianceFramework } from '@common/constants/compliance.constants';
import {
  type CustomRecognizer,
  GDPR_EU_CUSTOM_RECOGNIZERS,
  GDPR_UK_CUSTOM_RECOGNIZERS,
  HIPAA_CUSTOM_RECOGNIZERS,
} from '../recognizers/custom-recognizers.config';

type OperatorParamValue = boolean | number | number[] | string;

export type OperatorType =
  | 'redact'
  | 'replace'
  | 'hash'
  | 'mask'
  | 'generalize'
  | 'aggregate'
  | 'truncate'
  | 'keep_domain';

type RiskLevel = 'low' | 'medium' | 'high';
type StrategyMode = 'strict' | 'flexible' | 'expert';

export interface PresidioOperator {
  type: OperatorType;
  params?: Record<string, OperatorParamValue>;
}

export interface EntityStrategy {
  operators: PresidioOperator[];
  riskLevel?: RiskLevel;
  reversible?: boolean;
}

export interface ComplianceStrategy {
  entities: Record<string, EntityStrategy>;
  adHocRecognizers: CustomRecognizer[];
  mode: StrategyMode;
}

type EntityStrategyOptions = Omit<EntityStrategy, 'operators'>;

// IMAGE is always excluded – requires a separate Presidio Image Redactor
// container with its own API; the current text-only analyze endpoint cannot
// process it regardless of any feature flag.
const ALWAYS_NON_ANALYZABLE_ENTITY_TYPES = new Set<string>(['IMAGE']);

// Requires a clinical NLP model (Med7 / BioBERT / MedSpaCy) registered as a
// remote recognizer inside Presidio Analyzer.
// Enabled via env: DE_ID_CLINICAL_NLP_ENABLED=true
export const CLINICAL_NLP_ENTITY_TYPES = new Set<string>(['FREE_TEXT', 'HEALTH_DATA']);

// Requires an ML context classifier (spaCy custom model) registered as a
// remote recognizer inside Presidio Analyzer.
// Enabled via env: DE_ID_SENSITIVE_CATEGORIES_ENABLED=true
export const SENSITIVE_CATEGORIES_ENTITY_TYPES = new Set<string>([
  'POLITICAL_VIEWS',
  'RACE',
  'RELIGION',
  'SEXUAL_LIFE',
  'SEXUAL_ORIENTATION',
]);

export interface ExternalRecognizersConfig {
  clinicalNlpEnabled: boolean;
  sensitiveCategoriesEnabled: boolean;
}

export const DEFAULT_ENTITY_STRATEGY: EntityStrategy = {
  operators: [{ type: 'redact' }],
  riskLevel: 'high',
};

const GDPR_EU_AGE_BUCKETS = [
  0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
] as const;
const GDPR_UK_AGE_BUCKETS = [0, 18, 30, 50, 70, 100] as const;

const createEntityStrategy = (
  operators: PresidioOperator[],
  options?: EntityStrategyOptions,
): EntityStrategy => ({
  operators,
  ...options,
});

const HIPAA_STRATEGY: ComplianceStrategy = {
  mode: 'strict',
  entities: {
    PERSON: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    ORGANIZATION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    ADDRESS: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    LOCATION: createEntityStrategy([{ type: 'generalize', params: { level: 'state' } }], {
      riskLevel: 'high',
    }),
    DATE_TIME: createEntityStrategy([
      { type: 'generalize', params: { keep: 'year', strict: true } },
    ]),
    AGE: createEntityStrategy([
      {
        type: 'aggregate',
        params: { threshold: 89, replacement: '90+' },
      },
    ]),
    PHONE_NUMBER: createEntityStrategy([{ type: 'redact' }]),
    EMAIL_ADDRESS: createEntityStrategy([{ type: 'redact' }]),
    US_SSN_FULL: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    MEDICAL_RECORD_NUMBER: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    MEDICAL_DOSAGE: createEntityStrategy([{ type: 'keep_domain' }], { riskLevel: 'low' }),
    US_ZIP: createEntityStrategy([{ type: 'redact' }]),
    HEALTH_PLAN_BENEFICIARY: createEntityStrategy([{ type: 'redact' }]),
    CREDIT_CARD: createEntityStrategy([{ type: 'redact' }]),
    US_BANK_NUMBER: createEntityStrategy([{ type: 'redact' }]),
    US_DRIVER_LICENSE: createEntityStrategy([{ type: 'redact' }]),
    VEHICLE_ID: createEntityStrategy([{ type: 'redact' }]),
    DEVICE_ID: createEntityStrategy([{ type: 'redact' }]),
    IP_ADDRESS: createEntityStrategy([{ type: 'redact' }]),
    URL: createEntityStrategy([{ type: 'redact' }]),
    BIOMETRIC_ID: createEntityStrategy([{ type: 'redact' }]),
    OCCUPATION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'medium' }),
    IMAGE: createEntityStrategy([{ type: 'redact' }]),
    FREE_TEXT: createEntityStrategy([{ type: 'keep_domain' }], { riskLevel: 'low' }),
  },
  adHocRecognizers: HIPAA_CUSTOM_RECOGNIZERS,
};

const GDPR_EU_STRATEGY: ComplianceStrategy = {
  mode: 'flexible',
  entities: {
    PERSON: createEntityStrategy(
      [
        { type: 'hash', params: { algorithm: 'sha256' } },
        { type: 'replace', params: { strategy: 'synthetic' } },
      ],
      { reversible: true },
    ),
    EMAIL_ADDRESS: createEntityStrategy([
      { type: 'keep_domain' },
      { type: 'mask', params: { chars: 6 } },
    ]),
    PHONE_NUMBER: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    PL_PHONE_NUMBER: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    DATE_TIME: createEntityStrategy([{ type: 'generalize', params: { keep: 'year' } }]),
    DATE_OF_BIRTH: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    AGE: createEntityStrategy([
      { type: 'aggregate', params: { buckets: [...GDPR_EU_AGE_BUCKETS] } },
    ]),
    GENDER: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'medium' }),
    ADDRESS: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    LOCATION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    ORGANIZATION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    NATIONAL_ID: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    PASSPORT: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    CREDIT_CARD: createEntityStrategy([{ type: 'mask', params: { keepLast: 4 } }]),
    BANK_ACCOUNT: createEntityStrategy([{ type: 'mask', params: { keepLast: 4 } }]),
    IP_ADDRESS: createEntityStrategy([
      { type: 'truncate', params: { subnet: 24 } },
      { type: 'hash' },
    ]),
    DEVICE_ID: createEntityStrategy([{ type: 'hash' }]),
    MEDICAL_RECORD_NUMBER: createEntityStrategy([{ type: 'hash' }], { reversible: true }),
    BIOLOGICAL_DATA: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    FREE_TEXT: createEntityStrategy([{ type: 'redact' }]),
  },
  adHocRecognizers: GDPR_EU_CUSTOM_RECOGNIZERS,
};

// GDPR_UK intentionally extends the EU baseline but is not identical:
// it adds UK-specific identifiers and additional special-category entities.
// Keeping a dedicated constant makes framework-specific behavior explicit.
const GDPR_UK_STRATEGY: ComplianceStrategy = {
  mode: 'flexible',
  entities: {
    ...GDPR_EU_STRATEGY.entities,
    EMAIL_ADDRESS: createEntityStrategy([{ type: 'mask', params: { redactDomain: true } }]),
    RACE: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    RELIGION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    POLITICAL_VIEWS: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    TRADE_UNION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    GENETIC_DATA: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    HEALTH_DATA: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    SEXUAL_LIFE: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    SEXUAL_ORIENTATION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'high' }),
    UK_NHS_NUMBER: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    UK_NINO: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    UK_POSTCODE: createEntityStrategy([
      { type: 'generalize', params: { level: 'uk_outward_code' } },
    ]),
    UK_GP_PRACTICE_CODE: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    UK_PASSPORT: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    UK_DRIVER_LICENSE: createEntityStrategy([{ type: 'hash' }, { type: 'redact' }]),
    UK_SORT_CODE: createEntityStrategy([{ type: 'mask', params: { keepLast: 2 } }]),
    DATE_OF_BIRTH: createEntityStrategy([{ type: 'generalize', params: { keep: 'year' } }]),
    AGE: createEntityStrategy([
      { type: 'aggregate', params: { buckets: [...GDPR_UK_AGE_BUCKETS] } },
    ]),
    OCCUPATION: createEntityStrategy([{ type: 'redact' }], { riskLevel: 'medium' }),
    LOCATION: createEntityStrategy([
      { type: 'generalize', params: { level: 'city' } },
      { type: 'generalize', params: { level: 'region' } },
    ]),
    URL: createEntityStrategy([{ type: 'redact' }]),
  },
  adHocRecognizers: [...GDPR_EU_CUSTOM_RECOGNIZERS, ...GDPR_UK_CUSTOM_RECOGNIZERS],
};

// Two separate keys are required here because analyzable entity sets and
// ad-hoc recognizers differ between GDPR_EU and GDPR_UK.
const STRATEGIES: Record<ComplianceFramework, ComplianceStrategy> = {
  [ComplianceFramework.HIPAA]: HIPAA_STRATEGY,
  [ComplianceFramework.GDPR_EU]: GDPR_EU_STRATEGY,
  [ComplianceFramework.GDPR_UK]: GDPR_UK_STRATEGY,
};

export const getComplianceStrategy = (framework: ComplianceFramework): ComplianceStrategy => {
  const strategy = STRATEGIES[framework];

  if (!strategy) {
    throw new Error(`Unsupported compliance framework: ${framework}`);
  }

  return strategy;
};

export const getAnalyzableEntities = (
  framework: ComplianceFramework,
  externalConfig: ExternalRecognizersConfig = {
    clinicalNlpEnabled: false,
    sensitiveCategoriesEnabled: false,
  },
): string[] => {
  const strategy = getComplianceStrategy(framework);

  return Object.keys(strategy.entities).filter((entityType) => {
    if (ALWAYS_NON_ANALYZABLE_ENTITY_TYPES.has(entityType)) {
      return false;
    }

    if (!externalConfig.clinicalNlpEnabled && CLINICAL_NLP_ENTITY_TYPES.has(entityType)) {
      return false;
    }

    if (
      !externalConfig.sensitiveCategoriesEnabled &&
      SENSITIVE_CATEGORIES_ENTITY_TYPES.has(entityType)
    ) {
      return false;
    }

    return true;
  });
};
