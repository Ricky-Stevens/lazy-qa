/**
 * Browser MCP server.
 *
 * In-process MCP server providing browser primitives (navigate, click, type, etc.)
 * and hosting pluggable playbooks as MCP tools:
 *   - PageModel-based snapshots (parsePage → serializeForAgent)
 *   - Pluggable logout guard
 *   - Hosted playbook tools (mounted via the skills loader)
 *   - Per-action site map recording and auth-wall detection
 *
 * Per-agent backoff and snapshot caching are optimized for latency-sensitive agent flows.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Page } from 'playwright';
import { z } from 'zod';
import { expandRoute } from '../crawler/expand.ts';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import { deepRedact, redactForLlm } from '../logging/logger.ts';
import type { EventWriter } from '../orchestrator/events.ts';
import {
  count5xxIn,
  getEffectivePauseUntil,
  recordHttpStatus,
  setAgentPause,
} from '../orchestrator/registry.ts';
import type { SharedKnowledge } from '../orchestrator/shared-knowledge.ts';
import { parsePage } from '../page-model/parser.ts';
import { serializeForAgent } from '../page-model/serialize.ts';
import type { ConsoleEntry, NetworkAnomaly, PageModel } from '../page-model/types.ts';
import type { PlaybookContext } from '../playbooks/framework.ts';
import type { PlaybookOutcome } from '../playbooks/outcome.ts';
import { isHostAllowed } from '../safety/guards.ts';
import { isLogoutLink } from '../safety/logout-guard.ts';
import type { Skill } from '../skills/loader.ts';
import type { SelectorCache } from './selector-cache.ts';

/** Per-agent backoff thresholds (carried over from v1). */
const BACKOFF_5XX_THRESHOLD = 5;
const BACKOFF_WINDOW_MS = 30_000;
const BACKOFF_DURATION_MS = 10_000;
const PAUSE_SLEEP_CAP_MS = 30_000;

const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 20_000;

/** Maximum console messages to retain. */
const CONSOLE_BUFFER_LIMIT = 50;
/** Maximum buffered network anomalies. */
const NETWORK_BUFFER_LIMIT = 30;

/** Cached PageModel TTL — same idea as v1 snapshot cache. */
const MODEL_CACHE_TTL_MS = 2_500;

/** A tool exposed by this server, in a form usable by EITHER the Claude Agent
 * SDK MCP wrapping OR the direct Anthropic API path (which converts shapes to
 * JSON Schema via z.toJSONSchema).
 *
 * Shape type intentionally matches `z.ZodRawShape` so playbook-derived raw
 * tools (from the skills loader) are assignment-compatible with
 * the locally-built ones. */
export interface RawToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>;
  /** When true, only agents whose profileName is in `ATTACKER_PROFILES` see
   *  this tool. Used for primitives that are only valuable to attack-flavoured
   *  personas (raw HTTP, JWT decode, storage inspect, JS evaluate). Functional
   *  personas don't need them and granting them encourages security drift. */
  attackerOnly?: boolean;
}

/** Profiles considered "attacker-flavoured". Tools marked `attackerOnly` are
 *  only exposed to agents whose profileName matches. Listed here (not on the
 *  tool definitions themselves) so we can add new attacker profiles centrally. */
export const ATTACKER_PROFILES: ReadonlySet<string> = new Set([
  'bobby-tables',
  'johnny-five',
  'clippy',
  'zero-cool',
  'dilbert',
  'sudo',
  'mystique',
  'rickroll',
  'trust-me-bro',
  'mitnick',
]);

export interface BrowserServerInput {
  /** Returns the page the agent should drive. Closure-style so caller can
   * swap pages mid-run. */
  getPage: () => Page;
  logger: Logger;
  /** Agent ID — used for runtime registry pause/backoff and supervisor visibility. */
  agentId?: string;
  /** Persona prose. Passed through to playbooks via PlaybookContext. */
  persona?: string;
  /** Run directory — for playbook screenshot writes etc. */
  runDir: string;
  /** Shared site map accessor. Playbook outcomes are recorded here. */
  siteMap: SiteMapAccessor;
  /** Playbook skills to mount as MCP tools. Sourced from the skills bundle. */
  playbooks: Skill[];
  /** Hook invoked on every action with current url + tool name + auth-wall flag. */
  onAction?: (patch: { url: string; toolName: string; authWalled: boolean }) => void;
  /** Hosts the agent is allowed to navigate/fetch to. document/xhr/fetch
   * requests to hosts not on this list are refused with a text error result.
   * Subresources (css, font, image, etc.) are always allowed so CDN-backed
   * staging portals continue to work. */
  allowedHosts?: string[];
  /** Event writer for this run. Optional — emits navigate events. */
  events?: EventWriter;
  /** Persistent selector cache for find_and_click. Optional — undefined when
   *  selector_cache.enabled is false in the run config. */
  selectorCache?: SelectorCache;
  /** Shared cross-agent intelligence store. Used by `try_login` to mark
   *  credentials as verified after a successful login attempt — other agents
   *  on their next turn see the [verified] tag and trust the creds. */
  sharedKnowledge?: SharedKnowledge;
}

/** Accessibility node interface for rendering the AX tree. */
interface AxNode {
  role?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  children?: AxNode[];
}

/** Render an accessibility tree node and its children as an indented text outline. */
function renderAxTree(node: AxNode, maxDepth: number, depth = 0): string {
  if (depth > maxDepth) return '';
  const indent = '  '.repeat(depth);
  const role = node.role || 'unknown';
  const name = node.name ? ` "${node.name.slice(0, 60)}"` : '';
  const value = node.value ? ` = ${node.value.slice(0, 40)}` : '';
  const flags = [
    node.disabled && 'disabled',
    node.checked === true && 'checked',
    node.selected === true && 'selected',
    node.expanded === true && 'expanded',
  ]
    .filter(Boolean)
    .join(',');
  const flagsStr = flags ? ` [${flags}]` : '';
  const self = `${indent}${role}${name}${value}${flagsStr}`;
  const children = (node.children ?? [])
    .map((c) => renderAxTree(c, maxDepth, depth + 1))
    .filter(Boolean)
    .join('\n');
  return children ? `${self}\n${children}` : self;
}

/** Detect whether the page's browser context is already authenticated as the
 *  given username. Returns a short evidence string when matched, null otherwise.
 *  Looks at:
 *   1. localStorage `token`-shaped entries (decoded JWT email/sub matches)
 *   2. Cookies `token`-shaped entries (decoded JWT email/sub matches)
 *   3. Generic session cookies (length > 16) — when no JWT decodes successfully,
 *      we accept "session-shaped cookie present" as evidence to skip the
 *      re-login. The username comparison is best-effort.
 *
 *  This is the short-circuit used by try_login to avoid re-filling the login
 *  form when an agent has already inherited auth via storageState. */
