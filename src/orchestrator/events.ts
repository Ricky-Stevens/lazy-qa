/**
 * Event-sourced run trace.
 *
 * Append-only `runs/<runId>/events.jsonl` records every meaningful state
 * change in a run. The EventWriter serialises writes via a Promise chain so
 * concurrent emit calls preserve `seq` order.
 *
 * `replayRun` reconstructs journeys + findings from an event log alone,
 * providing a validation pillar: a replayed run's findings should match the
 * live run's `findings.json` (modulo timestamps).
 */

import type { FileHandle } from 'node:fs/promises';
import type { Finding } from '../types/finding.ts';
import type { Journey, TerminationReason, TokenUsage } from '../types/journey.ts';

// ─── Event union (LOCKED taxonomy) ───────────────────────────────────────────

export type Event =
  | {
      type: 'run.start';
      ts: string;
      seq: number;
      runId: string;
      targetUrl: string;
      agentIds: string[];
    }
  | {
      type: 'run.end';
      ts: string;
      seq: number;
      runId: string;
      totalCostUsd: number;
      terminationReasons: Record<string, string>;
      totalFindings: number;
    }
  | {
      type: 'crawl.probe.submit';
      ts: string;
      seq: number;
      runId: string;
      probeId: string;
      route: string;
      kind: 'http' | 'affordance';
    }
  | {
      type: 'crawl.probe.result';
      ts: string;
      seq: number;
      runId: string;
      probeId: string;
      status: number | null;
      ok: boolean;
      durationMs: number;
    }
  | {
      type: 'crawl.complete';
      ts: string;
      seq: number;
      runId: string;
      routeCount: number;
      durationMs: number;
    }
  | {
      type: 'agent.start';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      profileName: string;
      model: string;
      plannerModel?: string;
      budget: { max_turns: number; max_minutes: number; max_usd: number };
    }
  | {
      type: 'agent.end';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      terminationReason: string;
      turns: number;
      costUsd: number;
      findingCount: number;
    }
  | {
      type: 'agent.turn.start';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      turn: number;
      modelUsed: string;
    }
  | {
      type: 'agent.turn.end';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      turn: number;
      tokenUsage: TokenUsage;
      costUsdDelta: number;
      stopReason: string;
    }
  | {
      type: 'tool.call';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      turn: number;
      name: string;
      input: unknown;
    }
  | {
      type: 'tool.result';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      turn: number;
      name: string;
      ok: boolean;
      content: string;
    }
  | {
      type: 'navigate';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      fromUrl: string;
      toUrl: string;
      refused: boolean;
      reason?: string;
    }
  | {
      type: 'finding.report';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      finding: Finding;
    }
  | {
      type: 'playbook.outcome';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      playbookName: string;
      route: string;
      targetId: string | null;
      status: 'ok' | 'suspicious' | 'failed' | 'skipped';
      durationMs: number;
      evidence: unknown;
    }
  | {
      type: 'supervisor.intervention';
      ts: string;
      seq: number;
      runId: string;
      kind: 'auth-walled' | 'backend-storm' | 'no-progress';
      detail: string;
    }
  | {
      type: 'critic.start';
      ts: string;
      seq: number;
      runId: string;
      findingCount: number;
      model: string;
    }
  | {
      type: 'critic.verdict';
      ts: string;
      seq: number;
      runId: string;
      findingId: string;
      verdict: 'confirmed_bug' | 'likely_bug' | 'duplicate' | 'environmental' | 'not_a_bug';
    }
  | {
      type: 'critic.end';
      ts: string;
      seq: number;
      runId: string;
      totalCostUsd: number;
      durationMs: number;
    }
  | {
      type: 'critic.verify.start';
      ts: string;
      seq: number;
      runId: string;
      findingId: string;
      model: string;
    }
  | {
      type: 'critic.verify.end';
      ts: string;
      seq: number;
      runId: string;
      findingId: string;
      verdict:
        | 'confirmed_reproducible'
        | 'intermittent'
        | 'not_reproducible'
        | 'environmental'
        | 'different_bug';
      costUsd: number;
    }
  | {
      // An agent published intelligence (credentials, route, or token) to the
      // shared knowledge store via share_with_team.
      type: 'team.intel.share';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      kind: 'credentials' | 'route' | 'token';
      added: boolean;
      summary: string;
      source: string;
    }
  | {
      // Supervisor issued a broadcast directive to one or all agents.
      type: 'team.broadcast';
      ts: string;
      seq: number;
      runId: string;
      message: string;
      forProfile?: string;
    }
  | {
      // try_login attempt result. Logged regardless of outcome — failure is
      // useful signal for the supervisor too.
      type: 'auth.try_login';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      username: string;
      success: boolean;
      detail: string;
      postLoginUrl?: string;
    }
  | {
      // Site classifier: heuristic analysis complete (or failed on empty sitemap).
      type: 'site-playbook.complete';
      ts: string;
      seq: number;
      runId: string;
      ok: boolean;
      siteShape: string;
      personas: string[];
      costUsd: number;
      durationMs: number;
      detail?: string;
    }
  | {
      type: 'rebalancer.tick';
      ts: string;
      seq: number;
      runId: string;
      terminated: string[];
      boosted: Record<string, number>;
      activeAgents: number;
      healthScores?: Array<{
        agentId: string;
        score: number;
        findings: number;
        turns: number;
        spent: number;
      }>;
    }
  | {
      type: 'slot.fill';
      ts: string;
      seq: number;
      runId: string;
      agentId: string;
      category: 'security' | 'qa';
      wave?: number;
      securityQueueRemaining: number;
      qaQueueRemaining: number;
      activeSlots: number;
    }
  | {
      type: 'slot.drain';
      ts: string;
      seq: number;
      runId: string;
      totalAgentsRun: number;
    };

