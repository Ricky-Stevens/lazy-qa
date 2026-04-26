import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import {
  count4xxIn,
  getEffectivePauseUntil,
  recordHttpStatus,
  setAgentPause,
} from '../orchestrator/registry.ts';

/** Per-agent backoff thresholds. Tuned for typical WAF/rate-limit cool-downs:
 * if an agent sees ≥5 4xx in 30s, the next action sleeps 10s. The supervisor
 * can layer a longer global pause on top via pause_agents. */
const BACKOFF_4XX_THRESHOLD = 5;
const BACKOFF_WINDOW_MS = 30_000;
const BACKOFF_DURATION_MS = 10_000;
/** Cap how long any single tool call will sleep on a pause. Keeps us responsive
 * to the agent's wall-clock budget; if the pause is longer the agent's NEXT
 * action will sleep again. */
const PAUSE_SLEEP_CAP_MS = 30_000;

/** A tool exposed by this server, in a form usable by EITHER the Claude Agent
 * SDK MCP wrapping OR the direct Anthropic API path (which converts shapes to
 * JSON Schema via z.toJSONSchema). */
export interface RawToolDef {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>;
}

/**
 * Lightweight in-process Playwright tool server.
 *
 * Optimised for LLM-in-the-loop speed:
 *
 * 1. **Actions return a one-line status, not a snapshot.** A click or type used
 *    to dump 6K of accessibility tree into the model's context every time. Now
 *    they return `OK | URL: ...` (~50 chars). The model calls `snapshot`
 *    explicitly when it needs to see the new page state — most of the time it
 *    doesn't, because it already knows the layout from the previous snapshot.
 * 2. **Snapshot uses a custom DOM walker via page.evaluate**, not Playwright's
 *    full ariaSnapshot. ariaSnapshot computes a complete a11y tree (1-2s on
 *    rich pages); the custom walker returns just visible interactive elements
 *    and headings in <200ms.
 * 3. **Console errors are captured passively** via page.on listeners and
 *    buffered, so reading them is a near-instant lookup.
 *
 * Combined: per-turn latency drops from 10-15s to 3-5s on Haiku, and the model
 * can batch multiple actions into a single turn for further perceived speedup.
 */

const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 20_000;

/** Cap snapshot output. The custom DOM walker already returns far less than the
 * old ariaSnapshot, but pages with long lists can still exceed this. */
const SNAPSHOT_CHAR_CAP = 6_000;

/** Maximum console messages to retain. Older entries are dropped. */
const CONSOLE_BUFFER_LIMIT = 50;

interface ConsoleEntry {
  ts: string;
  level: 'error' | 'warning' | 'pageerror';
  text: string;
  url?: string;
}

// Browser-side runtime is the DOM, but our tsconfig deliberately excludes the
// DOM lib (we only run in Bun). Inside `page.evaluate`, the function runs in
// the page; we use this alias to opt out of strict typing for that one block.
// biome-ignore lint/suspicious/noExplicitAny: DOM types not in tsconfig.lib
type BrowserAny = any;

/** Structured snapshot data — used by both full and diff renderers. */
interface SnapshotData {
  url: string;
  title: string;
  items: string[];
  truncated: boolean;
}

/**
 * Fast page-state extractor. Runs in the page via evaluate so we avoid the
 * Playwright protocol round-trips of ariaSnapshot. Returns visible interactive
 * elements + headings + landmarks. ~10-50× faster than `ariaSnapshot()` on
 * most pages.
 */
