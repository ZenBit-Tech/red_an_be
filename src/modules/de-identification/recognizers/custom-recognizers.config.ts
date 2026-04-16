export type RecognizerPattern = {
  name: string;
  regex: string;
  score: number;
};

export type CustomRecognizer = {
  name: string;
  supported_language: string;
  supported_entity: string;
  patterns: RecognizerPattern[];
  context?: string[];
};

// HIPAA custom recognizers (not built-in to Presidio)
const medicalRecordNumberRecognizerHippa: CustomRecognizer = {
  name: 'Medical Record Number Recognizer',
  supported_language: 'en',
  supported_entity: 'MEDICAL_RECORD_NUMBER',
  patterns: [
    {
      name: 'MRN prefixed',
      regex: '\\b(?:MRN|MR#?)[-:\\s]?\\d{5,10}\\b',
      score: 0.9,
    },
    {
      name: 'MRN standalone',
      regex: '\\b\\d{7,10}\\b',
      score: 0.4,
    },
  ],
  context: ['medical', 'record', 'patient', 'hospital', 'clinic', 'mrn'],
};

const healthPlanBeneficiaryRecognizer: CustomRecognizer = {
  name: 'Health Plan Beneficiary Recognizer',
  supported_language: 'en',
  supported_entity: 'HEALTH_PLAN_BENEFICIARY',
  patterns: [
    {
      name: 'Insurance member ID',
      regex: '\\b[A-Z]{1,3}\\d{9,11}\\b',
      score: 0.75,
    },
  ],
  context: ['insurance', 'plan', 'member', 'beneficiary', 'health', 'policy', 'enrollee'],
};

const vehicleIdRecognizer: CustomRecognizer = {
  name: 'Vehicle ID (VIN) Recognizer',
  supported_language: 'en',
  supported_entity: 'VEHICLE_ID',
  patterns: [
    {
      name: 'VIN 17-character',
      // VIN: 17 chars, excludes I, O, Q to avoid confusion
      regex: '\\b[A-HJ-NPR-Z0-9]{17}\\b',
      score: 0.85,
    },
  ],
  context: ['vin', 'vehicle', 'car', 'automobile', 'registration', 'license plate'],
};

const deviceIdRecognizer: CustomRecognizer = {
  name: 'Device ID Recognizer',
  supported_language: 'en',
  supported_entity: 'DEVICE_ID',
  patterns: [
    {
      name: 'Serial number prefixed',
      regex: '\\b(?:SN|S\\/N|Serial(?:\\s*No\\.?|\\s*Number)?)[-:\\s]?[A-Z0-9]{8,20}\\b',
      score: 0.85,
    },
    {
      name: 'IMEI number',
      regex: '\\b\\d{15}\\b',
      score: 0.6,
    },
  ],
  context: ['device', 'serial', 'equipment', 'hardware', 'imei'],
};

const biometricIdRecognizer: CustomRecognizer = {
  name: 'Biometric ID Recognizer',
  supported_language: 'en',
  supported_entity: 'BIOMETRIC_ID',
  patterns: [
    {
      name: 'Biometric reference code',
      regex: '\\b(?:FP|RI|II)[-_]?[A-Z0-9]{8,20}\\b',
      score: 0.75,
    },
  ],
  context: ['fingerprint', 'retina', 'iris', 'biometric', 'facial', 'recognition', 'scan'],
};

// GDPR EU custom recognizers

const euVatNumberRecognizer: CustomRecognizer = {
  name: 'EU VAT Number Recognizer',
  supported_language: 'en',
  supported_entity: 'EU_VAT_NUMBER',
  patterns: [
    {
      name: 'EU VAT standard',
      // Two-letter country code + 8–12 alphanumeric chars
      regex:
        '\\b(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[0-9A-Z]{8,12}\\b',
      score: 0.85,
    },
  ],
  context: ['vat', 'tax', 'registration', 'value added', 'taxpayer'],
};

const nationalIdRecognizer: CustomRecognizer = {
  name: 'National ID Recognizer',
  supported_language: 'en',
  supported_entity: 'NATIONAL_ID',
  patterns: [
    {
      name: 'Generic national ID',
      regex: '\\b[A-Z]{0,2}\\d{6,12}\\b',
      score: 0.5,
    },
  ],
  context: ['national', 'identity', 'id card', 'identification', 'citizen', 'passport'],
};

const bankAccountRecognizer: CustomRecognizer = {
  name: 'Bank Account Number Recognizer',
  supported_language: 'en',
  supported_entity: 'BANK_ACCOUNT',
  patterns: [
    {
      name: 'Generic account number',
      regex: '\\b\\d{8,18}\\b',
      score: 0.45,
    },
  ],
  context: ['account', 'bank', 'current', 'savings', 'banking', 'account number'],
};

