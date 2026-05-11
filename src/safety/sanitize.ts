/**
 * Prompt injection sanitization.
 *
 * Strips content from page DOM and tool results that could be used to
 * manipulate AI agent behavior. Applied before page content reaches the LLM.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?previous\s+instructions?\b/gi,
  /\bforget\s+(all|your|previous)\s+instructions?\b/gi,
  /\bdisregard\b.*\b(previous|prior|above)\s+instructions?\b/gi,
  /\bnew\s+instructions?\s*:\s/gi,
  /\boverride\s+(system|previous|all)\b/gi,
  /\bpretend\s+(to\s+be|you\s+are)\s+(a|an)\s+(system|admin|developer)\b/gi,
];

export function sanitizeForLlm(text: string): string {
  let result = text;
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[filtered]');
  }
  return result;
}