async function fastSnapshot(page: Page): Promise<SnapshotData> {
  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {
    // page may have closed mid-call
  }

  // Runs in the page (DOM globals exist there). The BrowserAny alias above is
  // our single any-escape for this block.
  const browserFn = (): string => {
    const w: BrowserAny = (globalThis as BrowserAny).window;
    const doc: BrowserAny = (globalThis as BrowserAny).document;

    const isVisible = (el: BrowserAny): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = w.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity || '1') < 0.05) return false;
      return true;
    };

    const sel = [
      'h1',
      'h2',
      'h3',
      'h4',
      'button',
      'a[href]',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      'tr',
      'th',
      '[onclick]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="combobox"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="radio"]',
      '[role="row"]',
      '[role="rowheader"]',
      '[role="columnheader"]',
      '[role="gridcell"]',
      '[role="cell"]',
      '[role="treeitem"]',
      '[role="option"]',
      '[role="dialog"]',
      '[role="alert"]',
      '[aria-label]:not([aria-hidden="true"])',
      '[data-testid]',
    ].join(',');

    const els: BrowserAny[] = Array.from(doc.querySelectorAll(sel));
    const out: string[] = [];
    const MAX = 250;
    let truncated = false;
    const seen = new Set<BrowserAny>();

    for (const el of els) {
      if (out.length >= MAX) {
        truncated = true;
        break;
      }
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;

      const tag = String(el.tagName).toLowerCase();
      const explicitRole = el.getAttribute('role');
      const inputType = tag === 'input' ? el.getAttribute('type') || 'text' : null;
      const role =
        explicitRole ??
        (tag === 'a'
          ? 'link'
          : tag === 'button'
            ? 'button'
            : inputType
              ? `input[${inputType}]`
              : tag);

      // Name resolution. Icon-only buttons typically have NO text but DO have
      // aria-label, title, an inner <svg><title>, or data-tooltip. We surface
      // every signal so the agent never sees a useless "(unlabeled)" entry it
      // will skip — kebab menus, edit pencils, etc. all become clickable hints.
      const ariaLabel = el.getAttribute('aria-label');
      const title = el.getAttribute('title');
      const placeholder = el.getAttribute('placeholder');
      const tooltip = el.getAttribute('data-tooltip') || el.getAttribute('data-original-title');
      const value = el.value;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const svgTitle = (() => {
        try {
          const t = el.querySelector('svg title, [aria-label]');
          return t ? (t.getAttribute('aria-label') || t.textContent || '').trim() : '';
        } catch {
          return '';
        }
      })();
      const iconHint = (() => {
        try {
          const icon = el.querySelector('[class*="icon"], [class*="Icon"], svg');
          if (!icon) return '';
          const cls = (icon.getAttribute('class') || '').toString();
          const m = cls.match(/(?:^|\s)(?:fa-|icon-|i-)([a-z0-9-]+)/i);
          return m ? m[1] : '';
        } catch {
          return '';
        }
      })();

      const id = el.id ? `#${el.id}` : '';
      const testid = el.getAttribute('data-testid');
      const ref = id || (testid ? `[data-testid="${testid}"]` : '');

      const name = String(
        ariaLabel ||
          text ||
          title ||
          svgTitle ||
          tooltip ||
          placeholder ||
          value ||
          (iconHint ? `icon:${iconHint}` : '') ||
          (testid ? `testid:${testid}` : '') ||
          '',
      ).slice(0, 100);

      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      const checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
      const flags = [disabled ? 'disabled' : '', checked ? 'checked' : '']
        .filter(Boolean)
        .join(',');

      out.push(
        `${role}${ref ? ` ${ref}` : ''}: "${name || '(unlabeled)'}"${flags ? ` [${flags}]` : ''}`,
      );
    }

    return JSON.stringify({ items: out, truncated });
  };

  let body: string;
  try {
    body = await page.evaluate(browserFn);
  } catch (err) {
    return {
      url,
      title,
      items: [`[snapshot failed: ${err instanceof Error ? err.message : String(err)}]`],
      truncated: false,
    };
  }

  try {
    const parsed = JSON.parse(body) as { items: string[]; truncated: boolean };
    return { url, title, items: parsed.items, truncated: parsed.truncated };
  } catch {
    return { url, title, items: ['[snapshot parse failed]'], truncated: false };
  }
}

