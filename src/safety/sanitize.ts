/**
 * Prompt injection sanitization.
 *
 * Strips content from page DOM and tool results that could be used to
 * manipulate AI agent behavior. Applied before page content reaches the LLM.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?previous\s+instructions?\b/i,
  /\bforget\s+(all|your|previous)\s+instructions?\b/i,
  /\bdisregard\b.*\b(previous|prior|above)\s+instructions?\b/i,
  /\bnew\s+instructions?\s*:\s/i,
  /\boverride\s+(system|previous|all)\b/i,
  /\bpretend\s+(to\s+be|you\s+are)\s+(a|an)\s+(system|admin|developer)\b/i,
];

export function sanitizeForLlm(text: string): string {
  let result = text;
  for (const pattern of INJECTION_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, `${pattern.flags}g`), '[filtered]');
  }
  return result;
}
