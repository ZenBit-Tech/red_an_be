export interface Leak {
  type: string;
  match: string;
  index: number;
}

export interface ValidationResult {
  valid: boolean;
  leaks: Leak[];
}

export interface ValidationOptions {
  strict?: boolean;
  allowZip3?: boolean;
  skipPatternTypes?: ReadonlyArray<string>;
}

type PhiPattern = {
  type: string;
  regex: RegExp;
};

const PHI_PATTERNS: ReadonlyArray<PhiPattern> = [
  {
    type: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: 'PHONE',
    regex: /\(\d{3}\)\s?\d{3}-\d{4}/g,
  },
  {
    type: 'EMAIL',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    type: 'IP',
    regex: /\b\d{1,3}(\.\d{1,3}){3}\b/g,
  },
  {
    type: 'CREDIT_CARD',
    regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  },
  {
    type: 'ZIP',
    regex: /\b\d{5}\b/g,
  },
  {
    type: 'NHS_NUMBER',
    regex: /\b(?:NHS(?:\s+Number)?[:#-]?\s*)?\d{3}\s+\d{3}\s+\d{4}\b/gi,
  },
  {
    type: 'UK_POSTCODE_FULL',
    regex: /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/gi,
  },
];

const SAFE_ZIP_WINDOW_LENGTH = 7;
const SAFE_ZIP_REGEX = /\d{3}(\*\*|xx)/i;

export class PhiLeakDetectedError extends Error {
  public readonly leaks: Leak[];

  constructor(leaks: Leak[]) {
    const summary = leaks.map((leak) => `${leak.type}: "${leak.match}" @${leak.index}`).join('\n');
    super(`PHI leak detected:\n${summary}`);
    this.name = 'PhiLeakDetectedError';
    this.leaks = leaks;
  }
}

function isSafeZip(text: string, index: number, allowZip3 = false): boolean {
  if (!allowZip3) {
    return false;
  }

  const surrounding = text.slice(index, index + SAFE_ZIP_WINDOW_LENGTH);
  return SAFE_ZIP_REGEX.test(surrounding);
}

function collectLeaks(text: string, options: ValidationOptions): Leak[] {
  return PHI_PATTERNS.reduce<Leak[]>((acc, pattern) => {
    if (options.skipPatternTypes?.includes(pattern.type)) {
      return acc;
    }

    const matches = Array.from(text.matchAll(pattern.regex));
    const leaksForPattern = matches
      .map((match): Leak | null => {
        const matchedValue = match[0];
        const matchIndex = match.index ?? 0;

        if (pattern.type === 'ZIP' && isSafeZip(text, matchIndex, options.allowZip3)) {
          return null;
        }

        return {
          type: pattern.type,
          match: matchedValue,
          index: matchIndex,
        };
      })
      .filter((leak): leak is Leak => leak !== null);

    return acc.concat(leaksForPattern);
  }, []);
}

export function validatePhi(text: string, options: ValidationOptions = {}): ValidationResult {
  const strict = options.strict ?? true;
  const allowZip3 = options.allowZip3 ?? false;
  const leaks = collectLeaks(text, { allowZip3, skipPatternTypes: options.skipPatternTypes });

  const result: ValidationResult = {
    valid: leaks.length === 0,
    leaks,
  };

  if (!result.valid && strict) {
    throw new PhiLeakDetectedError(leaks);
  }

  return result;
}
