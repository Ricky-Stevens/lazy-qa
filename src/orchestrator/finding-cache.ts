/**
 * Cross-agent finding cache.
 *
 * Lives at the run level — every agent in a parallel run shares one instance.
 * Each `report_finding` tool call lands here too (in addition to the agent's
 * own journey + the events.jsonl trace). The agent loop reads the cache at
 * the start of every turn and renders an "Already reported" block in the
 * per-turn user message so subsequent agents skip rediscovering the same
 * issues.
 *
 * The previous run's symptom: 5 agents independently filed `/.git/HEAD`,
 * `/.env`, `/backup` — 10 of 18 findings were duplicates. The critic then
 * deduped, but each duplicate cost a turn + ~$0.01. With this cache, an
 * agent landing on a route that already has a confirmed-bug finding moves
 * on to unexplored ground instead of re-filing.
 */

import type { Finding } from '../types/finding.ts';

/** A compact projection of a Finding sized for inclusion in the per-turn
 *  user message. Full finding metadata stays on disk (events.jsonl). */
export interface KnownFindingRef {
  /** Reporting agent. Useful so an agent doesn't dedupe against itself. */
  agentId: string;
  severity: Finding['severity'];
  title: string;
  /** Origin + pathname (+ SPA hash). Empty when the finding has no route. */
  route: string;
  /** ISO timestamp. */
  reportedAt: string;
}

/** Maximum number of entries the cache retains. Older entries fall off; the
 *  agent's per-turn message renders the most recent entries first. */
const MAX_ENTRIES = 200;

/** Minimum Jaccard similarity (over title keyword tokens) to treat two findings
 *  as the same bug. 0.5 means "half the title tokens overlap" — strict enough
 *  that "Stack trace exposed" and "Confidential document" don't merge, loose
 *  enough that "Confidential document publicly accessible" and "Confidential
 *  business document publicly accessible without authentication" merge. */
const TITLE_JACCARD_THRESHOLD = 0.5;

/** Stop-words / generic security vocabulary stripped before computing Jaccard.
 *  These tokens appear in nearly every finding title and would falsely inflate
 *  similarity. Lower-case, no punctuation. */
const TITLE_STOP_TOKENS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'in',
  'on',
  'to',
  'for',
  'with',
  'without',
  'is',
  'are',
  'be',
  'via',
  'at',
  'from',
  'unauth',
  'unauthenticated',
  'authentication',
  'auth',
  'publicly',
  'public',
  'accessible',
  'access',
  'exposed',
  'exposure',
  'leak',
  'leaks',
  'leaking',
  'error',
  'response',
  'returns',
  'returning',
  'page',
]);

/** Tokenise a finding title into normalised keyword tokens. Lowercases, splits
 *  on non-alphanumeric, drops stop-words and tokens shorter than 3 characters.
 *  Used to compute title similarity for dedup. */
