/**
 * Shared types + helpers between auth-agent.ts (API mode) and
 * auth-agent-sdk.ts (subscription mode). Lives here so neither module needs to
 * import from the other at the value level — that previously created a runtime
 * cycle (the same pattern was applied to supervisor.ts ↔ supervisor-sdk.ts via
 * supervisor-shared.ts).
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { dismissPersistentBanners, launchBrowser } from '../auth/login.ts';
import type { LlmBackend } from '../llm/backend.ts';
import type { Logger } from '../logging/logger.ts';
import { redactForLlm } from '../logging/logger.ts';
import { parsePage } from '../page-model/parser.ts';
import { isHostAllowed } from '../safety/guards.ts';
import { serializeForAgent } from '../page-model/serialize.ts';
import type { EventWriter } from './events.ts';

export interface AuthAgentInput {
  /** Where the app lives. Used as the "fall-back" navigation target if no
   *  login_url is given AND the agent needs to find the login page itself. */
  targetUrl: string;
  /** Optional explicit login URL hint (e.g. `http://host/#/login`). If given,
   *  the agent starts there — otherwise it starts at targetUrl. */
  loginUrl?: string;
  credentials: { username: string; password: string };
  allowedHosts: string[];
  backend: LlmBackend;
  /** Model for the auth agent. Default Haiku — login is mechanical, doesn't
   *  need Sonnet. */
  model: string;
  /** Maximum turns the auth agent may take. Default 12 — well above the
   *  3-5 turns a successful login takes. */
  maxTurns?: number;
  /** Where to write the captured storage state on success. Recommended:
   *  `<runDir>/auth-state.json`. Required so the crawler + agent sessions
   *  can find it. */
  storageStatePath: string;
  logger: Logger;
  events?: EventWriter;
  stealth: boolean;
  abortSignal?: AbortSignal;
}

export interface AuthAgentResult {
  ok: boolean;
  /** Path the storage state was written to (undefined on failure). */
  storageStatePath?: string;
  /** Last URL the page was on when the agent terminated. */
  finalUrl?: string;
  detail: string;
  costUsd: number;
  turns: number;
  /** Session identity captured from the post-login storage state. Populated
   *  when the auth-agent succeeds AND we can find a JWT-shaped token in
   *  cookies or localStorage. Surfaced in every persona's per-turn user
   *  message so they know they're already authed and don't re-fire try_login. */
  sessionInfo?: { username: string; role?: string };
}

export const DEFAULT_MAX_TURNS = 12;

export const AUTH_AGENT_SYSTEM_PROMPT = (creds: { username: string; password: string }) => `\
You are an authentication agent. Your ONLY job is to log into a web app with the credentials below and confirm the login succeeded.

Credentials:
  username: ${creds.username}
  password: ${creds.password}

Process:
1. Take a snapshot to see what's on the page.
2. If a cookie banner / GDPR consent / welcome modal is in front, dismiss it. Common buttons/links: "Accept", "Dismiss", "Got it", "OK", "Me want it", "Continue", or a "×" close. Sometimes the dismiss is an <a> with class "cc-dismiss" not a <button>.
3. Find the login form. It will have an email/username field and a password field. Locate them by their visible label, name, id, or aria-label — DON'T rely on a single selector pattern.
4. Fill the fields. \`fill_form\` is preferred (atomic, fast). Fall back to \`type\` for one-at-a-time.
5. Click the login button. Common labels: "Log in", "Sign in", "Login", "Submit", "Continue".
6. Take a snapshot to verify success. You're logged in when:
   - The URL is no longer the login URL
   - The page shows a logout button, profile menu, account button, or your username
   - There are no error messages ("Invalid credentials", "Wrong password", red toast, etc.)
7. Once you're confident the login succeeded, call \`auth_success\`.
8. If something is wrong (wrong creds, captcha, login form not found, etc.) call \`auth_failed\` with a short reason.

Rules:
- DO NOT register a new account — use the credentials given.
- DO NOT navigate away from the login flow except to follow the natural post-login redirect.
- DO NOT spend turns on irrelevant pages or features. Log in, verify, done.
- The current page snapshot will appear at each turn. Use it to decide your next action.
- You have ${DEFAULT_MAX_TURNS} turns and a small budget. Be efficient.`;

