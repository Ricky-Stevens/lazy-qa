import type { Finding } from '../types/finding.ts';

function normaliseRoute(route: string): string {
  return route.replace(/\/+$/, '').replace(/\?.*$/, '').toLowerCase();
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * De-duplicate findings in two passes:
 *   1. Exact match on (normalised title + normalised route) — severity excluded
 *      so the same bug at different severities is still deduped.
 *   2. Fuzzy match: same route-family + Jaccard ≥ 0.6 on title tokens.
 *      Keeps the finding with more reproduction steps.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  // Pass 1: exact key dedup (severity-agnostic).
  const seen = new Set<string>();
  const pass1: Finding[] = [];
  for (const f of findings) {
    const normalisedTitle = f.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const key = `${normalisedTitle}::${normaliseRoute(f.route ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pass1.push(f);
  }

  // Pass 2: fuzzy dedup — same normalised route + high title similarity.
  const TITLE_JACCARD_THRESHOLD = 0.6;
  const out: Finding[] = [];
  for (const f of pass1) {
    const fRoute = normaliseRoute(f.route ?? '');
    const fTokens = tokenise(f.title);
    let isDupe = false;
    for (const kept of out) {
      const kRoute = normaliseRoute(kept.route ?? '');
      if (fRoute !== kRoute) continue;
      if (jaccard(fTokens, tokenise(kept.title)) >= TITLE_JACCARD_THRESHOLD) {
        if (f.stepsToReproduce.length > kept.stepsToReproduce.length) {
          out[out.indexOf(kept)] = f;
        }
        isDupe = true;
        break;
      }
    }
    if (!isDupe) out.push(f);
  }
  return out;
}
