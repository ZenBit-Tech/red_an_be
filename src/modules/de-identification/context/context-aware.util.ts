// ==============================
// TYPES & ENUMS
// ==============================

export enum PhiType {
  NAME = 'NAME',
  DATE = 'DATE',
  SSN = 'SSN',
  MRN = 'MRN',
  PHONE = 'PHONE',
  ADDRESS = 'ADDRESS',
  LOCATION = 'LOCATION',
  ZIP = 'ZIP',
  EMAIL = 'EMAIL',
  AGE = 'AGE',
  UNKNOWN = 'UNKNOWN',
}

export interface DetectedEntity {
  type: PhiType;
  value: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface Context {
  field?: string;
  isRelativeTime?: boolean;
  isAbsoluteDate?: boolean;
  isClinicalNumber?: boolean;
}

// ==============================
// CONTEXT DETECTION
// ==============================

function getFieldContext(text: string, index: number): string | undefined {
  // Looking 80 characters back (was 50)
  const before = text.slice(Math.max(0, index - 80), index).toLowerCase();
  // Looking 40 characters ahead
  const after = text.slice(index, Math.min(text.length, index + 40)).toLowerCase();
  const window = before + after;
  const isImmediatelyAfterGenderLabel = /\b(?:gender|sex)\s*:\s*$/i.test(before);

  if (window.includes('ssn')) return 'SSN';
  if (window.includes('dob') || window.includes('date of birth')) return 'DOB';
  // Gender applies only to values immediately after the field label.
  if (isImmediatelyAfterGenderLabel) return 'GENDER_FIELD';
  // Checking address patterns — house number + street
  if (
    window.includes('address') ||
    /\b\d+\s+\w+\s+(st|ave|blvd|dr|rd|ln|way|pl)\b/i.test(text.slice(index, index + 60))
  )
    return 'ADDRESS';
  if (window.includes('phone') || window.includes('tel:')) return 'PHONE';
  if (window.includes('mrn')) return 'MRN';
  if (window.includes('date of service') || window.includes('dos:')) return 'DATE';

  return undefined;
}

function isRelativeTime(value: string): boolean {
  // 1. General relative terms
  const relativeTerms =
    /\b(daily|weekly|monthly|yearly|today|yesterday|tomorrow|past|ago|twice|once|since|every|each|per|morning|evening|bedtime|afternoon|overnight|recently|currently|ongoing|chronic|acute|hrs|hr)\b/i;

  // 2. "number (digits) + time unit"
  const numericRelativePattern = /\b\d+\s*(?:day|week|month|year|hour|hr|hrs|minute|min)s?\b/i;

  // 3. "number (written) + time unit"
  const writtenNumberPattern =
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|few|couple(?:\s+of)?|a\s+few|a\s+couple(?:\s+of)?)\s+(?:day|week|month|year|hour|minute)s?\b/i;

  // 4. Medical frequency (pharmaceutical abbreviations)
  const medFrequency =
    /\b(?:bid|tid|qid|qhs|qam|qpm|prn|sos|q\d+h?|once\s+(?:a\s+)?(?:day|week|month)|twice\s+(?:a\s+)?(?:day|week)|three\s+times\s+(?:a\s+)?(?:day|week))\b/i;

  // 5. "for X weeks/months" — treatment duration
  const durationPattern =
    /\bfor\s+(?:\d+|(?:one|two|three|four|five|six|several|few))\s+(?:day|week|month|year)s?\b/i;

  return (
    relativeTerms.test(value) ||
    numericRelativePattern.test(value) ||
    writtenNumberPattern.test(value) ||
    medFrequency.test(value) ||
    durationPattern.test(value)
  );
}

function isAbsoluteDate(value: string): boolean {
  return /\b\d{2}\/\d{2}\/\d{4}\b/.test(value);
}

function isClinicalNumber(value: string): boolean {
  return /\b\d+\/10\b/.test(value); // pain score like 6/10
}

function isDateOfService(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 60), index + 30).toLowerCase();
  return /date\s+of\s+service|dos:|visit\s+date|service\s+date/.test(window);
}

// ==============================
// ENTITY REFINEMENT
// ==============================

function refineEntity(
  entity: DetectedEntity,
  text: string,
): {
  entity: DetectedEntity;
  context: Context;
} {
  const field = getFieldContext(text, entity.start);

  // if this is the Gender field — do not anonymize Male/Female
  if (field === 'GENDER_FIELD') {
    return { entity: { ...entity, type: PhiType.UNKNOWN }, context: { field } };
  }

  const context: Context = {
    field,
    isRelativeTime: isRelativeTime(entity.value),
    isAbsoluteDate: isAbsoluteDate(entity.value),
    isClinicalNumber: isClinicalNumber(entity.value),
  };

  // create a copy of the entity, do not modify the parameter directly
  const refinedEntity: DetectedEntity = { ...entity };
  if (field === 'SSN') refinedEntity.type = PhiType.SSN;
  if (field === 'MRN') refinedEntity.type = PhiType.MRN;
  if (field === 'PHONE') refinedEntity.type = PhiType.PHONE;
  if (field === 'ADDRESS') refinedEntity.type = PhiType.ADDRESS;
  if (field === 'DATE') refinedEntity.type = PhiType.DATE;

  return { entity: refinedEntity, context };
}

// ==============================
// DECISION ENGINE
// ==============================

