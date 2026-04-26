import type { Finding } from '../types/finding.ts';

/**
 * De-duplicate findings by (severity + normalised title + route). Agents often
 * report the same bug from different angles within a single session.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const normalisedTitle = f.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const key = `${f.severity}::${normalisedTitle}::${f.route ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
