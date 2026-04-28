/**
 * AI-driven authentication agent — replaces the brittle CSS-selector form-fill
 * path. Runs ONCE before the crawler. Uses Haiku + a tight tool set to
 * navigate to the login page, dismiss whatever banners are in the way, fill
 * the form, click the right button, and confirm success. On success it
 * captures the post-login `storageState` to a file; the crawler and every
 * persona agent's session then loads that file and inherits the auth.
 *
 * Why an agent and not selectors: every app's login is shaped slightly
 * differently — Material vs Bootstrap, hash routes vs plain routes, GDPR
 * banners that block the submit, two-step "enter email" → "enter password"
 * flows, captchas, "remember me" checkboxes that need toggling. A small LLM
 * reads the page and figures it out. Selectors require constant tuning.
 *
 * Budget: ~10 turns, $0.10-0.30 with Haiku. Cheap insurance against the
 * fragility we saw across runs (selectors timing out on Juice Shop's
 * "Me want it!" cookie banner because it's an `<a>` not a `<button>`).
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Browser, BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { dismissPersistentBanners, launchBrowser } from '../auth/login.ts';
import type { Logger } from '../logging/logger.ts';
import { redactForLlm } from '../logging/logger.ts';
import { parsePage } from '../page-model/parser.ts';
import { serializeForAgent } from '../page-model/serialize.ts';
import { isHostAllowed } from '../safety/guards.ts';
import { computeCostUsd } from './cost.ts';
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
  apiKey: string;
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

const DEFAULT_MAX_TURNS = 12;
const MAX_OUTPUT_TOKENS = 1024;

const AUTH_AGENT_SYSTEM_PROMPT = (creds: { username: string; password: string }) => `\
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

export async function runAuthAgent(input: AuthAgentInput): Promise<AuthAgentResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = Date.now();
  input.logger.info('auth-agent.start', {
    targetUrl: input.targetUrl,
    loginUrl: input.loginUrl,
    model: input.model,
    username: input.credentials.username,
  });

  // 1. Launch a browser. Same launch path as the rest of the harness.
  const browser = await launchBrowser(input.stealth, {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    channel: 'chrome',
  }).catch(async () =>
    launchBrowser(input.stealth, { headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' }),
  );
  const context = await browser.newContext();
  const page = await context.newPage();

  // 2. Initial navigation + best-effort banner dismiss before the agent
  //    even sees the page. Saves a turn or two.
  const startUrl = input.loginUrl ?? input.targetUrl;
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await dismissPersistentBanners(page, input.logger.child({ phase: 'auth-agent.warmup' }));
  } catch (err) {
    input.logger.warn('auth-agent.goto.failed', {
      url: startUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Build the tight tool set. Inline so the auth agent doesn't depend on
  //    the heavy createBrowserMcpServer machinery (sitemap, registry, etc).
  let terminalSignal: 'success' | 'failed' | null = null;
  let terminalDetail = '';
  const tools = buildAuthTools({
    page,
    allowedHosts: input.allowedHosts,
    onSuccess: (detail) => {
      terminalSignal = 'success';
      terminalDetail = detail;
    },
    onFailed: (reason) => {
      terminalSignal = 'failed';
      terminalDetail = reason;
    },
  });

  // 4. Run the loop.
  const client = new Anthropic({ apiKey: input.apiKey });
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => {
    const objSchema = z.object(t.shape);
    const jsonSchema = z.toJSONSchema(objSchema) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: jsonSchema as Anthropic.Tool['input_schema'],
    };
  });
  const handlerByName = new Map(tools.map((t) => [t.name, t.handler]));

  const messages: Anthropic.MessageParam[] = [];
  let totalCostUsd = 0;
  let turn = 0;
  let lastFinalUrl = page.url();

  try {
    while (turn < maxTurns && !terminalSignal && !input.abortSignal?.aborted) {
      turn += 1;

      // Prepend the current page snapshot so the agent always sees
      // up-to-date state. Cheaper than asking the agent to call snapshot()
      // every turn.
      const snapshot = await safeSnapshot(page);
      const userText =
        turn === 1
          ? `You are on: ${page.url()}\n\nCurrent page snapshot:\n${snapshot}\n\nLog in now.`
          : `Current page snapshot:\n${snapshot}\n\nContinue.`;
      messages.push({ role: 'user', content: userText });

      const response = await client.messages.create({
        model: input.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: AUTH_AGENT_SYSTEM_PROMPT(input.credentials),
        tools: anthropicTools,
        messages,
      });

      totalCostUsd += computeCostUsd(input.model, {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      });

      messages.push({ role: 'assistant', content: response.content });

      // Process tool calls.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const handler = handlerByName.get(block.name);
        if (!handler) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
          continue;
        }
        try {
          const out = await handler(block.input as Record<string, unknown>);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: out.content,
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Tool ${block.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      lastFinalUrl = page.url();

      // If the model didn't call any tool AND didn't end with stop_reason
      // 'tool_use', it's stuck — bail.
      if (response.stop_reason === 'end_turn' && !terminalSignal) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .slice(0, 200);
        terminalSignal = 'failed';
        terminalDetail = `Agent stopped without calling auth_success/auth_failed: ${text}`;
        break;
      }
    }

    if (!terminalSignal) {
      terminalSignal = 'failed';
      terminalDetail = `Hit max turns (${maxTurns}) without resolution`;
    }

    // 5. On success, capture storage state. Cast away TS narrowing — the
    //    onSuccess closure can mutate terminalSignal during awaited handlers.
    if ((terminalSignal as 'success' | 'failed') === 'success') {
      try {
        await context.storageState({ path: input.storageStatePath, indexedDB: true });
        // Decode the captured JWT (cookie or localStorage) so spawn-agent +
        // the per-turn user message can render "logged in as <user>" text.
        // Best-effort — plain { username } if no JWT found.
        const sessionInfo = await captureSessionInfo(context, input.credentials.username);
        input.logger.info('auth-agent.success', {
          turns: turn,
          costUsd: totalCostUsd.toFixed(4),
          storageStatePath: input.storageStatePath,
          finalUrl: lastFinalUrl,
          sessionRole: sessionInfo?.role,
        });
        await input.events?.write({
          type: 'auth.try_login',
          agentId: 'auth-agent',
          username: input.credentials.username,
          success: true,
          detail: terminalDetail || `logged in via auth-agent in ${turn} turn(s)`,
          postLoginUrl: lastFinalUrl,
        });
        return {
          ok: true,
          storageStatePath: input.storageStatePath,
          finalUrl: lastFinalUrl,
          detail: terminalDetail || 'logged in',
          costUsd: totalCostUsd,
          turns: turn,
          sessionInfo,
        };
      } catch (err) {
        terminalDetail = `auth_success but failed to persist storage state: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    input.logger.warn('auth-agent.failed', {
      turns: turn,
      costUsd: totalCostUsd.toFixed(4),
      detail: terminalDetail,
      finalUrl: lastFinalUrl,
    });
    await input.events?.write({
      type: 'auth.try_login',
      agentId: 'auth-agent',
      username: input.credentials.username,
      success: false,
      detail: terminalDetail,
      postLoginUrl: lastFinalUrl,
    });
    return {
      ok: false,
      finalUrl: lastFinalUrl,
      detail: terminalDetail,
      costUsd: totalCostUsd,
      turns: turn,
    };
  } finally {
    void startedAt;
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/** After auth_success, walk the browser context's storage state for a JWT
 *  whose payload identifies the user. Returns `{username, role?}` so the
 *  per-turn user message can render "session: authenticated as <user>". */
