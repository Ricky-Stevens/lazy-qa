import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(s: string, label = 'value'): void {
  if (!UUID_RE.test(s)) {
    throw new Error(`${label} is not a valid UUID: ${s}`);
  }
}

export function assertWithinRoot(candidate: string, root: string, label = 'path'): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || rel === '.' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(
    `${label} escapes allowed root: '${candidate}' resolves outside '${resolvedRoot}'`,
  );
}

export function assertAbsoluteWithinRoot(
  absoluteCandidate: string,
  root: string,
  label = 'path',
): string {
  if (!path.isAbsolute(absoluteCandidate)) {
    throw new Error(`${label} must be absolute: ${absoluteCandidate}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absoluteCandidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '' || rel === '.' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return resolved;
  }
  throw new Error(
    `${label} escapes allowed root: '${absoluteCandidate}' not under '${resolvedRoot}'`,
  );
}

/** Sensitive path patterns that mechanically indicate a security exposure when
 *  returning HTTP 200 with non-trivial content. Shared between:
 *  - pre-classify.ts (auto-classifies as confirmed_bug before LLM critic)
 *  - review.ts rule-floor (prevents critic from downgrading below likely_bug)
 *
 *  Intentionally conservative: only paths whose 200 with non-shell body is
 *  mechanically a real bug regardless of app shape. */
export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/\.git\/HEAD\b/,
  /\/\.git\/config\b/,
  /\/\.env(?:[/?#]|$)/,
  /\/\.htaccess\b/,
  /\/web\.config\b/,
  /\/WEB-INF\/web\.xml\b/,
  /\/server-status\b/,
  /\/server-info\b/,
  /\/api-docs\b/,
  /\/swagger\.json\b/,
  /\/swagger-ui\b/,
  /\/metrics\b/,
  /\/actuator\/(?:env|heapdump|threaddump|mappings)\b/,
  /\/ftp\/?(?:[?#]|$)/,
];

/** Simple path-string list for pre-classify exact-match checks. */
export const SENSITIVE_PATHS: ReadonlyArray<string> = [
  '/.git/HEAD',
  '/.git/config',
  '/.env',
  '/.htaccess',
  '/web.config',
  '/WEB-INF/web.xml',
  '/server-status',
  '/server-info',
  '/api-docs',
  '/swagger.json',
  '/swagger-ui',
  '/metrics',
  '/ftp',
];
