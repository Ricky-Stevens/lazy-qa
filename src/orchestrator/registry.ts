/**
 * Module-level registry of agent runtime state.
 *
 * Updated by the explorer agents (per-action via the browser server, per-turn
 * via spawn-agent). Read by the supervisor agent so it can detect stuck or
 * auth-walled agents and intervene.
 *
 * All state lives in this module — there is exactly one registry per Bun
 * process. That's fine because we run one harness invocation per process.
 */

const RECENT_TOOLS_LIMIT = 8;
const HTTP_STATUS_BUFFER_LIMIT = 50;

export type AgentLifecycle = 'starting' | 'active' | 'auth_walled' | 'finished' | 'errored';

interface HttpStatusEntry {
  ts: number;
  status: number;
}

export interface AgentRuntimeState {
  agentId: string;
  profileName: string;
  startedAt: number;
  /** Last assistant turn from the SDK — increments on every model response. */
  lastTurnAt: number | null;
  /** Last action against the live page (click/type/navigate/etc). */
  lastActionAt: number | null;
  /** URL the agent's tab is currently on. */
  currentUrl: string | null;
  /** Set true when an action's URL matches an auth-wall pattern. Cleared after
   * a successful relogin nudge consumed by the agent. */
  authWalled: boolean;
  findingsCount: number;
  turnsCompleted: number;
  /** Bounded ring buffer of recent tool names — supervisor reads this to spot
   * "5 clicks on the same locator with no findings" loops. */
  recentTools: string[];
  status: AgentLifecycle;
  /** A message queued by the supervisor. The agent's chunk loop drains this
   * at chunk start and prepends it to the user prompt. */
  pendingNudge: string | null;
  /** Bounded ring buffer of recent backend HTTP statuses observed by the
   * browser server's network listener. Used to detect 4xx storms (WAF/rate-limit
   * /backend-down) and trigger per-agent backoff. */
  recentHttpStatuses: HttpStatusEntry[];
  /** When set in the future, the browser server's action tools sleep until this
   * time before executing. Used by per-agent backoff and supervisor pause. */
  pauseUntil: number | null;
}

const states = new Map<string, AgentRuntimeState>();

/** Module-level pause set by the supervisor's `pause_agents` tool. Affects all
 * agents simultaneously regardless of their per-agent pauseUntil. */
let globalPauseUntil = 0;
let globalPauseReason: string | null = null;

export function registerAgent(agentId: string, profileName: string): void {
  states.set(agentId, {
    agentId,
    profileName,
    startedAt: Date.now(),
    lastTurnAt: null,
    lastActionAt: null,
    currentUrl: null,
    authWalled: false,
    findingsCount: 0,
    turnsCompleted: 0,
    recentTools: [],
    status: 'starting',
    pendingNudge: null,
    recentHttpStatuses: [],
    pauseUntil: null,
  });
}

export function updateOnAction(
  agentId: string,
  patch: { url?: string; toolName?: string; authWalled?: boolean },
): void {
  const s = states.get(agentId);
  if (!s) return;
  s.lastActionAt = Date.now();
  if (s.status === 'starting') s.status = 'active';
  if (patch.url !== undefined) s.currentUrl = patch.url;
  if (patch.toolName) {
    s.recentTools.push(patch.toolName);
    if (s.recentTools.length > RECENT_TOOLS_LIMIT) s.recentTools.shift();
  }
  if (patch.authWalled !== undefined) {
    s.authWalled = patch.authWalled;
    if (patch.authWalled) s.status = 'auth_walled';
    else if (s.status === 'auth_walled') s.status = 'active';
  }
}

export function updateOnTurn(
  agentId: string,
  patch: { turnsCompleted?: number; findingsCount?: number },
): void {
  const s = states.get(agentId);
  if (!s) return;
  s.lastTurnAt = Date.now();
  if (typeof patch.turnsCompleted === 'number') s.turnsCompleted = patch.turnsCompleted;
  if (typeof patch.findingsCount === 'number') s.findingsCount = patch.findingsCount;
}