/** After auth_success, walk the browser context's storage state for a JWT
 *  whose payload identifies the user. Returns `{username, role?}` so the
 *  per-turn user message can render "session: authenticated as <user>". */
export async function captureSessionInfo(
  context: BrowserContext,
  fallbackUsername: string,
): Promise<{ username: string; role?: string }> {
  try {
    const state = await context.storageState();
    const tokens: string[] = [];
    for (const c of state.cookies ?? []) {
      if (/token|jwt|auth|session/i.test(c.name) && c.value.length > 16) tokens.push(c.value);
    }
    for (const origin of state.origins ?? []) {
      for (const ls of origin.localStorage ?? []) {
        if (/token|jwt|auth|session/i.test(ls.name) && ls.value.length > 16) tokens.push(ls.value);
      }
    }
    for (const t of tokens) {
      const claim = decodeJwtClaim(t);
      if (!claim) continue;
      const username = findString(claim, /^email$|^username$|^sub$/) ?? fallbackUsername;
      const role = findString(claim, /^role$|^roles$|^scope$/);
      if (role) return { username, role };
      return { username };
    }
  } catch {
    // ignore — fall through to fallback
  }
  return { username: fallbackUsername };
}

export function decodeJwtClaim(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const seg = parts[1] ?? '';
    const std = seg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Recursively walk an object looking for a string value under a key whose
 *  name matches `keyRe`. Used to pull email/role out of nested JWT claims
 *  (Juice Shop nests under `data.email`). */
export function findString(obj: unknown, keyRe: RegExp): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k) && typeof v === 'string' && v.length > 0) return v;
    if (v && typeof v === 'object') {
      const inner = findString(v, keyRe);
      if (inner) return inner;
    }
  }
  return undefined;
}

export async function safeSnapshot(page: Page): Promise<string> {
  try {
    const model = await parsePage(page);
    return redactForLlm(serializeForAgent(model));
  } catch (err) {
    return `(snapshot failed: ${err instanceof Error ? err.message : String(err)}) — current URL: ${page.url()}`;
  }
}

export function makeNoopLogger(): Logger {
  // dismissPersistentBanners only logs at debug level — give it a silent
  // logger so we don't pollute the auth-agent's transcript.
  const noop = (() => undefined) as unknown;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => makeNoopLogger(),
  } as unknown as Logger;
}

// ─── Browser Launch ─────────────────────────────────────────────────────────

/** Launch a browser, open a page, navigate to the start URL, and dismiss
 *  persistent banners. Both auth-agent.ts and auth-agent-sdk.ts duplicated
 *  this exact sequence; now they call this instead. */
