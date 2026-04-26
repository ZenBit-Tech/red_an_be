function fixTokenPunctuation(text: string): string {
  return text
    .replace(/\]\s+,/g, '],')
    .replace(/\]\s+:/g, ']:')
    .replace(/:\s*:/g, ':');
}

function cleanupWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

export function normalizeAnonymizedText(text: string): string {
  let result = text;

  // Keep normalization non-destructive: punctuation and whitespace only.
  result = fixTokenPunctuation(result);
  result = cleanupWhitespace(result);

  return result;
}
