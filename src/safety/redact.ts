/**
 * Sensitive data redaction for persisted artifacts.
 *
 * Applied to findings, events, and summary reports before writing to disk.
 * The in-memory copies remain unredacted so the review/verify pipeline can
 * reason about the full evidence.
 */

import type { Finding } from '../types/finding.ts';

interface RedactionRule {
  pattern: RegExp;
  label: string;
}

const REDACTION_RULES: RedactionRule[] = [
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
    label: '[JWT-REDACTED]',
  },
  { pattern: /\b[0-9a-f]{32}\b/gi, label: '[HASH-32]' },
  { pattern: /\b[0-9a-f]{64}\b/gi, label: '[HASH-64]' },
  {
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g,
    label: '[CARD-REDACTED]',
  },
  // Base32 TOTP secrets: 16 or 32 chars of A-Z2-7. Require at least one
  // digit (2-7) so we don't redact normal uppercase words like
  // "APPLICATIONCONTEXT" or "UNCAUGHTEXCEPTION".
  { pattern: /\b(?=[A-Z2-7]{16,32}\b)(?=[A-Z]*[2-7])[A-Z2-7]{16,32}\b/g, label: '[TOTP-REDACTED]' },
  // Provider-prefixed API keys (Stripe, OpenAI, GitHub, Anthropic, AWS)
  { pattern: /\b(?:sk|pk)[-_](?:live|test)_[a-zA-Z0-9]{10,}\b/g, label: '[APIKEY-REDACTED]' },
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/g, label: '[GITHUB-TOKEN-REDACTED]' },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, label: '[APIKEY-REDACTED]' },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: '[AWS-KEY-REDACTED]' },
  { pattern: /\bxox[bpras]-[a-zA-Z0-9-]{10,}\b/g, label: '[SLACK-TOKEN-REDACTED]' },
  // Credentials in URLs: https://user:pass@host
  { pattern: /:\/\/[^:\/\s]+:[^@\/\s]+@/g, label: '://[CREDS-REDACTED]@' },
  // Key-value pairs with sensitive keys (password=..., secret=..., api_key=...)
  {
    pattern: /\b(password|secret|api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi,
    label: '$1=[REDACTED]',
  },
  // PEM private keys
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, label: '[PRIVATE-KEY-REDACTED]' },
];

export function redactSensitiveData(text: string): string {
  let result = text;
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.label);
  }
  return result;
}

export function redactFinding(finding: Finding): Finding {
  return {
    ...finding,
    title: redactSensitiveData(finding.title),
    description: redactSensitiveData(finding.description),
    expected: redactSensitiveData(finding.expected),
    actual: redactSensitiveData(finding.actual),
    stepsToReproduce: finding.stepsToReproduce.map(redactSensitiveData),
    // Redact remaining text fields that may contain secrets (JWTs in URLs,
    // credentials in response bodies, tokens in console output, etc.).
    ...(finding.route ? { route: redactSensitiveData(finding.route) } : {}),
    ...(finding.filedAtUrl ? { filedAtUrl: redactSensitiveData(finding.filedAtUrl) } : {}),
    ...(finding.requestUrl ? { requestUrl: redactSensitiveData(finding.requestUrl) } : {}),
    ...(finding.responseBodySample
      ? { responseBodySample: redactSensitiveData(finding.responseBodySample) }
      : {}),
    ...(finding.consoleErrors
      ? { consoleErrors: finding.consoleErrors.map(redactSensitiveData) }
      : {}),
  };
}