function tokeniseTitle(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !TITLE_STOP_TOKENS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity between two token sets. 1.0 = identical, 0 = disjoint. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Normalise a route for prefix-comparison. Strips trailing slash, lower-cases,
 *  drops query string and fragment beyond the SPA-route hash. The result is a
 *  stable key per "place on the site" so `/ftp/`, `/ftp/acquisitions.md`, and
 *  `/ftp/coupons.md.bak` all share the prefix `/ftp` for dedup purposes. */
function normaliseRoute(route: string): string {
  if (!route) return '';
  let r = route.toLowerCase().split('?')[0] ?? '';
  // Preserve SPA hash routes; strip plain `#section` anchors.
  if (r.includes('#') && !/#!?\//.test(r)) {
    r = r.split('#')[0] ?? r;
  }
  // Strip protocol + host so `/ftp` matches `http://localhost:3000/ftp`.
  r = r.replace(/^https?:\/\/[^/]+/, '');
  // Trailing slash off (but keep "/" itself).
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

/** Returns true when `a` and `b` share a route family — same first 2 path
 *  segments. So `/ftp/acquisitions.md` and `/ftp/coupons.md.bak` match (both
 *  under `/ftp`), but `/ftp` and `/api/Orders` do not. */
function sameRouteFamily(a: string, b: string): boolean {
  const na = normaliseRoute(a);
  const nb = normaliseRoute(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Compare first non-empty segment after origin.
  const segA = na.split('/').filter(Boolean).slice(0, 1).join('/');
  const segB = nb.split('/').filter(Boolean).slice(0, 1).join('/');
  return segA.length > 0 && segA === segB;
}

export class FindingCache {
  private entries: KnownFindingRef[] = [];
  private falsePositivePatterns: Array<{ titlePattern: string; route?: string; reason: string }> =
    [];

  seedFalsePositivePatterns(
    patterns: Array<{ titlePattern: string; route?: string; reason: string }>,
  ): void {
    this.falsePositivePatterns = patterns;
  }

  matchesFalsePositive(f: { title: string; route?: string }): { reason: string } | null {
    const normTitle = f.title.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const p of this.falsePositivePatterns) {
      // Match when the finding title contains the full pattern (new finding
      // is a superset of the known FP), OR the pattern contains the full
      // finding title BUT only when the finding title is long enough to be
      // meaningful (>= 30 chars). Without the length guard, short titles
      // like "error" or "form validation" would match any pattern containing
      // those words, suppressing legitimate new findings.
      const titleMatchesPattern = normTitle.includes(p.titlePattern);
      const patternMatchesTitle =
        normTitle.length >= 30 && p.titlePattern.includes(normTitle.slice(0, 60));
      if (titleMatchesPattern || patternMatchesTitle) {
        if (!p.route || p.route === f.route) {
          return { reason: p.reason };
        }
      }
    }
    return null;
  }

  /** Append a new finding. Cheap projection — the full Finding object is not
   *  retained. Caller is the report_finding handler in browser-server. */
  add(agentId: string, f: Finding): void {
    this.entries.push({
      agentId,
      severity: f.severity,
      title: f.title,
      route: f.route ?? '',
      reportedAt: f.ts,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  /** All findings reported by agents OTHER than the caller. Most recent first. */
  forAgent(agentId: string): KnownFindingRef[] {
    return this.entries.filter((e) => e.agentId !== agentId).reverse();
  }

  /** Decide whether a new finding from `agentId` is a near-duplicate of one the
   *  same agent has already filed. Returns the existing entry on match.
   *
   *  Match rule: same severity + same route family (first path segment) + title
   *  Jaccard >= threshold. Cross-agent dups stay allowed (the cross-agent cache
   *  intentionally surfaces overlap as visibility, not suppression).
   *
   *  SPECIAL CASE — gamification notices: when a finding's title contains
   *  `Challenge "X"` or `Challenge X auto-solved` (the OWASP Juice Shop
   *  scoreboard pattern), we dedup by challenge name X across ALL routes for
   *  the agent. Otherwise the same gamification toast surfaces on every
   *  navigation and the agent files 4-5 duplicate findings that the critic
   *  flips to `duplicate` anyway.
   *
   *  Why this exists: in run #7 the attacker filed `/ftp/acquisitions.md` 3
   *  times under different titles and `/ftp/ null-byte` 4 times. In run #8
   *  power-user filed 4 challenge-solved findings (one per route). The post-run
   *  critic deduplicated them anyway, but each duplicate cost a turn + a
   *  report_finding call. This blocks the cost up-front. */
  findWithinAgentDuplicate(agentId: string, f: Finding): KnownFindingRef | null {
    // SPECIAL CASE: gamification challenge-solved notices dedup by challenge
    // name globally for the agent (not by route).
    const newChallenge = extractChallengeName(f.title);
    if (newChallenge) {
      for (const e of this.entries.filter((e) => e.agentId === agentId).slice(-50)) {
        const existing = extractChallengeName(e.title);
        if (existing && existing === newChallenge) return e;
      }
      // No existing finding for THIS challenge name — allow it through.
      // Don't fall through to the route-family check; gamification notices
      // are uniquely keyed by challenge name.
      return null;
    }

    const newTokens = tokeniseTitle(f.title);
    // Most recent first; we only need to look at the agent's last 30 findings —
    // older ones are unlikely to be the same bug refiled.
    const recent = this.entries
      .filter((e) => e.agentId === agentId)
      .slice(-30)
      .reverse();
    for (const e of recent) {
      if (e.severity !== f.severity) continue;
      const fRoute = f.route ?? '';
      if (fRoute !== '' || e.route !== '') {
        if (!sameRouteFamily(e.route, fRoute)) continue;
      }
      const existingTokens = tokeniseTitle(e.title);
      if (jaccard(newTokens, existingTokens) >= TITLE_JACCARD_THRESHOLD) {
        return e;
      }
    }
    return null;
  }

  /** Total count, all agents. */
  size(): number {
    return this.entries.length;
  }
}

/** Extract the challenge name from a gamification-toast-derived finding title.
 *  Matches patterns the agent typically writes:
 *    - `Challenge "View Basket" auto-solved on page load`
 *    - `Challenge View Basket auto-solved`
 *    - `[/#/] "Privacy Policy" challenge auto-solved on navigation`
 *    - `Multiple challenges auto-solved on …`  → returns null (multi-target)
 *    - `Unexpected challenge solved: "View Basket"`
 *  Returns null when the title is not a gamification finding. */
function extractChallengeName(title: string): string | null {
  // Multi-challenge titles are NOT challenge-name dedup candidates; let the
  // route-family + Jaccard logic handle them.
  if (/multiple\s+challenges/i.test(title)) return null;
  // Extract a quoted challenge name first; it's the most robust signal.
  const quoted = title.match(/(?:challenge|solved|auto-solved)[^"']*["']([^"']+)["']/i);
  if (quoted?.[1]) return quoted[1].trim().toLowerCase();
  // Fallback: `Challenge X auto-solved` without quotes.
  const bare = title.match(/challenge\s+([\w\s-]+?)\s+(?:auto-solved|solved)/i);
  if (bare?.[1]) return bare[1].trim().toLowerCase();
  return null;
}

// Internal helpers exported for unit testing without polluting the public API.
export const _internal = {
  tokeniseTitle,
  jaccard,
  normaliseRoute,
  sameRouteFamily,
  extractChallengeName,
};