function shouldAnonymize(entity: DetectedEntity, context: Context): boolean {
  // Gender values (Male/Female/other) are clinical attributes, not direct identifiers.
  if (context.field === 'GENDER_FIELD') return false;

  // add ZIP and LOCATION (for clinic names) to the list of mandatory PHI
  const mandatoryPhi = [
    PhiType.SSN,
    PhiType.MRN,
    PhiType.PHONE,
    PhiType.EMAIL,
    PhiType.ADDRESS,
    PhiType.ZIP,
    PhiType.LOCATION,
  ];
  if (mandatoryPhi.includes(entity.type)) return true;

  if (entity.type === PhiType.DATE) {
    if (context.isRelativeTime) return false;
    // Do not anonymize Age if it is recognized as a date (e.g. "52-year-old") to preserve useful info for research, but only if it has age context
    if (entity.value.toLowerCase().includes('age')) return false;
    return true;
  }

  return true;
}

// ==============================
// TRANSFORM
// ==============================

function extractYear(value: string): string {
  // if is pattern NN-year-old (NN <= 90), do not replace
  const ageMatch = value.match(/\b(\d{1,2})-year-old\b/i);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age > 0 && age <= 90) {
      return value;
    }
  }
  // seek 4-digit year within the range 1900–current year
  const yearMatch = value.match(/\b(\d{4})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    const currentYear = new Date().getFullYear();
    if (year >= 1900 && year <= currentYear) {
      return yearMatch[1];
    }
  }
  return '[DATE]';
}

function transform(entity: DetectedEntity, context: Context): string {
  if (!shouldAnonymize(entity, context)) {
    return entity.value;
  }

  switch (entity.type) {
    case PhiType.SSN:
      return '[SSN]';
    case PhiType.ZIP:
      return '[ZIP]';
    case PhiType.LOCATION:
      return '[LOCATION]';
    case PhiType.DATE: {
      const year = extractYear(entity.value);
      // If there is no year in the "date" and it is not digits, return as is or as NAME
      if (year === '[DATE]' && !/\d/.test(entity.value)) return '[NAME]';
      return year;
    }
    case PhiType.MRN:
      return '[MRN]';
    case PhiType.PHONE:
      return '[PHONE]';
    case PhiType.EMAIL:
      return '[EMAIL]';
    case PhiType.ADDRESS:
      return '[ADDRESS]';
    case PhiType.NAME:
      return '[NAME]';
    default:
      return `[${entity.type}]`;
  }
}

// Matches "FieldName:" labels that should never be swallowed inside a PHI span.
// Not using the `g` flag to avoid stateful lastIndex across calls.
const FIELD_MARKER_PATTERN = /\b(?:DOB|SSN|MRN|Phone|Address|Gender|Name)\s*:/i;

// ==============================
// MAIN FUNCTION
// ==============================

export function contextAwareAnonymize(text: string, entities: DetectedEntity[]): string {
  // Sort by position; for identical start keep the longest span first.
  // This prevents partial overlaps from skipping full entities (e.g. full SSN).
  const sorted = [...entities].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      a.type.localeCompare(b.type),
  );

  let result = '';
  let lastIndex = 0;

  sorted.forEach((rawEntity) => {
    // Truncate span if it crosses a field marker boundary (e.g. "DOB:", "SSN:")
    const spanText = text.slice(rawEntity.start, rawEntity.end);
    const markerIdx = spanText.search(FIELD_MARKER_PATTERN);
    const clampedEntity =
      markerIdx > 0
        ? {
            ...rawEntity,
            end: rawEntity.start + markerIdx,
            value: text.slice(rawEntity.start, rawEntity.start + markerIdx),
          }
        : rawEntity;

    const { entity, context } = refineEntity(clampedEntity, text);

    // Skip invalid or overlapping spans to avoid truncating output text.
    if (entity.start < lastIndex || entity.start >= entity.end) {
      return;
    }

    if (entity.start < 0 || entity.end > text.length) {
      return;
    }

    result += text.slice(lastIndex, entity.start);
    const replacement = transform(entity, context);
    result += replacement;
    lastIndex = entity.end;
  });

  result += text.slice(lastIndex);
  return result;
}

export function shouldKeepOriginalByContext(
  category: string,
  value: string,
  text: string,
  start: number,
): boolean {
  if (category !== 'DATE_TIME') {
    return false;
  }

  // Force anonymize dates of service — do not keep the original if the context suggests it is a date of service, even if it looks like a date.
  if (isDateOfService(text, start)) return false;

  const contextStart = Math.max(0, start - 50);
  // Extend the forward window to capture patterns like "age 68" when the span starts at "age"
  const contextEnd = Math.min(text.length, start + value.length + 20);
  const contextBefore = text.slice(contextStart, start).toLowerCase();
  // Full window including the span itself — needed for "age 68" inline detection
  const fullContext = text.slice(contextStart, contextEnd).toLowerCase();

  // Also check the raw text ahead in case the span only covers the number
  const isRelative =
    isRelativeTime(value) ||
    isRelativeTime(text.slice(start, Math.min(text.length, start + value.length + 15)));
  const isClinical = isClinicalNumber(value);

  // "age" may appear before the value OR the span may contain "age 68" as a whole
  const hasAgeContext =
    /\bage\b|\baged\b|\byears old\b/i.test(contextBefore) || /\bage\s+\d{1,2}\b/i.test(fullContext);

  // Protect vital-sign readings (HR, BP, RR, SpO2, BMI, Temp) from being treated as dates
  const isVitalSign = /\b(?:hr|bp|rr|spo2|bmi|temp)\s*\d/i.test(fullContext);

  return isRelative || isClinical || hasAgeContext || isVitalSign;
}