/** Render the full snapshot for the agent, capped at SNAPSHOT_CHAR_CAP. */
function formatFullSnapshot(data: SnapshotData): string {
  let rendered = data.items.join('\n');
  if (data.truncated) {
    rendered += `\n... (truncated at 250 elements; navigate to a sub-view to see more)`;
  }
  if (rendered.length > SNAPSHOT_CHAR_CAP) {
    rendered = `${rendered.slice(0, SNAPSHOT_CHAR_CAP)}\n... (truncated; ${rendered.length - SNAPSHOT_CHAR_CAP} chars omitted)`;
  }
  return `URL: ${data.url}\nTitle: ${data.title}\n\n--- visible interactive elements ---\n${rendered}`;
}

/**
 * Render only what changed since the previous snapshot. Massively cheaper than
 * a full snapshot when the page has barely moved (most clicks, most form fills,
 * most dropdown opens). When the URL changed we always fall back to full —
 * a different page is "all new" and the diff would be the entire page anyway.
 */
function formatDiffSnapshot(prev: SnapshotData, curr: SnapshotData): string {
  if (prev.url !== curr.url) {
    return `${formatFullSnapshot(curr)}\n\n[NOTE: URL changed since last snapshot; showing full state.]`;
  }
  const prevSet = new Set(prev.items);
  const currSet = new Set(curr.items);
  const added: string[] = [];
  const removed: string[] = [];
  for (const item of curr.items) if (!prevSet.has(item)) added.push(item);
  for (const item of prev.items) if (!currSet.has(item)) removed.push(item);
  const unchangedCount = curr.items.length - added.length;

  if (added.length === 0 && removed.length === 0) {
    return `URL: ${curr.url}\nTitle: ${curr.title}\n\n--- diff since last snapshot ---\n(no changes — ${curr.items.length} elements unchanged)\n\nIf you need to see the full state, call snapshot({ full: true }).`;
  }

  const lines: string[] = [];
  for (const a of added) lines.push(`+ ${a}`);
  for (const r of removed) lines.push(`- ${r}`);
  let rendered = lines.join('\n');
  if (rendered.length > SNAPSHOT_CHAR_CAP) {
    rendered = `${rendered.slice(0, SNAPSHOT_CHAR_CAP)}\n... (diff truncated)`;
  }
  return `URL: ${curr.url}\nTitle: ${curr.title}\n\n--- diff since last snapshot (+ added, - removed; ${unchangedCount} unchanged) ---\n${rendered}\n\nFor the full element list, call snapshot({ full: true }).`;
}

/**
 * Patterns identifying a logout control. Used to suppress click attempts at the
 * tool layer — a recurring failure mode is that a broken page renders ONLY a
 * "Log out" link in the header, the agent clicks it (it's the only thing on
 * screen), and the whole shared session cascades. Suppressing logout clicks
 * forces the agent to file a finding for the broken page instead.
 *
 * The text pattern intentionally only matches WHOLE strings — links titled
 * "Logout audit log" or "Sign out attempts (admin)" must remain clickable.
 */
const LOGOUT_TEXT_PATTERN = /^\s*(log\s*[-_]?\s*out|sign\s*[-_]?\s*out)\s*$/i;
const LOGOUT_HREF_PATTERN = /(^|\/)(logout|signout|sign-out|log-out)(\/|\?|$)/i;
const LOGOUT_TESTID_PATTERN = /(^|[-_])(logout|signout|log-out|sign-out)([-_]|$)/i;

/** Quick check on a textual hint (for find_and_click before any DOM lookup). */
function hintLooksLikeLogout(hint: string): boolean {
  return LOGOUT_TEXT_PATTERN.test(hint);
}