const biologicalDataRecognizer: CustomRecognizer = {
  name: 'Biological Data Recognizer',
  supported_language: 'en',
  supported_entity: 'BIOLOGICAL_DATA',
  patterns: [
    {
      name: 'ICD-10 code',
      regex: '\\b[A-Z][0-9]{2}(?:\\.[0-9]{1,4})?\\b',
      score: 0.7,
    },
    {
      name: 'Lab result value',
      regex:
        '\\b\\d+(?:\\.\\d+)?\\s*(?:mg\\/(?:dL|L)|mmol\\/L|micromol\\/L|ng\\/mL|U\\/L|IU\\/L)\\b',
      score: 0.8,
    },
  ],
  context: ['blood', 'lab', 'test', 'result', 'diagnosis', 'condition', 'medical', 'specimen'],
};

const cookieIdRecognizer: CustomRecognizer = {
  name: 'Cookie / Session ID Recognizer',
  supported_language: 'en',
  supported_entity: 'COOKIE_ID',
  patterns: [
    {
      name: 'UUID v4',
      regex: '\\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b',
      score: 0.6,
    },
    {
      name: 'Long hex token',
      regex: '\\b[0-9a-f]{32,64}\\b',
      score: 0.5,
    },
  ],
  context: ['cookie', 'session', 'tracking', 'identifier', 'token', 'analytics', '_ga', '_gid'],
};

// ---------------------------------------------------------------------------
// UK GDPR – кастомні recognizers (специфічні британські ідентифікатори)
// ---------------------------------------------------------------------------

const ukNhsNumberRecognizer: CustomRecognizer = {
  name: 'UK NHS Number Recognizer',
  supported_language: 'en',
  supported_entity: 'UK_NHS_NUMBER',
  patterns: [
    {
      name: 'NHS number formatted',
      regex: '\\b\\d{3}[\\s-]\\d{3}[\\s-]\\d{4}\\b',
      score: 0.9,
    },
    {
      name: 'NHS number unformatted',
      regex: '\\b\\d{10}\\b',
      score: 0.45,
    },
  ],
  context: ['nhs', 'national health', 'patient', 'health service', 'nhs number'],
};

const ukNinoRecognizer: CustomRecognizer = {
  name: 'UK National Insurance Number Recognizer',
  supported_language: 'en',
  supported_entity: 'UK_NINO',
  patterns: [
    {
      name: 'NINO standard',
      // Excludes invalid prefixes: D, F, I, Q, U, V as first letter; O as second
      regex: '\\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][0-9]{6}[A-D]\\b',
      score: 0.9,
    },
  ],
  context: ['national insurance', 'ni number', 'nino', 'insurance number'],
};

const ukPostcodeRecognizer: CustomRecognizer = {
  name: 'UK Postcode Recognizer',
  supported_language: 'en',
  supported_entity: 'UK_POSTCODE',
  patterns: [
    {
      name: 'UK postcode standard',
      regex: '\\b[A-Z]{1,2}[0-9][0-9A-Z]?\\s?[0-9][A-Z]{2}\\b',
      score: 0.85,
    },
  ],
  context: ['postcode', 'postal', 'address', 'zip'],
};

const ukPassportRecognizer: CustomRecognizer = {
  name: 'UK Passport Number Recognizer',
  supported_language: 'en',
  supported_entity: 'UK_PASSPORT',
  patterns: [
    {
      name: 'UK passport 9-digit',
      regex: '\\b[0-9]{9}\\b',
      score: 0.6,
    },
  ],
  context: ['passport', 'travel', 'document', 'uk passport', 'british passport'],
};

const ukDriverLicenceRecognizer: CustomRecognizer = {
  name: 'UK Driver Licence Recognizer',
  supported_language: 'en',
  supported_entity: 'UK_DRIVER_LICENSE',
  patterns: [
    {
      name: 'DVLA format',
      // DVLA: 5 letters + 6 digits + 2 chars + 3 alphanum
      regex: '\\b[A-Z]{5}[0-9]{6}[A-Z0-9]{6}\\b',
      score: 0.85,
    },
  ],
  context: ['driving', 'driver', 'licence', 'license', 'dvla', 'dvle'],
};

const ukSortCodeRecognizerGdprUk: CustomRecognizer = {
  name: 'UK Sort Code Recognizer',
  supported_language: 'en',
  supported_entity: 'UK_SORT_CODE',
  patterns: [
    {
      name: 'Sort code with separator',
      regex: '\\b[0-9]{2}[-\\s][0-9]{2}[-\\s][0-9]{2}\\b',
      score: 0.8,
    },
  ],
  context: ['sort code', 'sortcode', 'bank', 'branch', 'bacs', 'faster payments'],
};