/**
 * Distributive Omit: applies Omit to each member of a union individually,
 * then re-unions the results. This is necessary because TypeScript's built-in
 * `Omit<U, K>` collapses discriminated unions into an intersection, losing
 * all the discriminant properties.
 *
 * `EventPayload` is what callers pass to `EventWriter.write()` — it's the
 * full Event minus the three envelope fields (ts, seq, runId) that the
 * writer adds automatically.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventPayload = DistributiveOmit<Event, 'ts' | 'seq' | 'runId'>;

// ─── Content size caps ────────────────────────────────────────────────────────

const TOOL_RESULT_CONTENT_CAP = 8 * 1024; // 8 KB
const TOOL_CALL_INPUT_CAP = 4 * 1024; // 4 KB

/** Cap a string to `max` bytes. Appends `[…N bytes elided]` on truncation. */
export function capString(s: string, max: number): string {
  if (s.length <= max) return s;
  const elided = s.length - max;
  return `${s.slice(0, max)}[…${elided} bytes elided]`;
}

/** Apply the tool.result content cap (8 KB). */
export function capToolResultContent(content: string): string {
  return capString(content, TOOL_RESULT_CONTENT_CAP);
}

/** JSON-stringify tool.call input and cap at 4 KB. */
export function capToolCallInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? 'null';
  } catch {
    s = '[unserializable]';
  }
  return capString(s, TOOL_CALL_INPUT_CAP);
}

// ─── EventWriter ─────────────────────────────────────────────────────────────

/** One-line audit summary of an event. Used by the optional console tap on
 *  EventWriter so an interactive run shows progress without the operator
 *  having to tail events.jsonl. Returns null for events not worth surfacing. */