async function captureSessionInfo(
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

function decodeJwtClaim(token: string): Record<string, unknown> | null {
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
function findString(obj: unknown, keyRe: RegExp): string | undefined {
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

async function safeSnapshot(page: Page): Promise<string> {
  try {
    const model = await parsePage(page);
    return redactForLlm(serializeForAgent(model));
  } catch (err) {
    return `(snapshot failed: ${err instanceof Error ? err.message : String(err)}) — current URL: ${page.url()}`;
  }
}

interface AuthRawTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{ content: string }>;
}

function buildAuthTools(deps: {
  page: Page;
  allowedHosts: string[];
  onSuccess: (detail: string) => void;
  onFailed: (reason: string) => void;
}): AuthRawTool[] {
  const { page, allowedHosts, onSuccess, onFailed } = deps;

  return [
    {
      name: 'snapshot',
      description:
        'Re-take a structured snapshot of the current page. Use after any action whose effect you need to observe.',
      shape: {},
      handler: async () => {
        const snap = await safeSnapshot(page);
        return { content: snap };
      },
    },
    {
      name: 'navigate',
      description:
        'Navigate to a URL. Use only if the login flow takes you off the current page (e.g. you need to retry from a different starting point).',
      shape: { url: z.string().url() },
      handler: async (args) => {
        const url = String(args.url);
        if (allowedHosts.length > 0 && !isHostAllowed(url, allowedHosts)) {
          return { content: `navigate refused: ${url} not in allowed_hosts.` };
        }
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await dismissPersistentBanners(page, makeNoopLogger());
          return { content: `navigated to ${page.url()}` };
        } catch (err) {
          return {
            content: `navigate failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    {
      name: 'click',
      description:
        'Click an element by Playwright locator (e.g. `role=button[name="Log in"]`, `#loginButton`, `a.cc-dismiss`).',
      shape: { locator: z.string().min(1) },
      handler: async (args) => {
        const locator = String(args.locator);
        try {
          await page.locator(locator).first().click({ timeout: 5_000 });
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          return { content: `clicked ${locator}; now on ${page.url()}` };
        } catch (err) {
          return { content: `click failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'type',
      description: 'Fill a text input by locator. Replaces existing value.',
      shape: { locator: z.string().min(1), value: z.string() },
      handler: async (args) => {
        const locator = String(args.locator);
        const value = String(args.value);
        try {
          await page.locator(locator).first().fill(value, { timeout: 5_000 });
          return { content: `filled ${locator} (${value.length} chars)` };
        } catch (err) {
          return { content: `type failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'fill_form',
      description:
        'Fill multiple inputs in one call. Each entry is { locator, value }. More efficient than several `type` calls.',
      shape: {
        fields: z.array(z.object({ locator: z.string().min(1), value: z.string() })).min(1),
      },
      handler: async (args) => {
        const fields = args.fields as Array<{ locator: string; value: string }>;
        const lines: string[] = [];
        for (const f of fields) {
          try {
            await page.locator(f.locator).first().fill(f.value, { timeout: 5_000 });
            lines.push(`  ✓ ${f.locator}`);
          } catch (err) {
            lines.push(`  ✗ ${f.locator}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { content: `fill_form (${fields.length} field(s)):\n${lines.join('\n')}` };
      },
    },
    {
      name: 'press_key',
      description:
        'Press a key on the focused element (or document). Useful for submitting via Enter when no submit button exists.',
      shape: { key: z.string().min(1), locator: z.string().optional() },
      handler: async (args) => {
        const key = String(args.key);
        const locator = args.locator ? String(args.locator) : undefined;
        try {
          if (locator) {
            await page.locator(locator).first().press(key, { timeout: 5_000 });
          } else {
            await page.keyboard.press(key);
          }
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          return { content: `pressed ${key}; now on ${page.url()}` };
        } catch (err) {
          return {
            content: `press_key failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    {
      name: 'auth_success',
      description:
        'Call this once you have verified the login succeeded (URL changed, logged-in UI visible, no error). Terminal — the auth agent stops after this.',
      shape: { detail: z.string().optional() },
      handler: async (args) => {
        const detail = args.detail
          ? String(args.detail)
          : `logged in successfully (final URL: ${page.url()})`;
        onSuccess(detail);
        return { content: `auth_success acknowledged: ${detail}` };
      },
    },
    {
      name: 'auth_failed',
      description:
        'Call this if you cannot log in (wrong credentials, captcha required, login form unreachable, etc.). Terminal.',
      shape: { reason: z.string().min(1) },
      handler: async (args) => {
        const reason = String(args.reason);
        onFailed(reason);
        return { content: `auth_failed acknowledged: ${reason}` };
      },
    },
  ];
}

function makeNoopLogger(): Logger {
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
// `writeFile` isn't currently used (storageState uses Playwright's built-in
// path arg) but kept imported in case future callers want to override the
// path serialisation. Suppress the unused-import warning.
void writeFile;