/**
 * Resolve a Playwright locator to its first match and check whether it's a
 * logout control. Returns null if the locator doesn't match anything (so the
 * caller can let Playwright produce its usual "not found" error).
 */
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

    if (LOGOUT_TEXT_PATTERN.test(info.text))
      return { matched: true, reason: `text="${info.text}"` };
    if (LOGOUT_TEXT_PATTERN.test(info.ariaLabel))
      return { matched: true, reason: `aria-label="${info.ariaLabel}"` };
    if (LOGOUT_TEXT_PATTERN.test(info.title))
      return { matched: true, reason: `title="${info.title}"` };
    if (info.href && LOGOUT_HREF_PATTERN.test(info.href))
      return { matched: true, reason: `href="${info.href}"` };
    if (info.testid && LOGOUT_TESTID_PATTERN.test(info.testid))
      return { matched: true, reason: `data-testid="${info.testid}"` };
    return { matched: false };
  } catch {
    // Inspection failed — be permissive (don't block a click on inspection error).
    return { matched: false };
  }
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

/**
 * Minimum interactions on a page before navigating away is "OK". Tuned for the
 * stick-with-it goal: the agent has to actually engage with forms, table rows,
 * modals etc. before flicking the nav. Findings count as engagement too.
 *
 * Six is a deliberate floor: enough to make the agent click into a row, open a
 * menu, fill a field, save, and verify — but not so many that uneventful pages
 * trap the agent. Combined with the time-based bypass below, the gate stops
 * scatterbrain navigation without preventing exploration of other modules.
 */
const MIN_ACTIONS_PER_ROUTE = 6;

/** After this many milliseconds on a route, navigation is allowed regardless
 * of action count. The agent has clearly tried; further nailing-them-down is
 * counterproductive. */
const ROUTE_TIME_BYPASS_MS = 60_000;

/** Tracks action count + first-seen timestamp per route so the agent can SEE
 * its own engagement level in every action's status line. Agnostic: works for
 * any portal because we only key on URLs. */
interface RouteEngagement {
  actionCount: number;
  firstSeenAt: number;
}

export interface EngagementTracker {
  bump: (route: string, weight?: number) => RouteEngagement;
  peek: (route: string) => RouteEngagement;
  stateLine: (route: string) => string;
}

export function buildEngagementTracker(): EngagementTracker {
  const byRoute = new Map<string, RouteEngagement>();

  function bump(route: string, weight = 1): RouteEngagement {
    let e = byRoute.get(route);
    if (!e) {
      e = { actionCount: 0, firstSeenAt: Date.now() };
      byRoute.set(route, e);
    }
    e.actionCount += weight;
    return e;
  }

  function peek(route: string): RouteEngagement {
    return byRoute.get(route) ?? { actionCount: 0, firstSeenAt: Date.now() };
  }

  function stateLine(route: string): string {
    const e = peek(route);
    const seconds = Math.round((Date.now() - e.firstSeenAt) / 1000);
    const warn =
      e.actionCount < MIN_ACTIONS_PER_ROUTE
        ? ` ⚠️ only ${e.actionCount}/${MIN_ACTIONS_PER_ROUTE} actions here — STAY on this page, engage with its content`
        : ` ✓ ${e.actionCount} actions here`;
    return `[engagement: ${seconds}s on ${route};${warn}]`;
  }

  return { bump, peek, stateLine };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export interface BrowserServerInput {
  /** Returns the page the agent should drive. Closure-style so caller can swap pages mid-run. */
  getPage: () => Page;
  logger: Logger;
  /** Engagement tracker shared with the harness server so report_finding can
   * also count toward the per-route action threshold. When omitted, the browser
   * server creates its own (un-shared) tracker. */
  engagement?: EngagementTracker;
  /** Agent ID — used to push live state into the runtime registry so the
   * supervisor can see what each agent is doing. Optional for back-compat. */
  agentId?: string;
  /** Hook invoked on every action with current url + tool name + auth-wall flag.
   * Defaults to writing into the runtime registry; tests may pass a stub. */
  onAction?: (patch: { url: string; toolName: string; authWalled: boolean }) => void;
}

/** Auth-wall URL detector. Conservative — only flags Auth0 visible-form pages
 * (where the user is stuck on login or logout-confirm). Transient redirects
 * through `/authorize` are NOT flagged because they are part of normal silent
 * re-auth and would create false positives. */
export function isAuthWallUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (!/\.auth0\.com$/i.test(u.hostname)) return false;
    return /^\/(u\/login|u\/logout|v2\/logout|oidc\/logout)(\/|$|\?)/.test(u.pathname);
  } catch {
    return false;
  }
}