// ---------------------------------------------------------------------------
// GDPR EU – age
// ---------------------------------------------------------------------------

const ageRecognizer: CustomRecognizer = {
  name: 'Age Recognizer',
  supported_language: 'en',
  supported_entity: 'AGE',
  patterns: [
    {
      name: 'Years old',
      regex: '\\b\\d{1,3}[\\s-]years?[\\s-]old\\b',
      score: 0.9,
    },
    {
      name: 'Aged explicit',
      regex: '\\baged?\\s+(?:of\\s+)?\\d{1,3}\\b',
      score: 0.85,
    },
    {
      name: 'Age abbreviation',
      regex: '\\b\\d{1,3}\\s+yrs?\\.?(?:\\s+old)?\\b',
      score: 0.75,
    },
  ],
  context: ['age', 'aged', 'old', 'year', 'years', 'yrs', 'born', 'birth', 'patient'],
};

// ---------------------------------------------------------------------------
// GDPR UK – genetic data
// ---------------------------------------------------------------------------

const geneticDataRecognizer: CustomRecognizer = {
  name: 'Genetic Data Recognizer',
  supported_language: 'en',
  supported_entity: 'GENETIC_DATA',
  patterns: [
    {
      name: 'Known cancer gene panel',
      // Standard HGNC symbols for high-risk actionable genes
      regex:
        '\\b(?:BRCA[12]|TP53|APOE|KRAS|EGFR|MLH1|MSH[26]|APC|RB1|PTEN|HER2|VHL|RAD51|PALB2|ATM|CHEK2|CDH1|STK11|NF[12]|BRAF|PIK3CA)\\b',
      score: 0.95,
    },
    {
      name: 'Nucleotide sequence',
      // Minimum 20 chars to reduce false positives from short all-caps words
      regex: '\\b[ATCGU]{20,}\\b',
      score: 0.85,
    },
    {
      name: 'HGVS coding variant',
      regex: '\\bc\\.\\d+[ACGT]>[ACGT]\\b',
      score: 0.9,
    },
    {
      name: 'HGVS protein variant',
      regex: '\\bp\\.[A-Za-z]{3}\\d+[A-Za-z]{3}\\b',
      score: 0.9,
    },
  ],
  context: [
    'gene',
    'mutation',
    'variant',
    'allele',
    'chromosome',
    'genetic',
    'hereditary',
    'DNA',
    'RNA',
    'genomic',
    'germline',
    'somatic',
  ],
};

// ---------------------------------------------------------------------------
// GDPR UK – trade union membership
// ---------------------------------------------------------------------------

const tradeUnionRecognizer: CustomRecognizer = {
  name: 'Trade Union Recognizer',
  supported_language: 'en',
  supported_entity: 'TRADE_UNION',
  patterns: [
    {
      name: 'Trade union membership statement',
      regex: '\\btrade[\\s-]union\\s+(?:member(?:ship)?|rep(?:resentative)?|card|dues|delegate)\\b',
      score: 0.9,
    },
    {
      name: 'UK union names',
      regex:
        '\\b(?:Unite|UNISON|GMB|RCN|PCS|UCU|NASUWT|NEU|ASLEF|TSSA|BFAWU|BECTU|CWU|USDAW|PROSPECT|POA|BALPA|Nautilus|TUC)\\b',
      score: 0.75,
    },
    {
      name: 'Union role or action',
      regex:
        '\\b(?:shop\\s+steward|union\\s+representative|union\\s+member|trade[\\s-]unionist)\\b',
      score: 0.85,
    },
  ],
  context: [
    'union',
    'trade',
    'member',
    'membership',
    'collective bargaining',
    'strike',
    'industrial action',
  ],
};

// ---------------------------------------------------------------------------
// Custom recognizers by framework
export const HIPAA_CUSTOM_RECOGNIZERS: CustomRecognizer[] = [
  medicalRecordNumberRecognizerHippa,
  healthPlanBeneficiaryRecognizer,
  vehicleIdRecognizer,
  deviceIdRecognizer,
  biometricIdRecognizer,
];

export const GDPR_EU_CUSTOM_RECOGNIZERS: CustomRecognizer[] = [
  euVatNumberRecognizer,
  nationalIdRecognizer,
  bankAccountRecognizer,
  biologicalDataRecognizer,
  cookieIdRecognizer,
  deviceIdRecognizer,
  ageRecognizer,
];

export const GDPR_UK_CUSTOM_RECOGNIZERS: CustomRecognizer[] = [
  ukNhsNumberRecognizer,
  ukNinoRecognizer,
  ukPostcodeRecognizer,
  ukPassportRecognizer,
  ukDriverLicenceRecognizer,
  ukSortCodeRecognizerGdprUk,
  geneticDataRecognizer,
  tradeUnionRecognizer,
];
