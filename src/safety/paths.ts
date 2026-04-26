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
