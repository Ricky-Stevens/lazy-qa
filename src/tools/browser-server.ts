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
  count4xxIn,
  getEffectivePauseUntil,
  recordHttpStatus,
  setAgentPause,
} from '../orchestrator/registry.ts';
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
const BACKOFF_4XX_THRESHOLD = 5;
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
}

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
      // backoff (this server).
      if (agentId) {
        recordHttpStatus(agentId, status);
        if (status >= 400 && status < 500) {
          const recent4xx = count4xxIn(agentId, BACKOFF_WINDOW_MS);
          if (recent4xx >= BACKOFF_4XX_THRESHOLD) {
            const until = Date.now() + BACKOFF_DURATION_MS;
            setAgentPause(agentId, until);
            logger.warn('browser.backoff.4xx', {
              agentId,
              recent4xx,
              windowMs: BACKOFF_WINDOW_MS,
              pauseMs: BACKOFF_DURATION_MS,
            });
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
  ) {
    rawTools.push({
      name,
      description,
      shape,
      handler: handler as (args: Record<string, unknown>) => Promise<{
        content: { type: 'text'; text: string }[];
      }>,
    });
    return tool(name, description, shape, handler as never);
  }

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
      "Return the page's accessibility tree as a text outline. Faster and cheaper than full snapshot — use when you just need to know what's present, not when you need locator strings or form schemas.",
      { max_depth: z.number().int().min(1).max(20).optional() },
      async (args) => {
        const page = ensureListeners();
        const maxDepth = (args as { max_depth?: number }).max_depth ?? 8;
        // biome-ignore lint/suspicious/noExplicitAny: Playwright Page.accessibility API
        const snapshot = await (page as any).accessibility.snapshot({ interestingOnly: true });
        if (!snapshot) return textResult('(no accessibility tree available)');
        const text = renderAxTree(snapshot as AxNode, maxDepth);
        return textResult(redactForLlm(text));
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
        return textResult(statusOk(page, `navigate(${url})`));
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
      'Run a small JS expression in the page and return its JSON-stringified result. Read-only inspection only (document.title, localStorage, performance entries). Do NOT use to mutate state.',
      { expression: z.string().min(1).max(2000) },
      async ({ expression }) => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        try {
          const wrapped = `() => { try { return JSON.stringify((${expression})); } catch (e) { return String((${expression})); } }`;
          const result = await (page.evaluate as unknown as (fn: string) => Promise<string>)(
            wrapped,
          );
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
  'mcp__browser__click',
  'mcp__browser__type',
  'mcp__browser__press_key',
  'mcp__browser__select_option',
  'mcp__browser__console_errors',
  'mcp__browser__evaluate',
  'mcp__browser__fill_form',
  'mcp__browser__find_and_click',
  'mcp__browser__read_recent',
  'mcp__browser__storage_inspect',
] as const;