export function setStatus(agentId: string, status: AgentLifecycle): void {
  const s = states.get(agentId);
  if (!s) return;
  s.status = status;
}

/**
 * Push a supervisor-issued nudge for the agent. The agent's chunked loop
 * drains this at the next chunk boundary and prepends it to its user prompt.
 *
 * Subsequent calls overwrite — the supervisor's most recent guidance wins.
 */
export function pushNudge(agentId: string, message: string): boolean {
  const s = states.get(agentId);
  if (!s) return false;
  s.pendingNudge = message;
  return true;
}

/** Atomically read-and-clear the agent's pending nudge. */
export function consumeNudge(agentId: string): string | null {
  const s = states.get(agentId);
  if (!s) return null;
  const m = s.pendingNudge;
  s.pendingNudge = null;
  return m;
}

/** Snapshot ALL agents — used by the supervisor's `list_agents` tool. */
export function snapshotAll(): AgentRuntimeState[] {
  return Array.from(states.values()).map((s) => ({
    ...s,
    recentTools: [...s.recentTools],
    recentHttpStatuses: [...s.recentHttpStatuses],
  }));
}

/**
 * Record a backend HTTP status observed by the browser server's network
 * listener. We keep ~50 entries (~30s worth at typical action rates) so the
 * supervisor and per-agent backoff can spot 4xx/5xx storms.
 */
export function recordHttpStatus(agentId: string, status: number): void {
  const s = states.get(agentId);
  if (!s) return;
  s.recentHttpStatuses.push({ ts: Date.now(), status });
  if (s.recentHttpStatuses.length > HTTP_STATUS_BUFFER_LIMIT) s.recentHttpStatuses.shift();
}

/** How many 4xx responses has this agent seen in the last `windowMs` ms? */
export function count4xxIn(agentId: string, windowMs: number): number {
  const s = states.get(agentId);
  if (!s) return 0;
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (const entry of s.recentHttpStatuses) {
    if (entry.ts >= cutoff && entry.status >= 400 && entry.status < 500) n += 1;
  }
  return n;
}

/** Set per-agent pause-until timestamp. Browser server actions wait until then
 * (capped per-call) before executing. Used by per-agent backoff. */
export function setAgentPause(agentId: string, untilMs: number): void {
  const s = states.get(agentId);
  if (!s) return;
  // Honour the larger of existing and new — concurrent triggers shouldn't shorten.
  if (s.pauseUntil == null || untilMs > s.pauseUntil) s.pauseUntil = untilMs;
}

/** Module-level pause set by the supervisor. Affects every agent. */
export function setGlobalPause(untilMs: number, reason: string): void {
  if (untilMs > globalPauseUntil) {
    globalPauseUntil = untilMs;
    globalPauseReason = reason;
  }
}

/** Compute the maximum of (per-agent pause, global pause). Returns 0 if neither
 * is in the future. Browser server actions sleep until this value. */
export function getEffectivePauseUntil(agentId: string): {
  until: number;
  reason: string | null;
} {
  const s = states.get(agentId);
  const agentPause = s?.pauseUntil ?? 0;
  if (globalPauseUntil > agentPause && globalPauseUntil > Date.now()) {
    return { until: globalPauseUntil, reason: globalPauseReason };
  }
  if (agentPause > Date.now()) return { until: agentPause, reason: 'per-agent backoff' };
  return { until: 0, reason: null };
}

/** Read-only snapshot of the global pause for telemetry. */
export function getGlobalPauseSnapshot(): { until: number; reason: string | null } {
  return { until: globalPauseUntil, reason: globalPauseReason };
}

/** Reset the registry — used by tests; not called in production runs. */
export function _resetRegistry(): void {
  states.clear();
  globalPauseUntil = 0;
  globalPauseReason = null;
}