export function formatEventLine(e: Event): string | null {
  switch (e.type) {
    case 'run.start':
      return `▶ run start  target=${e.targetUrl} agents=${e.agentIds.join(',')}`;
    case 'run.end':
      return `■ run end    findings=${e.totalFindings} cost=$${e.totalCostUsd.toFixed(4)}`;
    case 'crawl.probe.submit':
      return `  crawl probe ${e.kind}  ${e.route}`;
    case 'crawl.probe.result': {
      const tag = e.ok ? 'ok' : 'fail';
      return `  crawl ${tag}     status=${e.status ?? '∅'} ${e.durationMs}ms`;
    }
    case 'crawl.complete':
      return `✓ crawl done  routes=${e.routeCount} ${e.durationMs}ms`;
    case 'agent.start':
      return `▶ agent ${e.agentId} start  profile=${e.profileName} model=${e.model}`;
    case 'agent.end':
      return `■ agent ${e.agentId} end    reason=${e.terminationReason} turns=${e.turns} cost=$${e.costUsd.toFixed(4)} findings=${e.findingCount}`;
    case 'agent.turn.start':
      return `  ${e.agentId} turn ${e.turn} start (${e.modelUsed})`;
    case 'agent.turn.end':
      return null; // too chatty
    case 'tool.call':
      return `  ${e.agentId} t${e.turn} → ${e.name}`;
    case 'tool.result':
      return e.ok ? null : `  ${e.agentId} t${e.turn} ✗ ${e.name} failed`;
    case 'navigate': {
      const tag = e.refused ? `REFUSED (${e.reason ?? 'unknown'})` : 'ok';
      return `  ${e.agentId} navigate → ${e.toUrl} ${tag}`;
    }
    case 'finding.report':
      return `  ★ finding   ${e.agentId}  ${e.finding.severity}  ${e.finding.title.slice(0, 80)}`;
    case 'playbook.outcome':
      return `  ${e.agentId} playbook ${e.playbookName} → ${e.status}`;
    case 'supervisor.intervention':
      return `  ⚠ supervisor ${e.kind}  ${e.detail.slice(0, 80)}`;
    case 'team.intel.share':
      return `  ✦ team-intel ${e.agentId} ${e.kind}${e.added ? '' : ' (dup)'}  ${e.summary.slice(0, 80)}`;
    case 'team.broadcast':
      return `  ✦ team-broadcast${e.forProfile ? ` [${e.forProfile}]` : ''}  ${e.message.slice(0, 80)}`;
    case 'auth.try_login':
      return `  ${e.success ? '✓' : '✗'} try_login ${e.agentId} as ${e.username}  ${e.detail.slice(0, 80)}`;
    case 'site-playbook.complete':
      return e.ok
        ? `■ site-classify  shape=${e.siteShape} ${e.durationMs}ms`
        : `■ site-classify FAILED  ${(e.detail ?? '').slice(0, 80)}`;
    case 'critic.start':
      return `▶ critic start  findings=${e.findingCount} model=${e.model}`;
    case 'critic.verdict':
      return `  critic verdict ${e.findingId} → ${e.verdict}`;
    case 'critic.end':
      return `■ critic done  cost=$${e.totalCostUsd.toFixed(4)} ${e.durationMs}ms`;
    case 'critic.verify.start':
      return `  ▶ verify ${e.findingId} (${e.model})`;
    case 'critic.verify.end':
      return `  ■ verify ${e.findingId} → ${e.verdict} cost=$${e.costUsd.toFixed(4)}`;
    case 'rebalancer.tick':
      return null; // too chatty for console
    case 'slot.fill':
      return `  ▶ slot fill ${e.agentId} (${e.category}${e.wave ? ` w${e.wave}` : ''})  active=${e.activeSlots} secQ=${e.securityQueueRemaining} qaQ=${e.qaQueueRemaining}`;
    case 'slot.drain':
      return `  ■ all agents complete  total=${e.totalAgentsRun}`;
    default:
      return null;
  }
}

export class EventWriter {
  private seq = 0;
  private fd: FileHandle | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Optional tap: when set, every event is also fed to this consumer in
   *  addition to being persisted. Used by `bin/regress.ts` to print a
   *  human-readable audit log to stderr while the run is in progress. */
  public consoleTap: ((e: Event) => void) | null = null;

  constructor(
    private filepath: string,
    private runId: string,
  ) {}