export function createBrowserMcpServer({
  getPage,
  logger,
  engagement: sharedEngagement,
  agentId,
  onAction,
}: BrowserServerInput) {
  // Per-server engagement tracker — counts agent actions per route so we can
  // surface "you've only done 2 things here" warnings in every status line.
  const engagement = sharedEngagement ?? buildEngagementTracker();

  // Console buffer — survives navigations because we re-attach listeners.
  const consoleBuffer: ConsoleEntry[] = [];
  /**
   * Network-anomaly buffer. Captures any HTTP response with status >= 400 so
   * we can surface them in the next action's status line. Without this, a
   * click that triggers a silent 403 "save" leaves the agent oblivious — the
   * UI says nothing, and the agent's status line just says OK.
   */
  interface NetworkAnomaly {
    ts: number;
    status: number;
    method: string;
    url: string;
  }
  const networkBuffer: NetworkAnomaly[] = [];
  const NETWORK_BUFFER_LIMIT = 30;
  let lastListenerPage: Page | null = null;

  /** Drain recently-buffered console errors and network anomalies into a
   * compact suffix for the agent's next status line. Surfacing these
   * automatically (rather than waiting for the agent to ask) is what lets the
   * agent NOTICE silent failures — clicks that 500 in the network but show
   * "OK" in the UI, hydration errors that don't crash, etc. */
  function drainSignals(): string {
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
      networkBuffer.length = 0;
    }
    if (consoleBuffer.length > 0) {
      const recent = consoleBuffer.slice(-3);
      parts.push(
        `console: ${recent.map((c) => `[${c.level}] ${c.text.slice(0, 100)}`).join(' / ')}`,
      );
      consoleBuffer.length = 0;
    }
    return ` ⚠️ since last action — ${parts.join(' || ')}`;
  }

  /** Push runtime state to the registry — the supervisor reads this to spot
   * stuck agents. No-op when the harness was constructed without onAction. */
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
   * Sleep at the start of an action when the agent (or the whole run) is paused.
   * The pause can come from per-agent backoff after a 4xx storm, or from the
   * supervisor's pause_agents tool when it detects backend-wide unhealthiness.
   *
   * Sleeping here, on the tool result, costs zero model turns — the agent's
   * SDK call is just blocked on the tool reply. Capped per-call so the pause
   * doesn't consume the agent's full wall-clock budget in one tool call; if
   * the pause runs longer, the NEXT action will sleep too.
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

  /** Mark one action against the current route, then build a status line. */
  function statusOk(page: Page, what: string): string {
    const route = routeOf(page.url());
    engagement.bump(route);
    reportToRegistry(page, what);
    return `OK ${what} | URL: ${page.url()} ${engagement.stateLine(route)}${drainSignals()}`;
  }
  function statusFail(page: Page, what: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const route = routeOf(page.url());
    // Failures still count as engagement — the agent tried something. Keeps
    // the threshold reachable on pages where some actions error out.
    engagement.bump(route);
    reportToRegistry(page, what);
    return `FAIL ${what} | ${msg} | URL: ${page.url()} ${engagement.stateLine(route)}${drainSignals()}`;
  }
  // Reference agentId so it's not flagged as unused — kept for future tools
  // (e.g. per-agent network traces) and for callers who want to log on entry.
  void agentId;

  /**
   * Speculative snapshot cache. After every action we kick off a snapshot in
   * the background — it runs in parallel with the model's inference for the
   * NEXT turn (which is otherwise dead time). When the agent calls `snapshot`,
   * we return the cached one if it's recent. Net effect: snapshot is free.
   *
   * `inFlight` is the active background promise. `cached` is the most recent
   * resolved value with its capture timestamp. A new action invalidates the
   * cache because the page state may have changed underneath.
   */
  const SNAPSHOT_TTL_MS = 2_500;
  let inFlight: Promise<SnapshotData> | null = null;
  let cached: { value: SnapshotData; ts: number } | null = null;
  let cacheGeneration = 0;

  /** The snapshot the agent last saw. Diff renders are computed against this so
   * each new snapshot only ships what changed. Reset when the URL changes (the
   * diff renderer falls back to full anyway). */
  let lastSeenByAgent: SnapshotData | null = null;

  function invalidateSnapshotCache(): void {
    cacheGeneration += 1;
    cached = null;
    inFlight = null;
  }

  function speculate(page: Page): void {
    const myGen = ++cacheGeneration;
    const promise = fastSnapshot(page).then(
      (value) => {
        if (myGen !== cacheGeneration) return value; // a newer action superseded us
        cached = { value, ts: Date.now() };
        return value;
      },
      (err) => {
        // Speculative failures are silent — the foreground snapshot tool will retry.
        logger.debug('snapshot.speculative.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { url: '', title: '', items: [], truncated: false };
      },
    );
    inFlight = promise;
  }

  async function getSnapshotData(page: Page): Promise<SnapshotData> {
    if (cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) {
      return cached.value;
    }
    if (inFlight) {
      const v = await inFlight;
      if (v.items.length > 0 || v.url) return v;
    }
    const v = await fastSnapshot(page);
    cached = { value: v, ts: Date.now() };
    return v;
  }

  /**
   * Read the snapshot for the agent. Defaults to DIFF mode: only items that
   * changed since the agent's last snapshot are returned. On the first call,
   * or when the URL has changed, returns the full snapshot. `full: true`
   * forces a full snapshot regardless.
   */
  async function readSnapshot(page: Page, opts: { full?: boolean } = {}): Promise<string> {
    const data = await getSnapshotData(page);
    // Capture into a const so TS can narrow it past the lastSeenByAgent check.
    const previous = lastSeenByAgent;
    const wantFull = opts.full || previous === null || previous.url !== data.url;
    const rendered = wantFull ? formatFullSnapshot(data) : formatDiffSnapshot(previous, data);
    lastSeenByAgent = data;
    return rendered;
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
      // Skip the navigation response itself — it's already implied by the URL
      // change in the status line, and counting it would double-flag every 404.
      // We surface only XHR/fetch/document subresources that the page issued.
      const type = resp.request().resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      networkBuffer.push({
        ts: Date.now(),
        status,
        method: resp.request().method(),
        url: resp.url(),
      });
      if (networkBuffer.length > NETWORK_BUFFER_LIMIT) networkBuffer.shift();
      // Mirror into the registry for cross-agent visibility (supervisor) and
      // per-agent backoff (this server).
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

  // Eager attach. The caller (spawn-agent) constructs us only after login, so
  // the page is already alive.
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

  // Capture raw tool defs so both the MCP path and the direct-API path use the
  // same handlers. Each entry below produces both an MCP tool() and a RawToolDef.
  // The generic preserves Zod inference inside the handler — args are typed.
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

  const mcpServer = createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      defTool(
        'snapshot',
        'Return what is on the current page. By DEFAULT this returns a DIFF — only elements added or removed since your last snapshot. Cheap, fast, perfect for "did anything appear after I clicked?". Pass `full: true` ONLY when you genuinely need the entire page state (first time on a route, or after a major re-render the diff missed). The first snapshot per URL is always full automatically.',
        { full: z.boolean().optional() },
        async ({ full }) => {
          const page = ensureListeners();
          return textResult(await readSnapshot(page, { full }));
        },
      ),

      defTool(
        'navigate',
        'Navigate to a URL. Use SPARINGLY — the harness REFUSES navigation away from a route until you have made enough interactions on it (currently 12). This is intentional: a real user does not flick the nav menu every few clicks. Engage with the page content (forms, table rows, modals, sub-tabs, kebab menus) before navigating elsewhere.',
        { url: z.string().url() },
        async ({ url }) => {
          const page = ensureListeners();
          await awaitPauseIfNeeded();
          const fromRoute = routeOf(page.url());
          const fromEngagement = engagement.peek(fromRoute);
          const target = (() => {
            try {
              return new URL(url);
            } catch {
              return null;
            }
          })();
          const toRoute = target ? `${target.origin}${target.pathname}` : url;

          // Broken-page escape hatch: if the current page has very few
          // interactive items (404, blank render, error boundary), there's
          // nothing meaningful to engage with. Allow navigation regardless of
          // the action counter — trapping the agent on a dead page produces
          // noise, not findings. We use the cached snapshot data when fresh.
          const currentItemCount =
            cached && Date.now() - cached.ts < 5_000 ? cached.value.items.length : null;
          const pageLooksBroken = currentItemCount !== null && currentItemCount < 8;
          const timeBypass = Date.now() - fromEngagement.firstSeenAt >= ROUTE_TIME_BYPASS_MS;

          // Refuse navigation only when ALL of these hold:
          // - moving to a different route (same-route navigation always allowed)
          // - haven't done enough actions on the current route
          // - current page is not broken (has real content)
          // - haven't been on the current route long enough to bypass
          if (
            fromRoute !== toRoute &&
            fromEngagement.actionCount < MIN_ACTIONS_PER_ROUTE &&
            !pageLooksBroken &&
            !timeBypass
          ) {
            return textResult(
              `REFUSED navigate(${url}) — only ${fromEngagement.actionCount}/${MIN_ACTIONS_PER_ROUTE} interactions on ${fromRoute}. Engage with the current page first: click table rows, open kebab/edit menus, fill and submit forms, switch sub-tabs, open modals, double-click cells, sort columns. Same-route navigation (drilling into a record) is always allowed. Bypass options: file a finding via report_finding (worth +4 actions), or wait — after 60s on this route the gate releases automatically.`,
            );
          }

          invalidateSnapshotCache();
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          } catch (err) {
            return textResult(statusFail(page, `navigate(${url})`, err));
          }
          speculate(page);
          return textResult(statusOk(page, `navigate(${url})`));
        },
      ),

      defTool('back', 'Browser back. Returns a status line.', {}, async () => {
        const page = ensureListeners();
        await awaitPauseIfNeeded();
        invalidateSnapshotCache();
        await page
          .goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
          .catch(() => undefined);
        speculate(page);
        return textResult(statusOk(page, 'back'));
      }),

      defTool(
        'click',
        'Click an element. Locator: Playwright role-or-text selector — `role=button[name="Save"]`, `text="Cancel"`, `[data-testid="x"]`, `#id`. Returns a status line. Logout controls are blocked by the harness; if you need to test logout, file a finding describing the broken page that surfaced it.',
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
          invalidateSnapshotCache();
          // Logout suppression — see locatorIsLogout for rationale.
          const logoutCheck = await locatorIsLogout(page.locator(locator).first());
          if (logoutCheck.matched) {
            return textResult(
              `REFUSED click(${locator}) — target appears to be a logout control (${logoutCheck.reason}). Logout would terminate the shared session for ALL agents and cascade-break the run. If a broken page is showing only this control, that itself is a finding — call report_finding for the broken page. ${statusOk(page, `click_blocked(${locator})`)}`,
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
          invalidateSnapshotCache();
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
          invalidateSnapshotCache();
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
          invalidateSnapshotCache();
          try {
            const target = label !== undefined ? { label } : { value: value ?? '' };
            await page
              .locator(locator)
              .first()
              .selectOption(target, { timeout: ACTION_TIMEOUT_MS });
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
          const lines = consoleBuffer.map(
            (e) => `[${e.level}] ${e.url ? `${e.url} — ` : ''}${e.text}`,
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
            return textResult(`evaluate result: ${result}`);
          } catch (err) {
            logger.warn('browser.evaluate.failed', {
              expression,
              error: err instanceof Error ? err.message : String(err),
            });
            return textResult(
              `evaluate failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      ),

      // ─── Compound macros ──────────────────────────────────────────────────
      // High-leverage tools that bundle deterministic action sequences. The
      // model dispatches with high-level intent ("fill this form, submit it");
      // the tool layer handles the loop. One round-trip instead of N.

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
              z
                .string()
                .describe('Locator of submit button. If true, presses Enter on last field.'),
            ])
            .optional(),
        },
        async ({ fields, submit }) => {
          const page = ensureListeners();
          await awaitPauseIfNeeded();
          invalidateSnapshotCache();
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
        'Find a button or link by visible text or role, then click. Tries multiple matching strategies in order (role+name → text → aria-label → partial text). Use this instead of `click` when you only know what the element says, not its exact selector. Saves a snapshot+click round-trip. Logout controls are blocked by the harness — see `click` for details.',
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
          invalidateSnapshotCache();
          // Cheap hint-level check before we start probing the DOM.
          if (hintLooksLikeLogout(hint)) {
            return textResult(
              `REFUSED find_and_click("${hint}") — hint matches a logout control. Logout would terminate the shared session for ALL agents. If the page is broken and Log out is the only visible action, that's a finding — call report_finding. ${statusOk(page, `find_and_click_blocked("${hint}")`)}`,
            );
          }
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
              // Element-level logout check — matters when hint doesn't directly
              // say "log out" but the hint resolves to a logout link by aria/href.
              const logoutCheck = await locatorIsLogout(loc);
              if (logoutCheck.matched) {
                return textResult(
                  `REFUSED find_and_click("${hint}") — resolved element is a logout control (${logoutCheck.reason}). ${statusOk(page, `find_and_click_blocked("${hint}")`)}`,
                );
              }
              await loc.click({ timeout: 3_000 });
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
        'One-call sweep returning: current URL, snapshot, console errors since last check, and last 5 network entries. Use this when you want to assess the current state after weird behaviour — replaces `snapshot` + `console_errors` + `evaluate(perf)` with a single round-trip.',
        {},
        async () => {
          const page = ensureListeners();
          await awaitPauseIfNeeded();
          const [snap, perfRaw] = await Promise.all([
            readSnapshot(page),
            (page.evaluate as unknown as (fn: string) => Promise<string>)(
              `() => JSON.stringify((globalThis.performance.getEntries().slice(-5).map(e => ({name: e.name.slice(0, 200), type: e.entryType, dur: Math.round(e.duration)}))))`,
            ).catch(() => '[]'),
          ]);
          const errors =
            consoleBuffer.length === 0
              ? 'none'
              : consoleBuffer.map((e) => `[${e.level}] ${e.text.slice(0, 200)}`).join(' | ');
          consoleBuffer.length = 0;
          return textResult(
            `${snap}\n\n--- console errors ---\n${errors}\n\n--- last 5 network entries ---\n${perfRaw}`,
          );
        },
      ),
    ],
  });

  return { mcpServer, rawTools };
}

/** The exact tool names the agent sees — used to construct the SDK allowlist. */
export const BROWSER_TOOL_NAMES = [
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
] as const;