async function detectExistingAuth(
  page: import('playwright').Page,
  username: string,
): Promise<string | null> {
  // 1. localStorage tokens — Juice Shop puts the JWT here under `token`.
  const lsHit = await page
    .evaluate(() => {
      try {
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        if (!ls) return null;
        const candidates: Array<{ key: string; value: string }> = [];
        for (let i = 0; i < ls.length; i += 1) {
          const k = ls.key(i);
          if (!k) continue;
          if (/token|jwt|auth|session|access/i.test(k)) {
            const v = ls.getItem(k) ?? '';
            if (v.length >= 16) candidates.push({ key: k, value: v });
          }
        }
        return candidates;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (lsHit && lsHit.length > 0) {
    for (const cand of lsHit) {
      const claim = decodeJwtClaim(cand.value);
      if (claim && claimMatchesUser(claim, username)) {
        return `localStorage[${cand.key}] JWT matches ${username}`;
      }
    }
    // No JWT match — the bare presence of a session-shaped key is still
    // strong evidence the storageState carried an auth from a previous phase.
    return `localStorage[${lsHit[0]?.key}] session value present`;
  }

  // 2. Cookies — fall back when localStorage was empty.
  try {
    const cookies = await page.context().cookies(page.url());
    for (const c of cookies) {
      if (!/token|jwt|auth|session/i.test(c.name)) continue;
      if (c.value.length < 16) continue;
      const claim = decodeJwtClaim(c.value);
      if (claim && claimMatchesUser(claim, username)) {
        return `cookie[${c.name}] JWT matches ${username}`;
      }
      return `cookie[${c.name}] session value present`;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Best-effort JWT-payload decode. Returns null on any structural failure. */
function decodeJwtClaim(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const pad = (s: string): string => s + '='.repeat((4 - (s.length % 4)) % 4);
    const std = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(pad(std), 'base64').toString('utf8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Walk a JWT claim looking for the requested username. Juice Shop nests it
 *  under `data.email`; many providers use `email` or `sub` at the top level. */
function claimMatchesUser(claim: Record<string, unknown>, username: string): boolean {
  const target = username.toLowerCase();
  function walk(node: unknown): boolean {
    if (typeof node === 'string') return node.toLowerCase() === target;
    if (Array.isArray(node)) return node.some((n) => walk(n));
    if (node && typeof node === 'object') {
      for (const v of Object.values(node)) if (walk(v)) return true;
    }
    return false;
  }
  return walk(claim);
}

/** Strip query/fragment so /clients?page=2 and /clients/123 count as the same area. */
function routeOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

/** Auth-wall URL detector. Conservative: only flags Auth0 visible-form pages. */
export function isAuthWallUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (!/\.auth0\.com$/i.test(u.hostname)) return false;
    return /^\/(u\/login|u\/logout|v2\/logout|oidc\/logout)(\/|$|\?)/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Cheap hint-level logout check — used by find_and_click before any DOM lookup. */
function hintLooksLikeLogout(hint: string): boolean {
  return isLogoutLink({
    text: hint,
    ariaLabel: '',
    href: '',
    testid: '',
    title: '',
  }).matched;
}

/** Resolve a Playwright locator and ask the plugin guard whether it points at
 * a logout control. Returns `{matched: false}` if the locator doesn't match
 * anything (so the caller can let Playwright produce its usual "not found"
 * error instead of being silently blocked). */
async function locatorIsLogout(
  locator: import('playwright').Locator,
): Promise<{ matched: boolean; reason?: string }> {
  try {
    if ((await locator.count()) === 0) return { matched: false };
    // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
    type BrowserAny = any;
    const info = await locator.first().evaluate((el: BrowserAny) => {
      const text = ((el.textContent ?? '') as string).trim().slice(0, 80);
      const ariaLabel = (el.getAttribute?.('aria-label') ?? '') as string;
      const href = (el.getAttribute?.('href') ?? '') as string;
      const testid = (el.getAttribute?.('data-testid') ?? '') as string;
      const title = (el.getAttribute?.('title') ?? '') as string;
      return { text, ariaLabel, href, testid, title };
    });
    return isLogoutLink(info);
  } catch {
    // Inspection failed — be permissive (don't block on inspection error).
    return { matched: false };
  }
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Render a PlaybookOutcome as a compact text block for the MCP tool result. */
function serializeOutcome(outcome: PlaybookOutcome): string {
  const lines: string[] = [];
  lines.push(`playbook: ${outcome.playbookName}`);
  lines.push(`status: ${outcome.status}`);
  lines.push(`summary: ${outcome.summary}`);
  if (outcome.steps.length > 0) {
    lines.push('steps:');
    for (const s of outcome.steps) {
      const flag = s.ok ? 'ok' : 'FAIL';
      const detail = s.detail ? ` — ${s.detail}` : '';
      lines.push(`  - [${flag}] ${s.label}${detail}`);
    }
  }
  const evidenceKeys = Object.keys(outcome.evidence ?? {});
  if (evidenceKeys.length > 0) {
    let evidenceJson: string;
    try {
      evidenceJson = redactForLlm(outcome.evidence, 1500);
    } catch {
      evidenceJson = '[unserializable]';
    }
    lines.push(`evidence: ${evidenceJson}`);
  }
  if (outcome.signals.networkAnomalies.length > 0) {
    lines.push(`network anomalies: ${outcome.signals.networkAnomalies.length}`);
  }
  if (outcome.signals.consoleErrors.length > 0) {
    lines.push(`console errors: ${outcome.signals.consoleErrors.length}`);
  }
  if (outcome.screenshotPath) {
    lines.push(`screenshot: ${outcome.screenshotPath}`);
  }
  lines.push(`durationMs: ${outcome.durationMs}`);
  return lines.join('\n');
}

export function createBrowserMcpServer(input: BrowserServerInput): {
  mcpServer: ReturnType<typeof createSdkMcpServer>;
  rawTools: RawToolDef[];
} {
  const {
    getPage,
    logger,
    agentId,
    persona,
    runDir,
    siteMap,
    playbooks,
    onAction,
    allowedHosts = [],
    events,
    selectorCache,
  } = input;

  // Console + network buffers. Drained into PageModel.signals on each parse,
  // and surfaced via the dedicated console_errors tool. Listeners re-attached
  // when getPage() returns a different page (post-relogin etc.).
  const consoleBuffer: ConsoleEntry[] = [];
  const networkBuffer: NetworkAnomaly[] = [];
  let lastListenerPage: Page | null = null;

  /** Push runtime state to the registry — supervisor reads this to spot stuck agents. */
  function reportToRegistry(page: Page, what: string): void {
    if (!onAction) return;
    const url = page.url();
    onAction({
      url,
      toolName: what.split('(')[0] ?? what,
      authWalled: isAuthWallUrl(url),
    });
  }

  /**
   * Sleep at the start of an action when paused. Pause can come from
   * per-agent 4xx backoff or from supervisor's pause_agents.
   */
  async function awaitPauseIfNeeded(): Promise<void> {
    if (!agentId) return;
    const { until, reason } = getEffectivePauseUntil(agentId);
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    const sleepMs = Math.min(remaining, PAUSE_SLEEP_CAP_MS);
    logger.info('browser.pause.sleeping', {
      agentId,
      sleepMs,
      reason,
      pauseUntil: until,
    });
    await new Promise<void>((r) => setTimeout(r, sleepMs));
  }

  /** Drain currently-buffered signals into a fresh array (and clear the buffer).
   * The arrays returned are owned by the caller — callers MUST NOT mutate the
   * shared buffer through them. */
  function drainSignals(): { network: NetworkAnomaly[]; console: ConsoleEntry[] } {
    const network = networkBuffer.splice(0, networkBuffer.length);
    const consoleEntries = consoleBuffer.splice(0, consoleBuffer.length);
    return { network, console: consoleEntries };
  }

  /** Compact status-line suffix flagging silent failures (4xx, console errors)
   * since the last action. We inspect the buffers without draining: signals
   * are also fed into PageModel.signals on the next parsePage call. */
  function statusSignalsSuffix(): string {
    if (consoleBuffer.length === 0 && networkBuffer.length === 0) return '';
    const parts: string[] = [];
    if (networkBuffer.length > 0) {
      const recent = networkBuffer.slice(-5);
      parts.push(
        `net: ${recent
          .map(
            (n) => `${n.status} ${n.method} ${n.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}`,
          )
          .join(' / ')}`,
      );
    }
    if (consoleBuffer.length > 0) {
      const recent = consoleBuffer.slice(-3);
      parts.push(
        `console: ${recent.map((c) => `[${c.level}] ${c.text.slice(0, 100)}`).join(' / ')}`,
      );
    }
    return ` ⚠️ since last action — ${parts.join(' || ')}`;
  }

  /** Per-route turn counter — for status-line text only, no behaviour gates. */
  const turnByRoute = new Map<string, number>();
  function bumpTurn(page: Page): { route: string; turn: number } {
    const route = routeOf(page.url());
    const next = (turnByRoute.get(route) ?? 0) + 1;
    turnByRoute.set(route, next);
    return { route, turn: next };
  }

  function statusOk(page: Page, what: string): string {
    const { route, turn } = bumpTurn(page);
    reportToRegistry(page, what);
    return `OK ${what} | URL: ${page.url()} [turn ${turn} | route ${route}]${statusSignalsSuffix()}`;
  }
  function statusFail(page: Page, what: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const { route, turn } = bumpTurn(page);
    reportToRegistry(page, what);
    return `FAIL ${what} | ${msg} | URL: ${page.url()} [turn ${turn} | route ${route}]${statusSignalsSuffix()}`;
  }

  // ─── PageModel cache ─────────────────────────────────────────────────────
  // Speculative pre-fetch: after every action we kick off a parsePage in the
  // background. The agent's NEXT inference runs in parallel with the parse,
  // so when they call snapshot the model is already on disk.
  let inFlight: Promise<PageModel> | null = null;
  let cached: { value: PageModel; ts: number } | null = null;
  let cacheGeneration = 0;

  function invalidateModelCache(): void {
    cacheGeneration += 1;
    cached = null;
    inFlight = null;
  }

  async function parseFresh(page: Page): Promise<PageModel> {
    // Snapshot-then-clear the buffers so the resulting model carries the
    // signals captured up to this point.
    const signals = drainSignals();
    return parsePage(page, signals);
  }

  function speculate(page: Page): void {
    const myGen = ++cacheGeneration;
    const promise = parseFresh(page).then(
      (value) => {
        if (myGen !== cacheGeneration) return value;
        cached = { value, ts: Date.now() };
        return value;
      },
      (err) => {
        logger.debug('browser.parsePage.speculative.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Return a stub on failure so the in-flight promise still resolves.
        return {
          url: '',
          route: '',
          title: '',
          forms: [],
          tables: [],
          modals: [],
          wizards: [],
          toolbars: [],
          navLinks: [],
          bareInteractives: [],
          bareFields: [],
          network: [],
          console: [],
          textHash: '',
          looksBroken: true,
          interactiveCount: 0,
          capturedAt: new Date().toISOString(),
        } satisfies PageModel;
      },
    );
    inFlight = promise;
  }

  /** Returns a cached or freshly-parsed model. Used by both the snapshot tool
   * and the playbook context. */
  async function getOrParseModel(): Promise<PageModel> {
    const page = ensureListeners();
    if (cached && Date.now() - cached.ts < MODEL_CACHE_TTL_MS) return cached.value;
    if (inFlight) {
      try {
        const v = await inFlight;
        if (v.url) {
          if (!cached) cached = { value: v, ts: Date.now() };
          return v;
        }
      } catch {
        /* fall through */
      }
    }
    const v = await parseFresh(page);
    cached = { value: v, ts: Date.now() };
    return v;
  }

  function attachConsoleListeners(page: Page) {
    if (lastListenerPage === page) return;
    lastListenerPage = page;
    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      consoleBuffer.push({
        ts: new Date().toISOString(),
        level: type,
        text: msg.text().slice(0, 500),
        url: page.url(),
      });
      if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) consoleBuffer.shift();
    });
    page.on('pageerror', (err) => {
      consoleBuffer.push({
        ts: new Date().toISOString(),
        level: 'pageerror',
        text: (err.message ?? String(err)).slice(0, 500),
        url: page.url(),
      });
      if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) consoleBuffer.shift();
    });
    page.on('response', (resp) => {
      const status = resp.status();
      if (status < 400) return;
      // Skip the navigation response itself — only XHR/fetch/document
      // subresources surface as anomalies (avoids double-flagging 404 nav).
      const type = resp.request().resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      networkBuffer.push({
        ts: Date.now(),
        status,
        method: resp.request().method(),
        url: resp.url(),
        resourceType: type,
      });
      if (networkBuffer.length > NETWORK_BUFFER_LIMIT) networkBuffer.shift();
      // Mirror into the registry for cross-agent visibility + per-agent
      // backoff. The storm-detection counter (recordHttpStatus → count5xxIn)
      // is intentionally selective:
      //
      //   - `document` 5xx = the agent navigated directly to a route that
      //     500'd (e.g. /api/Orders, /rest/admin/X). That's URL-guessing —
      //     same intent as a speculative playbook probe. Logged but NOT
      //     counted. The previous run's storm cascade was triggered entirely
      //     by document-type 5xx from agent navigates.
      //   - `xhr` / `fetch` 5xx = a page's background request broke during
      //     normal interaction. THAT is the page genuinely breaking under
      //     the agent's hands. Counted.
      //
      // Note: speculative-playbook 5xx are also excluded (probeDepth>0 in
      // registry.recordHttpStatus). The two filters compose.
      if (agentId) {
        const stormRelevant = type === 'xhr' || type === 'fetch';
        if (stormRelevant) {
          recordHttpStatus(agentId, status);
          if (status >= 500 && status < 600) {
            const recent5xx = count5xxIn(agentId, BACKOFF_WINDOW_MS);
            if (recent5xx >= BACKOFF_5XX_THRESHOLD) {
              const until = Date.now() + BACKOFF_DURATION_MS;
              setAgentPause(agentId, until);
              logger.warn('browser.backoff.5xx', {
                agentId,
                recent5xx,
                windowMs: BACKOFF_WINDOW_MS,
                pauseMs: BACKOFF_DURATION_MS,
              });
            }
          }
        }
      }
    });
  }

  // Eager attach. The caller (spawn-agent) constructs us only after login.
  try {
    attachConsoleListeners(getPage());
  } catch {
    // page not ready yet; will retry on first tool call
  }

  /** Helper to ensure listeners stay attached. Cheap idempotent check. */
  function ensureListeners(): Page {
    const page = getPage();
    attachConsoleListeners(page);
    return page;
  }

  // ─── Raw tool table ─────────────────────────────────────────────────────
  // Captured for both the MCP path (createSdkMcpServer) and the direct-API
  // path. Each defTool entry produces both an SDK tool() and a RawToolDef.
  const rawTools: RawToolDef[] = [];
  function defTool<S extends Record<string, z.ZodTypeAny>>(
    name: string,
    description: string,
    shape: S,
    handler: (args: { [K in keyof S]: z.infer<S[K]> }) => Promise<{
      content: { type: 'text'; text: string }[];
    }>,
    options?: { attackerOnly?: boolean },
  ) {
    rawTools.push({
      name,
      description,
      shape,
      handler: handler as (args: Record<string, unknown>) => Promise<{
        content: { type: 'text'; text: string }[];
      }>,
      attackerOnly: options?.attackerOnly,
    });
    return tool(name, description, shape, handler as never);
  }

  // Per-agent recent-navigate ring buffer for loop detection. Tracks the last
  // 12 navigates so a repeated visit to the same URL can return a hint instead
  // of silently re-loading. Last run, power-user navigated to /#/complain 15
  // times — burning ~30 turns on a single dead route.
  const recentNavTargets: string[] = [];
  const NAV_LOOP_WINDOW = 12;
  const NAV_LOOP_THRESHOLD = 3;

  const primitiveTools = [
    defTool(
      'snapshot',
      'Return a structured snapshot of the current page (forms, tables, modals, wizards, toolbars, nav). Defaults to a serialized PageModel produced by parsing the live DOM. Pass `full: true` to force a re-parse rather than reusing the cached model. Use this whenever you need to see what is on the page.',
      { full: z.boolean().optional() },
      async ({ full }) => {
        const page = ensureListeners();
        let model: PageModel;
        if (full) {
          invalidateModelCache();
          model = await parseFresh(page);
          cached = { value: model, ts: Date.now() };
        } else {
          model = await getOrParseModel();
        }
        return textResult(redactForLlm(serializeForAgent(model)));
      },
    ),

    defTool(
      'ax_snapshot',
      "Return the page's accessibility tree as a YAML outline. Faster and cheaper than full snapshot — use when you just need to know what's present, not when you need locator strings or form schemas.",
      { max_depth: z.number().int().min(1).max(20).optional() },
      async (args) => {
        const page = ensureListeners();
        const maxDepth = (args as { max_depth?: number }).max_depth ?? 8;
        // page.accessibility.snapshot() was removed in Playwright 1.42; use
        // page.ariaSnapshot() which returns a YAML representation of the AX
        // tree. Truncate by line-count if max_depth is below the default
        // (rough proxy — depth-aware trimming would need a YAML parse pass
        // and isn't worth the complexity for a "what's on this page?" tool).
        const yaml = await page.ariaSnapshot();
        const lines = yaml.split('\n');
        const cap = maxDepth >= 8 ? lines.length : maxDepth * 80;
        const truncated = lines.slice(0, cap).join('\n');
        return textResult(redactForLlm(truncated));
      },
    ),

    defTool(
      'navigate',
      'Navigate to a URL. Returns a status line. Records anomalies (4xx/5xx/console) seen since the last action.',
      { url: z.string().url() },
      async ({ url }) => {
        if (allowedHosts.length > 0 && !isHostAllowed(url, allowedHosts)) {
          let hostname = url;
          try {
            hostname = new URL(url).hostname;
          } catch {
            /* invalid url — use raw */
          }
          // Emit refused navigate event.
          const fromUrl = (() => {
            try {
              return getPage().url();
            } catch {
              return '';
            }
          })();
          await events?.write({
            type: 'navigate',
            agentId: agentId ?? 'unknown',
            fromUrl,
            toUrl: url,
            refused: true,
            reason: `${hostname} not in allowed_hosts`,
          });
          return textResult(`navigate refused: ${hostname} not in allowed_hosts`);
        }
        const page = ensureListeners();
        const fromUrl = page.url();
        await awaitPauseIfNeeded();
        invalidateModelCache();

        // Loop-detection: count this URL's recurrence in the recent ring.
        const occurrences = recentNavTargets.filter((u) => u === url).length;
        recentNavTargets.push(url);
        if (recentNavTargets.length > NAV_LOOP_WINDOW) recentNavTargets.shift();

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          // Wait briefly for SPA hydration so the post-nav PageModel sees the
          // fully-rendered nav/forms/tables. Best-effort — non-fatal on timeout.
          try {
            await page.waitForLoadState('networkidle', { timeout: 2_500 });
          } catch {
            await page.waitForTimeout(500);
          }
        } catch (err) {
          return textResult(statusFail(page, `navigate(${url})`, err));
        }
        // Emit successful navigate event.
        await events?.write({
          type: 'navigate',
          agentId: agentId ?? 'unknown',
          fromUrl,
          toUrl: page.url(),
          refused: false,
        });
        // Grow the shared sitemap with whatever the agent just discovered, so
        // the next agent's snapshot sees this route. Best-effort — sitemap
        // failures must not break navigation.
        try {
          await expandRoute(siteMap, page, page.url(), {
            logger,
            allowedHosts,
          });
        } catch (err) {
          logger.debug('navigate.expand.error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        speculate(page);
        // Append a loop-detection hint to the navigate result when we've been
        // here repeatedly. The page actually loaded — we're not blocking. Just
        // signalling that further visits to the same route are unlikely to
        // surface new affordances and the agent should pick something else.
        let baseStatus = statusOk(page, `navigate(${url})`);
        if (occurrences >= NAV_LOOP_THRESHOLD) {
          baseStatus = `${baseStatus}\n[nav-loop] You've navigated to this URL ${occurrences + 1} times in your last ${recentNavTargets.length} navigations and nothing new has surfaced. STOP returning here. Pick a route from the snapshot you have NOT yet exercised, or pivot to a different action class (fill_form, click an unexplored button, fetch_resource a new endpoint).`;
        }
        return textResult(baseStatus);
      },
    ),

    defTool('back', 'Browser back. Returns a status line.', {}, async () => {
      const page = ensureListeners();
      await awaitPauseIfNeeded();
      invalidateModelCache();
      await page
        .goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined);
      speculate(page);
      return textResult(statusOk(page, 'back'));
    }),

    defTool(
      'reload',
      'Reload the current page. Critical for QA persistence verification — after saving a form, reload to confirm the change actually persisted. Returns a status line.',
      {},
      async () => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        await page
          .reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
          .catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined);
        speculate(page);
        return textResult(statusOk(page, 'reload'));
      },
    ),

    defTool(
      'hover',
      "Hover the cursor over an element. Reveals hover-only menus (kebabs, tooltips, dropdown menus) that aren't visible until hovered. Locator follows the same shape as click. Returns a status line.",
      { locator: z.string().min(1) },
      async ({ locator }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        try {
          await page.locator(locator).first().hover({ timeout: 5_000 });
          // Brief settle so hover-triggered menus render before next action.
          await page.waitForTimeout(150);
          return textResult(statusOk(page, `hover(${locator})`));
        } catch (err) {
          return textResult(statusFail(page, `hover(${locator})`, err));
        }
      },
    ),

    defTool(
      'wait_for_selector',
      'Wait for a Playwright locator to be visible (or hidden) before continuing. Use this when an action triggered an async render and you want to assert the new element appeared. `state` defaults to "visible"; pass "hidden" for the inverse. `timeoutMs` defaults to 5000.',
      {
        locator: z.string().min(1),
        state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
        timeoutMs: z.number().int().min(100).max(30_000).optional(),
      },
      async ({ locator, state, timeoutMs }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        try {
          await page
            .locator(locator)
            .first()
            .waitFor({ state: state ?? 'visible', timeout: timeoutMs ?? 5_000 });
          return textResult(`OK wait_for_selector(${locator}, state=${state ?? 'visible'})`);
        } catch (err) {
          return textResult(
            `FAIL wait_for_selector(${locator}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    defTool(
      'scroll_to',
      "Scroll an element into view. Use when a button or link is below the fold and Playwright's auto-scroll on click isn't doing enough (e.g. inside a virtualised list). Locator follows the same shape as click.",
      { locator: z.string().min(1) },
      async ({ locator }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        try {
          await page.locator(locator).first().scrollIntoViewIfNeeded({ timeout: 3_000 });
          return textResult(`OK scroll_to(${locator})`);
        } catch (err) {
          return textResult(
            `FAIL scroll_to(${locator}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    defTool(
      'get_text',
      'Read the visible text content of an element. Returns the trimmed innerText (capped at 2 KB). Use this to verify a saved value is displayed correctly without dropping back into evaluate. Locator follows the same shape as click.',
      { locator: z.string().min(1) },
      async ({ locator }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        try {
          const text = await page.locator(locator).first().innerText({ timeout: 3_000 });
          const trimmed = (text ?? '').trim();
          const capped = trimmed.length > 2048 ? `${trimmed.slice(0, 2048)}…` : trimmed;
          return textResult(`text(${locator}): ${redactForLlm(capped)}`);
        } catch (err) {
          return textResult(
            `FAIL get_text(${locator}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    defTool(
      'get_value',
      'Read the current value of an input/textarea/select. Use to verify a form field carries the expected value (round-trip persistence checks). Locator follows the same shape as click.',
      { locator: z.string().min(1) },
      async ({ locator }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        try {
          const value = await page.locator(locator).first().inputValue({ timeout: 3_000 });
          const capped = (value ?? '').length > 2048 ? `${value.slice(0, 2048)}…` : value;
          return textResult(`value(${locator}): ${redactForLlm(capped)}`);
        } catch (err) {
          return textResult(
            `FAIL get_value(${locator}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    defTool(
      'upload_file',
      'Set the files on a file input. The harness writes a small synthetic file (PNG/PDF/text per kind) to a temp path and points the input at it. Use this to test file-size limits, content-type validation, and upload error handling. `kind` controls the file type generated; `sizeBytes` controls payload size (capped at 5 MB). Locator must point at an `<input type="file">`.',
      {
        locator: z.string().min(1),
        kind: z.enum(['png', 'jpeg', 'pdf', 'txt', 'svg', 'html']).optional(),
        sizeBytes: z.number().int().min(1).max(5_000_000).optional(),
      },
      async ({ locator, kind, sizeBytes }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        const k = kind ?? 'png';
        const size = sizeBytes ?? 1024;
        try {
          const tmp = await import('node:os').then((m) => m.tmpdir());
          const path = await import('node:path');
          const fs = await import('node:fs/promises');
          const filename = `regress-upload-${Date.now()}.${k}`;
          const filepath = path.join(tmp, filename);
          // Generate a small synthetic file. For binary kinds we just write
          // padding bytes — most upload validators check magic-bytes / mime-type
          // separately and the test value is in seeing how the app handles
          // arbitrary content under that extension.
          const header = (() => {
            switch (k) {
              case 'png':
                return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
              case 'jpeg':
                return Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
              case 'pdf':
                return Buffer.from('%PDF-1.4\n');
              case 'svg':
                return Buffer.from(
                  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
                );
              case 'html':
                return Buffer.from(
                  '<!doctype html><html><body><script>alert(1)</script></body></html>',
                );
              default:
                return Buffer.from('regress-harness synthetic upload\n');
            }
          })();
          const padBytes = Math.max(0, size - header.length);
          const buf = Buffer.concat([header, Buffer.alloc(padBytes, 0x41)]);
          await fs.writeFile(filepath, buf);
          await page.locator(locator).first().setInputFiles(filepath, { timeout: 5_000 });
          return textResult(
            `OK upload_file(${locator}, ${k}, ${buf.length} bytes) — file at ${filepath}`,
          );
        } catch (err) {
          return textResult(
            `FAIL upload_file(${locator}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    defTool(
      'set_dialog_response',
      'Configure how the next browser-native dialog (alert, confirm, prompt) is handled. Default behaviour without this is to dismiss. Pass `accept: true` to accept the dialog (clicks OK / yes); supply `text` to fill a prompt(). The setting applies to the NEXT dialog only and is then cleared.',
      {
        accept: z.boolean(),
        text: z.string().optional(),
      },
      async ({ accept, text }) => {
        const page = ensureListeners();
        const handler = async (dialog: import('playwright').Dialog) => {
          try {
            if (accept) await dialog.accept(text);
            else await dialog.dismiss();
          } catch {
            // ignore
          } finally {
            page.off('dialog', handler);
          }
        };
        page.once('dialog', handler);
        return textResult(
          `OK set_dialog_response(accept=${accept}${text !== undefined ? `, text=${JSON.stringify(text)}` : ''}) — applies to next dialog only`,
        );
      },
    ),

    defTool(
      'submit_form',
      'Submit a form programmatically via form.requestSubmit() (or .submit() fallback). Use when the visible submit button is disabled by client validation but you want to test the server-side path anyway. Locator must point at a `<form>` element. Returns a status line.',
      { locator: z.string().min(1) },
      async ({ locator }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        try {
          await page
            .locator(locator)
            .first()
            .evaluate(((el: unknown) => {
              // biome-ignore lint/suspicious/noExplicitAny: DOM types not in Node lib
              const node = el as any;
              const form = node?.tagName === 'FORM' ? node : node?.closest?.('form');
              if (!form) throw new Error('no form ancestor found');
              if (typeof form.requestSubmit === 'function') {
                form.requestSubmit();
              } else {
                form.submit();
              }
            }) as never);
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
          return textResult(statusOk(page, `submit_form(${locator})`));
        } catch (err) {
          return textResult(statusFail(page, `submit_form(${locator})`, err));
        }
      },
    ),

    defTool(
      'click',
      'Click an element. Locator: Playwright role-or-text selector — `role=button[name="Save"]`, `text="Cancel"`, `[data-testid="x"]`, `#id`. Returns a status line. Logout controls are blocked by the harness.',
      {
        locator: z.string().min(2),
        force: z
          .boolean()
          .optional()
          .describe('Bypass visibility/enabled checks. Use only for stubborn elements.'),
      },
      async ({ locator, force }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        const logoutCheck = await locatorIsLogout(page.locator(locator).first());
        if (logoutCheck.matched) {
          return textResult(
            `REFUSED click(${locator}) — target appears to be a logout control (${logoutCheck.reason}). Logout would terminate the shared session for ALL agents. ${statusOk(page, `click_blocked(${locator})`)}`,
          );
        }
        try {
          await page.locator(locator).first().click({ timeout: ACTION_TIMEOUT_MS, force });
        } catch (err) {
          return textResult(statusFail(page, `click(${locator})`, err));
        }
        speculate(page);
        return textResult(statusOk(page, `click(${locator})`));
      },
    ),

    defTool(
      'type',
      'Type text into a field. Clears first unless append=true. Set submit=true to press Enter after.',
      {
        locator: z.string().min(2),
        text: z.string(),
        append: z.boolean().optional(),
        submit: z.boolean().optional(),
      },
      async ({ locator, text, append, submit }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        try {
          const field = page.locator(locator).first();
          if (!append) await field.fill(text, { timeout: ACTION_TIMEOUT_MS });
          else await field.pressSequentially(text, { timeout: ACTION_TIMEOUT_MS });
          if (submit) await field.press('Enter');
        } catch (err) {
          return textResult(statusFail(page, `type(${locator})`, err));
        }
        speculate(page);
        return textResult(statusOk(page, `type(${locator})`));
      },
    ),

    defTool(
      'press_key',
      'Press a keyboard key (Tab/Enter/Escape/ArrowDown/F5).',
      { key: z.string().min(1) },
      async ({ key }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        await page.keyboard.press(key, { delay: 0 }).catch(() => undefined);
        speculate(page);
        return textResult(statusOk(page, `press(${key})`));
      },
    ),

    defTool(
      'select_option',
      'Pick an option from a <select> by visible label or value.',
      {
        locator: z.string().min(2),
        label: z.string().optional(),
        value: z.string().optional(),
      },
      async ({ locator, label, value }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        try {
          const target = label !== undefined ? { label } : { value: value ?? '' };
          await page.locator(locator).first().selectOption(target, { timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
          return textResult(statusFail(page, `select(${locator})`, err));
        }
        speculate(page);
        return textResult(statusOk(page, `select(${locator})`));
      },
    ),

    defTool(
      'console_errors',
      'Return console errors and page errors observed since the last call (then clear the buffer). Call after weird behaviour.',
      {},
      async () => {
        ensureListeners();
        if (consoleBuffer.length === 0) {
          return textResult('No console errors since last check.');
        }
        const lines = consoleBuffer.map((e) =>
          redactForLlm(`[${e.level}] ${e.url ? `${e.url} — ` : ''}${e.text}`, 1024),
        );
        consoleBuffer.length = 0;
        return textResult(`${lines.length} console events:\n${lines.join('\n')}`);
      },
    ),

    defTool(
      'evaluate',
      'Run a small JS expression OR multi-statement body in the page and return its JSON-stringified result. Read-only inspection only (document.title, localStorage, performance entries). Multi-statement bodies (containing `;`) are supported automatically — the wrapper falls back to body-mode on syntax error. Do NOT use to fetch — `fetch_resource` / `request_with_session` are the right tools for that.',
      { expression: z.string().min(1).max(2000) },
      async ({ expression }) => {
        const page = ensureListeners();
        reportToRegistry(page, 'evaluate');
        await awaitPauseIfNeeded();
        // Two-pass evaluation: try expression-mode first (single expression
        // wrapped in parens — succeeds for `localStorage.length`,
        // `document.title.toUpperCase()` etc.). If that produces a SyntaxError,
        // fall back to body-mode (multi-statement function body — succeeds
        // for `localStorage.setItem('foo','bar'); 'done'`). Without the
        // body-mode fallback the attacker's typical "set a token then probe
        // it" patterns hit `SyntaxError: Unexpected token ';'` at the wrapper.
        const exprWrapped = `async () => { try { return JSON.stringify(await Promise.resolve((${expression}))); } catch (e) { try { return String(await Promise.resolve((${expression}))); } catch (e2) { return 'evaluate threw: ' + (e2 && e2.message || String(e2)); } } }`;
        const bodyWrapped = `async () => { try { const __r = await (async () => { ${expression} })(); return typeof __r === 'undefined' ? 'undefined' : JSON.stringify(__r); } catch (e) { return 'evaluate threw: ' + (e && e.message || String(e)); } }`;
        async function runWrapped(wrapped: string): Promise<string> {
          return (page.evaluate as unknown as (fn: string) => Promise<string>)(wrapped);
        }
        try {
          let result: string;
          try {
            result = await runWrapped(exprWrapped);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/SyntaxError/.test(msg)) {
              // Almost certainly a multi-statement body — retry with body wrapper.
              result = await runWrapped(bodyWrapped);
            } else {
              throw err;
            }
          }
          // result is the JSON.stringify output from the page. Parse it back so
          // deepRedact can walk the object tree and strip secret-keyed fields.
          // If the result is not valid JSON (e.g. the String() fallback fired),
          // fall back to treating it as a plain string.
          let parsed: unknown;
          try {
            parsed = JSON.parse(result);
          } catch {
            parsed = result;
          }
          const safeResult = redactForLlm(parsed);
          return textResult(`evaluate result: ${safeResult}`);
        } catch (err) {
          logger.warn('browser.evaluate.failed', {
            expression,
            error: err instanceof Error ? err.message : String(err),
          });
          return textResult(`evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      { attackerOnly: true },
    ),

    defTool(
      'fetch_resource',
      "Plain HTTP GET (or other method) of a URL on the same origin or any allowed host. Cookie-less by default — does NOT use the agent's session cookies. Returns the response status, headers, and body (truncated to 4 KB). Use this for: reading exposed paths (.git/HEAD, .env, swagger.json), reading JSON API responses without rendering them, fetching response bodies that the SPA shell would otherwise hide. For session-aware requests use `request_with_session` instead.",
      {
        url: z.string().url(),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      },
      async ({ url, method, headers, body }) => {
        if (allowedHosts.length > 0 && !isHostAllowed(url, allowedHosts)) {
          return textResult(`fetch_resource refused: ${url} not in allowed_hosts.`);
        }
        onAction?.({ url, toolName: 'fetch_resource', authWalled: false });
        const startedAt = Date.now();
        try {
          const resp = await fetch(url, {
            method: method ?? 'GET',
            headers: headers ?? {},
            body: body ?? undefined,
            redirect: 'manual',
          });
          const respHeaders: Record<string, string> = {};
          resp.headers.forEach((v, k) => {
            respHeaders[k] = v;
          });
          const text = await resp.text();
          const truncated = text.length > 4096;
          const safeBody = redactForLlm(truncated ? text.slice(0, 4096) : text, 4096);
          return textResult(
            [
              `status: ${resp.status} ${resp.statusText}`,
              `headers: ${JSON.stringify(respHeaders)}`,
              `body (${text.length} bytes${truncated ? ', truncated to 4 KB' : ''}):`,
              safeBody,
              `durationMs: ${Date.now() - startedAt}`,
            ].join('\n'),
          );
        } catch (err) {
          return textResult(
            `fetch_resource failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      { attackerOnly: true },
    ),

    defTool(
      'request_with_session',
      "Same as fetch_resource but uses the current browser context's cookies — i.e. requests are made AS the logged-in user. Use after a login (yours, recon's, or a teammate's) when you want to hit an authenticated API endpoint without rendering it as a page. Body is truncated to 4 KB.",
      {
        url: z.string().url(),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      },
      async ({ url, method, headers, body }) => {
        if (allowedHosts.length > 0 && !isHostAllowed(url, allowedHosts)) {
          return textResult(`request_with_session refused: ${url} not in allowed_hosts.`);
        }
        onAction?.({ url, toolName: 'request_with_session', authWalled: false });
        const page = ensureListeners();
        const startedAt = Date.now();
        try {
          const apiCtx = page.context().request;
          const resp = await apiCtx.fetch(url, {
            method: method ?? 'GET',
            headers: headers ?? {},
            data: body ?? undefined,
            maxRedirects: 0,
          });
          const respHeaders = resp.headers();
          const text = await resp.text();
          const truncated = text.length > 4096;
          const safeBody = redactForLlm(truncated ? text.slice(0, 4096) : text, 4096);
          return textResult(
            [
              `status: ${resp.status()} ${resp.statusText()}`,
              `headers: ${JSON.stringify(respHeaders)}`,
              `body (${text.length} bytes${truncated ? ', truncated to 4 KB' : ''}):`,
              safeBody,
              `durationMs: ${Date.now() - startedAt}`,
            ].join('\n'),
          );
        } catch (err) {
          return textResult(
            `request_with_session failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      { attackerOnly: true },
    ),

    defTool(
      'decode_jwt',
      'Decode a JWT (the three base64url-encoded segments separated by `.`). Returns the parsed header + payload. Use this when you have a token from try_login, share_with_team, localStorage, a cookie, or a query parameter — to inspect alg, claims (sub, role, scope), expiry, and to spot weak signatures (alg=none, alg=HS256 with a guessable secret).',
      { token: z.string().min(8) },
      async ({ token }) => {
        const parts = token.split('.');
        if (parts.length < 2) {
          return textResult(
            `decode_jwt failed: not a JWT (got ${parts.length} segment(s), need 2-3).`,
          );
        }
        function b64urlDecode(s: string): string {
          const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
          const std = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
          return Buffer.from(std, 'base64').toString('utf8');
        }
        try {
          const header = JSON.parse(b64urlDecode(parts[0] ?? ''));
          const payload = JSON.parse(b64urlDecode(parts[1] ?? ''));
          const sigPresent = parts.length === 3 && (parts[2] ?? '').length > 0;
          return textResult(
            [
              `header: ${JSON.stringify(header)}`,
              `payload: ${JSON.stringify(redactForLlm(payload))}`,
              `signature: ${sigPresent ? `present (${(parts[2] ?? '').length} chars)` : 'EMPTY — alg=none vulnerability candidate'}`,
            ].join('\n'),
          );
        } catch (err) {
          return textResult(
            `decode_jwt failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      { attackerOnly: true },
    ),

    // ─── Compound macros ──────────────────────────────────────────────────
    defTool(
      'fill_form',
      'Fill multiple fields in one round-trip and optionally submit. Each field is matched by `locator` (Playwright selector) and filled with `value`. Returns a status line summarising how many fields succeeded. MUCH cheaper than calling `type` N times.',
      {
        fields: z
          .array(
            z.object({
              locator: z
                .string()
                .min(2)
                .describe(
                  'Playwright locator. Examples: `input[name="email"]`, `role=textbox[name="Name"]`, `[data-testid="x"]`.',
                ),
              value: z.string(),
            }),
          )
          .min(1)
          .max(20),
        submit: z
          .union([
            z.boolean(),
            z.string().describe('Locator of submit button. If true, presses Enter on last field.'),
          ])
          .optional(),
      },
      async ({ fields, submit }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        const failures: string[] = [];
        let succeeded = 0;
        for (const f of fields) {
          try {
            await page.locator(f.locator).first().fill(f.value, { timeout: ACTION_TIMEOUT_MS });
            succeeded += 1;
          } catch (err) {
            failures.push(
              `${f.locator}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
            );
          }
        }
        let submitOutcome = '';
        const lastField = fields[fields.length - 1];
        if (submit === true && lastField) {
          try {
            await page
              .locator(lastField.locator)
              .first()
              .press('Enter', { timeout: ACTION_TIMEOUT_MS });
            submitOutcome = ' | submitted via Enter';
          } catch (err) {
            submitOutcome = ` | submit Enter failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
          }
        } else if (typeof submit === 'string') {
          try {
            await page.locator(submit).first().click({ timeout: ACTION_TIMEOUT_MS });
            submitOutcome = ` | clicked submit ${submit}`;
          } catch (err) {
            submitOutcome = ` | submit click failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
          }
        }
        speculate(page);
        const failPart = failures.length ? ` | failed: ${failures.join('; ')}` : '';
        return textResult(
          `fill_form: ${succeeded}/${fields.length} ok${submitOutcome}${failPart} | URL: ${page.url()}`,
        );
      },
    ),

    defTool(
      'find_and_click',
      'Find a button or link by visible text or role, then click. Tries multiple matching strategies in order (role+name → text → aria-label → partial text). Use this instead of `click` when you only know what the element says, not its exact selector. Logout controls are blocked.',
      {
        hint: z
          .string()
          .min(1)
          .describe('Visible text, button label, or link text. Case-insensitive.'),
        role: z
          .enum(['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch', 'any'])
          .optional()
          .describe('Restrict to a specific role. Default: any clickable element.'),
      },
      async ({ hint, role }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();
        // Cheap hint-level check before we start probing the DOM.
        if (hintLooksLikeLogout(hint)) {
          return textResult(
            `REFUSED find_and_click("${hint}") — hint matches a logout control. ${statusOk(page, `find_and_click_blocked("${hint}")`)}`,
          );
        }

        // ── Selector cache lookup ─────────────────────────────────────────
        // On a cache hit, attempt to click the cached locator with a short
        // timeout. Success: return early and skip the multi-strategy probe.
        // Failure (stale): invalidate the route and fall through.
        const urlForCache = new URL(page.url());
        const cachedLocator = selectorCache?.get(urlForCache.pathname, hint, role);
        if (cachedLocator) {
          try {
            await page.locator(cachedLocator).first().click({ timeout: 2_000 });
            speculate(page);
            return textResult(
              `OK find_and_click("${hint}") via cache → ${cachedLocator} | URL: ${page.url()}`,
            );
          } catch {
            // Cached locator is stale — remove route entries and re-probe.
            selectorCache?.invalidateRoute(urlForCache.pathname);
          }
        }

        // ── Multi-strategy probe ──────────────────────────────────────────
        const escapedHint = hint.replace(/"/g, '\\"');
        const candidates: string[] = [];
        if (role && role !== 'any') {
          candidates.push(`role=${role}[name="${escapedHint}"]`);
          candidates.push(`role=${role}[name=/${escapedHint}/i]`);
        } else {
          for (const r of ['button', 'link', 'tab', 'menuitem']) {
            candidates.push(`role=${r}[name="${escapedHint}"]`);
          }
          candidates.push(`text="${escapedHint}"`);
          candidates.push(`text=/${escapedHint}/i`);
          candidates.push(`[aria-label="${escapedHint}" i]`);
        }
        for (const sel of candidates) {
          try {
            const loc = page.locator(sel).first();
            if ((await loc.count()) === 0) continue;
            const logoutCheck = await locatorIsLogout(loc);
            if (logoutCheck.matched) {
              return textResult(
                `REFUSED find_and_click("${hint}") — resolved element is a logout control (${logoutCheck.reason}). ${statusOk(page, `find_and_click_blocked("${hint}")`)}`,
              );
            }
            await loc.click({ timeout: 3_000 });
            // Write back to cache on successful probe resolution.
            selectorCache?.set(urlForCache.pathname, hint, role, sel);
            speculate(page);
            return textResult(
              `find_and_click: matched "${hint}" via \`${sel}\` | URL: ${page.url()}`,
            );
          } catch {
            // Try next strategy
          }
        }
        return textResult(
          `find_and_click: no clickable element matched "${hint}"${role ? ` (role=${role})` : ''} | URL: ${page.url()}`,
        );
      },
    ),

    defTool(
      'try_login',
      'Attempt to log in with the given username/password. Use this when you have CREDENTIALS (from team intelligence, a SQLi dump, an exposed config file, or an FTP backup file). The tool: navigates to a login URL (or the current page if it already looks like a login form), finds username/password fields by AX role, fills them, clicks a submit-like button, and verifies success by checking that the URL or page state changed and no error message appeared. On success, the credential is auto-marked as verified in team intelligence so other agents trust it. AFTER A SUCCESSFUL LOGIN you have a much larger surface — explore authenticated routes (admin panels, account settings, order history, etc.) before going back to anonymous probing.',
      {
        username: z.string().min(1).describe('Username / email / login.'),
        password: z.string().min(1).describe('Password.'),
        login_url: z
          .string()
          .optional()
          .describe(
            'Optional explicit login URL. If omitted, the tool first checks if the current page looks like a login form; if not, it tries common paths (/login, /#/login, /signin, /auth/login).',
          ),
      },
      async ({ username, password, login_url }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateModelCache();

        // SHORT-CIRCUIT: if the session already has a valid auth token whose
        // decoded payload mentions the requested username (or any session token
        // at all when we have no claim to compare), treat this as an immediate
        // success. Without this, agents that inherited auth via storageState
        // burn turns re-filling the login form against an already-authed page —
        // Juice Shop doesn't redirect away from /#/login when authed, so
        // `try_login` interprets the missing post-fresh-login marker as failure.
        const existing = await detectExistingAuth(page, username).catch(() => null);
        if (existing) {
          input.sharedKnowledge?.markCredentialVerified(username, password);
          input.sharedKnowledge?.addCredential({
            username,
            password,
            source: `try_login (already authed) by ${input.agentId ?? 'agent'}`,
            foundBy: input.agentId ?? 'unknown',
            foundAt: new Date().toISOString(),
            loginVerified: true,
          });
          await events?.write({
            type: 'auth.try_login',
            agentId: input.agentId ?? 'unknown',
            username,
            success: true,
            detail: `already authenticated (${existing})`,
            postLoginUrl: page.url(),
          });
          logger.info('try_login.skipped.already_authed', {
            agentId: input.agentId,
            username,
            evidence: existing,
          });
          return textResult(
            `OK try_login: session is ALREADY authenticated as ${username} (${existing}). Do NOT re-attempt login. Stop visiting /login routes — instead exercise authenticated functionality (admin panel, profile, basket, order history, /api endpoints with request_with_session).`,
          );
        }

        const tryLoginCandidates = login_url
          ? [login_url]
          : [
              page.url(),
              new URL('/#/login', page.url()).toString(),
              new URL('/login', page.url()).toString(),
              new URL('/signin', page.url()).toString(),
              new URL('/auth/login', page.url()).toString(),
            ];

        const errors: string[] = [];
        for (const url of tryLoginCandidates) {
          // For the `page.url()` candidate, only proceed if it looks like a
          // login form already (saves a redundant navigation).
          if (url !== tryLoginCandidates[0] || login_url) {
            try {
              if (!isHostAllowed(url, allowedHosts ?? [])) continue;
              await page.goto(url, { timeout: 10_000, waitUntil: 'domcontentloaded' });
            } catch (err) {
              errors.push(
                `goto(${url}) failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              continue;
            }
          }

          // Locate username / password fields by role + heuristic. Try AX
          // textbox / role=email / input[type=password] etc.
          const userField = page
            .locator(
              'input[type="email"], input[name="email"], input[id="email"], input[name="username"], input[id="username"], input[name="user"], input[autocomplete="username"]',
            )
            .first();
          const passField = page
            .locator('input[type="password"], input[autocomplete="current-password"]')
            .first();
          if ((await userField.count()) === 0 || (await passField.count()) === 0) {
            errors.push(`no login form on ${page.url()}`);
            continue;
          }

          try {
            await userField.fill(username, { timeout: 3_000 });
            await passField.fill(password, { timeout: 3_000 });
          } catch (err) {
            errors.push(`fill failed: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          // Find a submit-like button. Prefer the password field's enclosing
          // form's submit; fall back to text-based locators.
          const preLoginUrl = page.url();
          const submitCandidates = [
            'button[type="submit"]',
            'input[type="submit"]',
            'role=button[name=/log\\s?in|sign\\s?in|submit/i]',
            'text=/^\\s*(log\\s?in|sign\\s?in)\\s*$/i',
          ];
          let submitted = false;
          for (const sel of submitCandidates) {
            try {
              const loc = page.locator(sel).first();
              if ((await loc.count()) === 0) continue;
              await loc.click({ timeout: 3_000 });
              submitted = true;
              break;
            } catch {
              /* try next */
            }
          }
          if (!submitted) {
            // Last resort: press Enter in the password field.
            try {
              await passField.press('Enter', { timeout: 3_000 });
              submitted = true;
            } catch (err) {
              errors.push(`submit failed: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
          }

          // Wait briefly for navigation/SPA state change. We don't insist on a
          // hard navigation — many SPAs replace state without a URL change.
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          const postLoginUrl = page.url();

          // Heuristic success: URL changed away from the login route OR a
          // user-identifying element appears (an account/avatar/logout button).
          // We additionally check for visible error messages — common failure
          // indicators on Material/Bootstrap login forms.
          const errorVisible = await page
            .locator(
              '[class*="error"], [role=alert], .mat-error, .invalid-feedback, .text-danger, .alert-danger',
            )
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          const accountMarker = await page
            .locator(
              'role=button[name=/account|profile|logout|sign\\s?out/i], [data-testid*="account"], [aria-label*="account" i], [aria-label*="logout" i]',
            )
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          const urlChanged =
            postLoginUrl !== preLoginUrl && !/login|signin|sign-in/i.test(postLoginUrl);
          const success = !errorVisible && (urlChanged || accountMarker);

          if (success) {
            input.sharedKnowledge?.markCredentialVerified(username, password);
            // Also auto-add the credential if not already in shared store —
            // an attacker may call try_login on creds they got from local
            // observation (without first sharing) and we still want the team
            // to see them.
            input.sharedKnowledge?.addCredential({
              username,
              password,
              source: `try_login by ${input.agentId ?? 'agent'}`,
              foundBy: input.agentId ?? 'unknown',
              foundAt: new Date().toISOString(),
              loginVerified: true,
            });
            await events?.write({
              type: 'auth.try_login',
              agentId: input.agentId ?? 'unknown',
              username,
              success: true,
              detail: urlChanged
                ? `URL changed: ${preLoginUrl} → ${postLoginUrl}`
                : 'account marker visible',
              postLoginUrl,
            });
            logger.info('try_login.success', {
              agentId: input.agentId,
              username,
              postLoginUrl,
            });
            return textResult(
              `OK try_login: logged in as ${username}. URL: ${postLoginUrl}. Now explore authenticated routes (admin panel, account settings, order history). Other agents have been told the credential is verified.`,
            );
          }

          // Failed but page found — record and stop trying further URLs (we
          // got far enough to fill the form, which is the strongest signal
          // we had the right page).
          await events?.write({
            type: 'auth.try_login',
            agentId: input.agentId ?? 'unknown',
            username,
            success: false,
            detail: errorVisible
              ? 'error message visible after submit'
              : 'no auth marker after submit',
            postLoginUrl,
          });
          logger.info('try_login.failed', {
            agentId: input.agentId,
            username,
            errorVisible,
          });
          return textResult(
            `FAILED try_login: form submitted but login appears unsuccessful (${errorVisible ? 'error message shown' : 'no account marker, URL still on login route'}). The credentials may be wrong, or the app uses MFA / additional steps. URL: ${postLoginUrl}`,
          );
        }

        await events?.write({
          type: 'auth.try_login',
          agentId: input.agentId ?? 'unknown',
          username,
          success: false,
          detail: `no login form located. Tried: ${tryLoginCandidates.join(' ')}. Errors: ${errors.join(' | ')}`,
        });
        return textResult(
          `FAILED try_login: could not locate a login form. Tried ${tryLoginCandidates.length} URL(s). Last errors: ${errors.slice(-3).join(' | ')}. Try passing an explicit login_url.`,
        );
      },
    ),

    defTool(
      'read_recent',
      'One-call sweep returning: serialized PageModel, console errors since last check, and last 5 network entries. Use this when you want to assess the current state after weird behaviour.',
      {},
      async () => {
        ensureListeners();
        await awaitPauseIfNeeded();
        const model = await getOrParseModel();
        const snap = redactForLlm(serializeForAgent(model));
        const errors =
          consoleBuffer.length === 0
            ? 'none'
            : consoleBuffer
                .map((e) => redactForLlm(`[${e.level}] ${e.text.slice(0, 200)}`, 1024))
                .join(' | ');
        consoleBuffer.length = 0;
        const networkSummary =
          model.network.length === 0
            ? 'none'
            : model.network
                .slice(-5)
                .map((n) => `${n.status} ${n.method} ${n.url}`)
                .join(' | ');
        return textResult(
          `${snap}\n\n--- console errors ---\n${errors}\n\n--- last 5 network anomalies ---\n${networkSummary}`,
        );
      },
    ),

    defTool(
      'storage_inspect',
      'Read browser storage (localStorage, sessionStorage, cookies). Values pass through redactForLlm so secrets stay out of the LLM context. Use this instead of `evaluate` when inspecting storage.',
      {
        kinds: z.array(z.enum(['localStorage', 'sessionStorage', 'cookies'])).optional(),
        includeValues: z.boolean().optional(),
      },
      async ({ kinds, includeValues }) => {
        const resolvedKinds =
          kinds ??
          (['localStorage', 'sessionStorage', 'cookies'] as const as Array<
            'localStorage' | 'sessionStorage' | 'cookies'
          >);
        const resolvedInclude = includeValues ?? true;
        const page = ensureListeners();
        const lines: string[] = [];

        if (resolvedKinds.includes('localStorage') || resolvedKinds.includes('sessionStorage')) {
          const dump = await page.evaluate(
            ({ wantLocal, wantSession }: { wantLocal: boolean; wantSession: boolean }) => {
              const out: { kind: string; entries: Array<[string, string]> }[] = [];
              if (wantLocal)
                out.push({
                  kind: 'localStorage',
                  entries: Object.entries({ ...localStorage }),
                });
              if (wantSession)
                out.push({
                  kind: 'sessionStorage',
                  entries: Object.entries({ ...sessionStorage }),
                });
              return out;
            },
            {
              wantLocal: resolvedKinds.includes('localStorage'),
              wantSession: resolvedKinds.includes('sessionStorage'),
            },
          );

          for (const { kind, entries } of dump) {
            lines.push(`${kind}: ${entries.length} key(s)`);
            for (const [k, v] of entries) {
              // Use deepRedact with the key name so SECRET_KEY_RE can match
              // key names like "auth_token", "api_key", etc. and redact their values.
              const rendered = resolvedInclude
                ? redactForLlm((deepRedact({ [k]: v }) as Record<string, unknown>)[k], 256)
                : '[hidden]';
              lines.push(`  - ${k}: ${rendered}`);
            }
          }
        }

        if (resolvedKinds.includes('cookies')) {
          const browserCtx = page.context();
          const cookies = await browserCtx.cookies(page.url()).catch(() => []);
          lines.push(`cookies: ${cookies.length} cookie(s)`);
          for (const c of cookies) {
            const rendered = resolvedInclude
              ? redactForLlm(
                  (deepRedact({ [c.name]: c.value }) as Record<string, unknown>)[c.name],
                  256,
                )
              : '[hidden]';
            lines.push(`  - ${c.name}: ${rendered}`);
          }
        }

        return textResult(lines.join('\n') || 'no storage entries');
      },
      { attackerOnly: true },
    ),
  ];

  // ─── Playbook tools ──────────────────────────────────────────────────────
  // For each playbook skill, build a handler that constructs the PlaybookContext
  // from the current state, runs the playbook via the skill's handler, records
  // the outcome into the SiteMap, and returns a text MCP result.
  //
  // Skills replace the old PlaybookRegistry. Each skill carries its own
  // handler function and inputShape (ZodRawShape), so we don't need the
  // registry's toMcpTools() indirection.
  const playbookRawTools: RawToolDef[] = playbooks
    .filter((skill) => skill.handler != null && skill.inputShape != null)
    .map((skill) => {
      const skillHandler = skill.handler as NonNullable<typeof skill.handler>;
      const skillInputShape = skill.inputShape as NonNullable<typeof skill.inputShape>;
      const playbookName = skill.name;

      const toolHandler = async (args: Record<string, unknown>) => {
        // Playbook execution pulls the current page lazily so a relogin between
        // turns transparently re-targets the playbook.
        const ctx: PlaybookContext = {
          page: ensureListeners(),
          pageModel: () => getOrParseModel(),
          siteMap,
          agentId: agentId ?? 'unknown',
          persona: persona ?? '',
          runDir,
          logger,
          allowedHosts,
        };

        // Invalidate before the playbook runs because most playbooks mutate the
        // page (fill, click, navigate). Easier than tracking inside each one.
        invalidateModelCache();

        // Wrap in runPlaybook-compatible try/catch for consistent error handling.
        let outcome: PlaybookOutcome;
        const start = Date.now();
        try {
          outcome = await skillHandler(args, ctx);
          outcome.durationMs = Date.now() - start;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outcome = {
            playbookName,
            status: 'failed',
            summary: `Playbook crashed: ${message}`,
            evidence: { error: message },
            signals: { networkAnomalies: [], consoleErrors: [] },
            steps: [{ label: 'playbook crashed', ok: false, detail: message }],
            durationMs: Date.now() - start,
          };
        }

        // Record outcome into the sitemap. Target-id prefer order: form > table
        // > modal > wizard. Cast to unknown then string to satisfy TS without
        // forcing every playbook input shape to declare these fields.
        const targetId =
          ((args.formId as string | undefined) ||
            (args.tableId as string | undefined) ||
            (args.modalId as string | undefined) ||
            (args.wizardId as string | undefined)) ??
          null;
        try {
          siteMap.recordPlaybookOutcome(
            routeOf(ctx.page.url()),
            playbookName,
            targetId,
            outcome.status,
          );
        } catch (err) {
          logger.warn('browser.playbook.record-outcome.failed', {
            playbook: playbookName,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // After the playbook runs, kick off a speculative re-parse so the next
        // snapshot call is instant.
        try {
          speculate(ensureListeners());
        } catch {
          /* swallow */
        }

        return textResult(serializeOutcome(outcome));
      };

      return {
        name: `mcp__playbooks__${playbookName}`,
        description: skill.description,
        shape: skillInputShape,
        handler: toolHandler,
      } satisfies RawToolDef;
    });

  // Register playbook raw tools alongside primitives. The SDK MCP server needs
  // matching tool() entries; build one per playbook that delegates to the same
  // handler we already constructed.
  const playbookSdkTools = playbookRawTools.map((rt) =>
    tool(rt.name, rt.description, rt.shape as Record<string, z.ZodTypeAny>, rt.handler as never),
  );

  for (const rt of playbookRawTools) rawTools.push(rt);

  const mcpServer = createSdkMcpServer({
    name: 'browser',
    version: '2.0.0',
    tools: [...primitiveTools, ...playbookSdkTools],
  });

  // Reference fields so they're not flagged as unused — kept for symmetry with
  // future tools and so callers can rely on them being part of the input.
  void agentId;
  void persona;
  void runDir;
  void events;

  return { mcpServer, rawTools };
}

/** Stable list of primitive + macro tool names. Playbook tool names are
 * dynamic and depend on the registry — not included here. */
export const BROWSER_TOOL_NAMES = [
  'mcp__browser__ax_snapshot',
  'mcp__browser__snapshot',
  'mcp__browser__navigate',
  'mcp__browser__back',
  'mcp__browser__reload',
  'mcp__browser__hover',
  'mcp__browser__wait_for_selector',
  'mcp__browser__scroll_to',
  'mcp__browser__get_text',
  'mcp__browser__get_value',
  'mcp__browser__upload_file',
  'mcp__browser__set_dialog_response',
  'mcp__browser__submit_form',
  'mcp__browser__click',
  'mcp__browser__type',
  'mcp__browser__press_key',
  'mcp__browser__select_option',
  'mcp__browser__console_errors',
  'mcp__browser__evaluate',
  'mcp__browser__fill_form',
  'mcp__browser__find_and_click',
  'mcp__browser__try_login',
  'mcp__browser__fetch_resource',
  'mcp__browser__request_with_session',
  'mcp__browser__decode_jwt',
  'mcp__browser__read_recent',
  'mcp__browser__storage_inspect',
] as const;