  async open(): Promise<void> {
    const { open } = await import('node:fs/promises');
    this.fd = await open(this.filepath, 'a');
  }

  /**
   * Append one event. Resolves after the line is flushed to disk.
   *
   * The serial Promise chain ensures append order matches `seq` order even
   * when multiple callers await write() concurrently.
   */
  write(event: EventPayload): Promise<void> {
    const enriched = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      runId: this.runId,
      ...event,
    } as Event;
    const line = `${JSON.stringify(enriched)}\n`;
    if (this.consoleTap) {
      try {
        this.consoleTap(enriched);
      } catch {
        // Tap failures must not break the persistent write path.
      }
    }
    this.queue = this.queue.then(async () => {
      if (!this.fd) throw new Error('EventWriter not open');
      try {
        await this.fd.write(line);
      } catch {
        // Swallow individual write failures so one bad write doesn't
        // poison the queue chain for all subsequent writes.
      }
    });
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.fd) {
      await this.fd.close();
      this.fd = null;
    }
  }
}

// ─── Reader ───────────────────────────────────────────────────────────────────

export async function readEvents(filepath: string): Promise<Event[]> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filepath, 'utf8');
  return content
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Event);
}

// ─── Replayer ─────────────────────────────────────────────────────────────────

export interface ReplayResult {
  runId: string;
  journeys: Journey[];
  findings: Finding[];
}

/**
 * Reconstruct journey state + findings from an event log.
 *
 * Returns the same shape as the original run's journeys + findings.json.
 * Findings are collected from `finding.report` events and deduplicated by id.
 */
export function replayRun(events: Event[]): ReplayResult {
  // Sort by seq to handle any out-of-order delivery.
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  let runId = '';

  // Per-agent journey state, keyed by agentId.
  const journeyMap = new Map<string, Journey>();

  // Global findings map (deduped by finding.id).
  const findingsById = new Map<string, Finding>();

  for (const ev of sorted) {
    if (!runId && ev.runId) runId = ev.runId;

    switch (ev.type) {
      case 'run.start': {
        runId = ev.runId;
        break;
      }

      case 'agent.start': {
        const journey: Journey = {
          runId: ev.runId,
          agentId: ev.agentId,
          startedAt: ev.ts,
          startUrl: '',
          turns: 0,
          findings: [],
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          costUsd: 0,
          terminationReason: undefined,
        };
        journeyMap.set(ev.agentId, journey);
        break;
      }

      case 'agent.end': {
        const j = journeyMap.get(ev.agentId);
        if (j) {
          j.endedAt = ev.ts;
          j.terminationReason = ev.terminationReason as TerminationReason;
          j.turns = ev.turns;
          j.costUsd = ev.costUsd;
        }
        break;
      }

      case 'agent.turn.end': {
        const j = journeyMap.get(ev.agentId);
        if (j) {
          j.tokenUsage.input += ev.tokenUsage.input;
          j.tokenUsage.output += ev.tokenUsage.output;
          j.tokenUsage.cacheRead += ev.tokenUsage.cacheRead;
          j.tokenUsage.cacheWrite += ev.tokenUsage.cacheWrite;
        }
        break;
      }

      case 'finding.report': {
        const { finding } = ev;
        if (!findingsById.has(finding.id)) {
          findingsById.set(finding.id, finding);
        }
        // Also attach to the journey so journey.findings is populated.
        const j = journeyMap.get(ev.agentId);
        if (j && !j.findings.some((f) => f.id === finding.id)) {
          j.findings.push(finding);
        }
        break;
      }

      case 'navigate': {
        // Update journey startUrl on first navigate event if not set.
        const j = journeyMap.get(ev.agentId);
        if (j && !j.startUrl) {
          j.startUrl = ev.toUrl;
        }
        break;
      }

      // Other event types don't directly reconstruct journey/finding state.
      default:
        break;
    }
  }

  const journeys = Array.from(journeyMap.values());
  const findings = Array.from(findingsById.values());

  return { runId, journeys, findings };
}
