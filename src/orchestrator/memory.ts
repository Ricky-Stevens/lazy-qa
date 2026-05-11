/**
 * Memory storage path resolution for the agent Memory tool.
 *
 * Strategy: per-target persistence at
 *   <homedir>/.lazy-qa/memory/<sha1(targetUrl).slice(0,16)>/
 *
 * Multiple runs against the same target share the directory — cross-run
 * learning is the point. The SHA1 truncation gives a stable 16-char directory
 * name that is human-readable enough for manual inspection.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Resolve the memory storage directory for a given target URL.
 *
 * @param targetUrl  The canonical target portal URL (e.g. "https://app.example.com").
 * @param override   Optional config override. When set, returned as-is after
 *                   path.resolve so it's always absolute.
 */
export function resolveMemoryPath(targetUrl: string, override?: string): string {
  if (override) {
    return path.resolve(override);
  }
  const hash = createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
  return path.join(homedir(), '.lazy-qa', 'memory', hash);
}
