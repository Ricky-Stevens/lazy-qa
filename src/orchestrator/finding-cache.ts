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

export class FindingCache {
  private entries: KnownFindingRef[] = [];

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

  /** Total count, all agents. */
  size(): number {
    return this.entries.length;
  }
}