export async function launchAuthBrowser(input: AuthAgentInput): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await launchBrowser(input.stealth, {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    channel: 'chrome',
  }).catch(async () =>
    launchBrowser(input.stealth, { headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' }),
  );
  const context = await browser.newContext();
  const page = await context.newPage();

  const startUrl = input.loginUrl ?? input.targetUrl;
  const logPhase = input.backend.kind === 'sdk' ? 'auth-agent-sdk.warmup' : 'auth-agent.warmup';
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await dismissPersistentBanners(page, input.logger.child({ phase: logPhase }));
  } catch (err) {
    input.logger.warn(`${input.backend.kind === 'sdk' ? 'auth-agent-sdk' : 'auth-agent'}.goto.failed`, {
      url: startUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { browser, context, page };
}

// ─── Shared Auth Tool Handlers ──────────────────────────────────────────────
// Pure-logic handler bodies for the 8 auth tools. Both auth-agent.ts and
// auth-agent-sdk.ts wrap these in their respective tool definition formats.

/** Return type for auth tool handlers — compatible with both API-mode
 *  `{ content: string }` and SDK-mode `{ content: [{type:'text',text}] }`.
 *  The API-mode wrapper reads `.text`, the SDK-mode wrapper returns the full
 *  shape. */
export interface AuthToolResult {
  text: string;
}

export async function handleSnapshot(page: Page): Promise<AuthToolResult> {
  const snap = await safeSnapshot(page);
  return { text: snap };
}

export async function handleNavigate(
  page: Page,
  allowedHosts: string[],
  url: string,
): Promise<AuthToolResult> {
  if (allowedHosts.length > 0 && !isHostAllowed(url, allowedHosts)) {
    return { text: `navigate refused: ${url} not in allowed_hosts.` };
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await dismissPersistentBanners(page, makeNoopLogger());
    return { text: `navigated to ${page.url()}` };
  } catch (err) {
    return { text: `navigate failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleClick(page: Page, locator: string): Promise<AuthToolResult> {
  try {
    await page.locator(locator).first().click({ timeout: 5_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    return { text: `clicked ${locator}; now on ${page.url()}` };
  } catch (err) {
    return { text: `click failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleType(
  page: Page,
  locator: string,
  value: string,
): Promise<AuthToolResult> {
  try {
    await page.locator(locator).first().fill(value, { timeout: 5_000 });
    return { text: `filled ${locator} (${value.length} chars)` };
  } catch (err) {
    return { text: `type failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleFillForm(
  page: Page,
  fields: Array<{ locator: string; value: string }>,
): Promise<AuthToolResult> {
  const lines: string[] = [];
  for (const f of fields) {
    try {
      await page.locator(f.locator).first().fill(f.value, { timeout: 5_000 });
      lines.push(`  ✓ ${f.locator}`);
    } catch (err) {
      lines.push(`  ✗ ${f.locator}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { text: `fill_form (${fields.length} field(s)):\n${lines.join('\n')}` };
}

export async function handlePressKey(
  page: Page,
  key: string,
  locator?: string,
): Promise<AuthToolResult> {
  try {
    if (locator) {
      await page.locator(locator).first().press(key, { timeout: 5_000 });
    } else {
      await page.keyboard.press(key);
    }
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    return { text: `pressed ${key}; now on ${page.url()}` };
  } catch (err) {
    return { text: `press_key failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleAuthSuccess(
  page: Page,
  onSuccess: (detail: string) => void,
  detail?: string,
): AuthToolResult {
  const msg = detail ?? `logged in successfully (final URL: ${page.url()})`;
  onSuccess(msg);
  return { text: `auth_success acknowledged: ${msg}` };
}

export function handleAuthFailed(
  onFailed: (reason: string) => void,
  reason: string,
): AuthToolResult {
  onFailed(reason);
  return { text: `auth_failed acknowledged: ${reason}` };
}

/** Tool descriptions — shared across both API-mode and SDK-mode. */
export const AUTH_TOOL_DESCRIPTIONS = {
  snapshot:
    'Re-take a structured snapshot of the current page. Use after any action whose effect you need to observe.',
  navigate:
    'Navigate to a URL. Use only if the login flow takes you off the current page (e.g. you need to retry from a different starting point).',
  click:
    'Click an element by Playwright locator (e.g. `role=button[name="Log in"]`, `#loginButton`, `a.cc-dismiss`).',
  type: 'Fill a text input by locator. Replaces existing value.',
  fill_form:
    'Fill multiple inputs in one call. Each entry is { locator, value }. More efficient than several `type` calls.',
  press_key:
    'Press a key on the focused element (or document). Useful for submitting via Enter when no submit button exists.',
  auth_success:
    'Call this once you have verified the login succeeded (URL changed, logged-in UI visible, no error). Terminal — the auth agent stops after this.',
  auth_failed:
    'Call this if you cannot log in (wrong credentials, captcha required, login form unreachable, etc.). Terminal.',
} as const;

/** Zod shapes for auth tools — shared so both API and SDK modes use
 *  identical validation. */
export const AUTH_TOOL_SHAPES = {
  snapshot: {},
  navigate: { url: z.string().url() },
  click: { locator: z.string().min(1) },
  type: { locator: z.string().min(1), value: z.string() },
  fill_form: {
    fields: z.array(z.object({ locator: z.string().min(1), value: z.string() })).min(1),
  },
  press_key: { key: z.string().min(1), locator: z.string().optional() },
  auth_success: { detail: z.string().optional() },
  auth_failed: { reason: z.string().min(1) },
} as const;
