export enum ComplianceFramework {
  HIPAA = 'HIPAA',
  GDPR_EU = 'GDPR_EU',
  GDPR_UK = 'GDPR_UK',
}

export enum DeIdMethod {
  REDACT = 'Redact',
  REPLACE = 'Replace',
  MASK = 'Mask',
  HASH = 'Hash',
  DATE_SHIFT = 'Date Shifting',
  GENERALIZE = 'Generalization',
  SYNTHETIC = 'Synthetic ID',
}

export const DE_ID_CONFIG = {
  MAX_CHUNK_SIZE: 250000,
  CHUNK_OVERLAP: 1000,
  DEFAULT_THRESHOLD: 0.85,
};

/**
 * Env keys that gate external NLP/ML recognizer infrastructure.
 * Set each to 'true' only after the corresponding service is deployed and
 * the matching remote recognizer is registered inside Presidio Analyzer.
 */
export const DE_ID_EXTERNAL_RECOGNIZERS_ENV = {
  /**
   * Enables FREE_TEXT and HEALTH_DATA entity detection.
   * Infrastructure: clinical NLP model (Med7 / BioBERT / MedSpaCy) exposed
   * as a Presidio remote recognizer.
   */
  CLINICAL_NLP_ENABLED: 'DE_ID_CLINICAL_NLP_ENABLED',
  /**
   * Enables GDPR special-category detection:
   * RACE, RELIGION, POLITICAL_VIEWS, SEXUAL_LIFE, SEXUAL_ORIENTATION.
   * Infrastructure: ML context classifier (spaCy custom model) exposed
   * as a Presidio remote recognizer.
   */
  SENSITIVE_CATEGORIES_ENABLED: 'DE_ID_SENSITIVE_CATEGORIES_ENABLED',
} as const;

export const DE_ID_REMOTE_NLP_ENV = {
  URL: 'DE_ID_REMOTE_NLP_URL',
  TIMEOUT_MS: 'DE_ID_REMOTE_NLP_TIMEOUT_MS',
  RETRIES: 'DE_ID_REMOTE_NLP_RETRIES',
  STRICT_MODE: 'DE_ID_REMOTE_NLP_STRICT_MODE',
} as const;

export const DE_ID_POST_VALIDATION_ENV = {
  PHI_VALIDATION_STRICT: 'DE_ID_PHI_VALIDATION_STRICT',
  PHI_VALIDATION_ALLOW_ZIP3: 'DE_ID_PHI_VALIDATION_ALLOW_ZIP3',
} as const;

export const DE_ID_REMOTE_NLP_CONFIG = {
  DEFAULT_TIMEOUT_MS: 3000,
  DEFAULT_RETRIES: 1,
} as const;
