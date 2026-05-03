/**
 * SDK-driven authentication agent. Parallel implementation of auth-agent.ts
 * that runs the same 8-tool auth loop under `query()` from
 * `@anthropic-ai/claude-agent-sdk` instead of raw `messages.create`.
 *
 * Public surface is identical to auth-agent.ts:
 *   runAuthAgentSdk(input: AuthAgentInput): Promise<AuthAgentResult>
 *
 * Key differences vs API-mode auth-agent.ts:
 *   - Tools are wired as a single MCP server via `tool()` + `createSdkMcpServer`
 *   - Per-turn snapshot injection is delivered via an async-generator prompt
 *     (the SDK iterates it, requesting a new user message between each turn)
 *   - AbortController is bridged from input.abortSignal (same as loop-sdk.ts)
 *
 * NOTE: Pre-loop browser launch (launchBrowser, page.goto, dismissPersistentBanners)
 * is copied from auth-agent.ts. If the launch logic changes, update both.
 *
 * Shared helpers (AUTH_AGENT_SYSTEM_PROMPT, captureSessionInfo, safeSnapshot,
 * makeNoopLogger, AuthAgentInput, AuthAgentResult) are imported from
 * auth-agent-shared.ts — not from auth-agent.ts — to avoid a runtime circular
 * import (auth-agent.ts imports runAuthAgentSdk from this file).
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Page } from 'playwright';
import { z } from 'zod';
import { dismissPersistentBanners, launchBrowser } from '../auth/login.ts';
import { resolveClaudeBinaryPath } from '../llm/sdk-binary.ts';
import type { Logger } from '../logging/logger.ts';
import { isHostAllowed } from '../safety/guards.ts';
import {
  AUTH_AGENT_SYSTEM_PROMPT,
  type AuthAgentInput,
  type AuthAgentResult,
  captureSessionInfo,
  DEFAULT_MAX_TURNS,
  makeNoopLogger,
  safeSnapshot,
} from './auth-agent-shared.ts';
import { computeCostUsd } from './cost.ts';

export async function runAuthAgentSdk(input: AuthAgentInput): Promise<AuthAgentResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = Date.now();
  input.logger.info('auth-agent-sdk.start', {
    targetUrl: input.targetUrl,
    loginUrl: input.loginUrl,
    model: input.model,
    username: input.credentials.username,
  });

  // 1. Launch a browser. Copied verbatim from auth-agent.ts; see file header
  //    comment for why this is intentional duplication rather than a helper.
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
    await dismissPersistentBanners(page, input.logger.child({ phase: 'auth-agent-sdk.warmup' }));
  } catch (err) {
    input.logger.warn('auth-agent-sdk.goto.failed', {
      url: startUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Shared closure state. Mutated by auth_success / auth_failed tool handlers.
  let terminalSignal: 'success' | 'failed' | null = null;
  let terminalDetail = '';
  let totalCostUsd = 0;
  let turn = 0;
  let lastFinalUrl = page.url();

  // 4. Build MCP tools (same 8 as auth-agent.ts buildAuthTools, using SDK tool()).
  const authTools = buildSdkAuthTools({
    page,
    allowedHosts: input.allowedHosts,
    logger: input.logger,
    onSuccess: (detail) => {
      terminalSignal = 'success';
      terminalDetail = detail;
    },
    onFailed: (reason) => {
      terminalSignal = 'failed';
      terminalDetail = reason;
    },
  });

  const AUTH_SERVER_NAME = 'auth';
  const authServer = createSdkMcpServer({
    name: AUTH_SERVER_NAME,
    version: '1.0.0',
    tools: authTools,
  });

  // Pre-approve all auth tools so the SDK auto-executes them without prompting
  // — same rationale as loop-sdk.ts.
  const authAllowedTools = authTools.map(
    (t) => `mcp__${AUTH_SERVER_NAME}__${(t as { name: string }).name}`,
  );

  // 5. AbortController bridging — same pattern as loop-sdk.ts.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.abortSignal?.aborted) {
    controller.abort();
  } else if (input.abortSignal) {
    input.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // 6. Per-turn snapshot injection via async generator.
  //    The SDK iterates this, pulling a new user message before each assistant turn.
  //
  //    Lockstep gate: see loop-sdk.ts for the full explanation. The SDK's
  //    `streamInput` consumes this generator with a plain `for await`, pumping
  //    yields directly to claude's stdin. Without an explicit per-turn gate,
  //    the loop conditions (terminalSignal, turn) only re-evaluate via the
  //    SEPARATE consumer below — so we'd flood claude with snapshot-bearing
  //    messages between yields. Block the next yield until the consumer has
  //    processed an assistant message (or signalled termination).
  const TURN_GATE_TIMEOUT_MS = 120_000;
  let turnGateResolve: (() => void) | null = null;
  let turnGatePromise: Promise<void> = Promise.resolve();
  function armTurnGate(): void {
    turnGatePromise = new Promise<void>((r) => {
      turnGateResolve = r;
      setTimeout(() => {
        if (turnGateResolve === r) {
          input.logger.warn('auth-agent-sdk.turnGate.timeout');
          r();
          turnGateResolve = null;
        }
      }, TURN_GATE_TIMEOUT_MS).unref();
    });
  }
  function releaseTurnGate(): void {
    if (turnGateResolve) {
      const r = turnGateResolve;
      turnGateResolve = null;
      r();
    }
  }
  async function* prompts() {
    // First turn — include the URL context.
    const initialSnap = await safeSnapshot(page);
    armTurnGate();
    yield {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: `You are on: ${page.url()}\n\nCurrent page snapshot:\n${initialSnap}\n\nLog in now.`,
      },
      parent_tool_use_id: null,
    };
    await turnGatePromise;
    // Subsequent turns — yield a fresh snapshot between each assistant reply.
    // Stop yielding when terminal (tool called success/failed), aborted, or
    // max turns reached. The SDK will also stop iterating once it decides the
    // conversation is complete, so we don't need to count exactly — the guard
    // here is belt-and-braces.
    while (!terminalSignal && !input.abortSignal?.aborted && turn < maxTurns) {
      const snap = await safeSnapshot(page);
      armTurnGate();
      yield {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: `Current page snapshot:\n${snap}\n\nContinue.`,
        },
        parent_tool_use_id: null,
      };
      await turnGatePromise;
    }
  }

  // Dedupe assistant messages — SDK emits each one twice in stream-json mode.
  // See loop-sdk.ts for the same fix + observation.
  const seenAssistantIds = new Set<string>();
  try {
    for await (const message of query({
      prompt: prompts(),
      options: {
        model: input.model,
        systemPrompt: AUTH_AGENT_SYSTEM_PROMPT(input.credentials),
        maxTurns: maxTurns,
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        // Auth-agent's only tool surface is the auth MCP server. Disable the
        // SDK's built-in Claude Code tools (host filesystem/shell access) and
        // the user's global CLAUDE.md / settings.json from the system prompt.
        tools: [],
        settingSources: [],
        mcpServers: { [AUTH_SERVER_NAME]: authServer },
        allowedTools: authAllowedTools,
        abortController: controller,
      },
    })) {
      if (message.type === 'assistant') {
        // SDKAssistantMessage narrows here; widen the inner BetaMessage's usage
        // fields to optional because the SDK can omit them on partial streams.
        const m = message.message as {
          id?: string;
          content: Array<{ type: string; text?: string; name?: string }>;
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };

        // First emission already released the gate. Do not re-release on
        // the duplicate — see loop-sdk.ts for why.
        if (m.id && seenAssistantIds.has(m.id)) {
          continue;
        }
        if (m.id) seenAssistantIds.add(m.id);

        turn += 1;
        lastFinalUrl = page.url();

        if (m.usage) {
          const turnUsage = {
            input: m.usage.input_tokens ?? 0,
            output: m.usage.output_tokens ?? 0,
            cacheRead: m.usage.cache_read_input_tokens ?? 0,
            cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
          };
          try {
            totalCostUsd += computeCostUsd(input.model, turnUsage);
          } catch {
            // Unknown model — cost stays at 0 delta; token totals are still
            // captured in turns/log for observability.
          }
        }

        // Unblock the prompts() generator so the next snapshot+Continue can yield.
        releaseTurnGate();
      }

      if (message.type === 'result') {
        // The SDK has terminated the conversation. Release any pending gate
        // so the generator exits cleanly, then break.
        releaseTurnGate();
        break;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted && !input.abortSignal?.aborted) {
      input.logger.error('auth-agent-sdk.query.error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!terminalSignal) {
      terminalSignal = 'failed';
      terminalDetail =
        controller.signal.aborted || input.abortSignal?.aborted
          ? 'auth-agent aborted'
          : `query error: ${err instanceof Error ? err.message : String(err)}`;
    }
    releaseTurnGate();
  } finally {
    if (input.abortSignal) {
      input.abortSignal.removeEventListener('abort', onAbort);
    }
    releaseTurnGate();
    void startedAt;
  }

  // 7. If the loop ended without a terminal signal, set a fallback reason.
  if (!terminalSignal) {
    if (controller.signal.aborted || input.abortSignal?.aborted) {
      terminalSignal = 'failed';
      terminalDetail = 'auth-agent aborted before resolving';
    } else {
      terminalSignal = 'failed';
      terminalDetail = `Loop exited without calling auth_success or auth_failed (${turn} turn(s))`;
    }
  }

  // 8. On success, capture storage state + derive sessionInfo.
  //    Cast away TS narrowing — the closure can mutate terminalSignal
  //    during awaited tool handlers, exactly like the API-mode version.
  try {
    if ((terminalSignal as 'success' | 'failed') === 'success') {
      try {
        await context.storageState({ path: input.storageStatePath, indexedDB: true });
        const sessionInfo = await captureSessionInfo(context, input.credentials.username);
        input.logger.info('auth-agent-sdk.success', {
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
          detail: terminalDetail || `logged in via auth-agent-sdk in ${turn} turn(s)`,
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

    input.logger.warn('auth-agent-sdk.failed', {
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
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/** Wrap a plain text string as an MCP CallToolResult content block array.
 *  The SDK's `tool()` expects `content` to be `ContentBlock[]` (MCP spec),
 *  not a plain string. */
function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/** Build the 8-tool set as SDK tool() objects.
 *  Bodies match the handlers in auth-agent.ts buildAuthTools exactly. */
function buildSdkAuthTools(deps: {
  page: Page;
  allowedHosts: string[];
  logger: Logger;
  onSuccess: (detail: string) => void;
  onFailed: (reason: string) => void;
}) {
  const { page, allowedHosts, onSuccess, onFailed } = deps;

  return [
    tool(
      'snapshot',
      'Re-take a structured snapshot of the current page. Use after any action whose effect you need to observe.',
      {},
      async () => {
        const snap = await safeSnapshot(page);
        return textResult(snap);
      },
    ),

    tool(
      'navigate',
      'Navigate to a URL. Use only if the login flow takes you off the current page (e.g. you need to retry from a different starting point).',
      { url: z.string().url() },
      async ({ url }) => {
        if (allowedHosts.length > 0 && !isHostAllowed(url, allowedHosts)) {
          return textResult(`navigate refused: ${url} not in allowed_hosts.`);
        }
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await dismissPersistentBanners(page, makeNoopLogger());
          return textResult(`navigated to ${page.url()}`);
        } catch (err) {
          return textResult(`navigate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    ),

    tool(
      'click',
      'Click an element by Playwright locator (e.g. `role=button[name="Log in"]`, `#loginButton`, `a.cc-dismiss`).',
      { locator: z.string().min(1) },
      async ({ locator }) => {
        try {
          await page.locator(locator).first().click({ timeout: 5_000 });
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          return textResult(`clicked ${locator}; now on ${page.url()}`);
        } catch (err) {
          return textResult(`click failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    ),

    tool(
      'type',
      'Fill a text input by locator. Replaces existing value.',
      { locator: z.string().min(1), value: z.string() },
      async ({ locator, value }) => {
        try {
          await page.locator(locator).first().fill(value, { timeout: 5_000 });
          return textResult(`filled ${locator} (${value.length} chars)`);
        } catch (err) {
          return textResult(`type failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    ),

    tool(
      'fill_form',
      'Fill multiple inputs in one call. Each entry is { locator, value }. More efficient than several `type` calls.',
      {
        fields: z.array(z.object({ locator: z.string().min(1), value: z.string() })).min(1),
      },
      async ({ fields }) => {
        const lines: string[] = [];
        for (const f of fields) {
          try {
            await page.locator(f.locator).first().fill(f.value, { timeout: 5_000 });
            lines.push(`  ✓ ${f.locator}`);
          } catch (err) {
            lines.push(`  ✗ ${f.locator}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return textResult(`fill_form (${fields.length} field(s)):\n${lines.join('\n')}`);
      },
    ),

    tool(
      'press_key',
      'Press a key on the focused element (or document). Useful for submitting via Enter when no submit button exists.',
      { key: z.string().min(1), locator: z.string().optional() },
      async ({ key, locator }) => {
        try {
          if (locator) {
            await page.locator(locator).first().press(key, { timeout: 5_000 });
          } else {
            await page.keyboard.press(key);
          }
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          return textResult(`pressed ${key}; now on ${page.url()}`);
        } catch (err) {
          return textResult(
            `press_key failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    tool(
      'auth_success',
      'Call this once you have verified the login succeeded (URL changed, logged-in UI visible, no error). Terminal — the auth agent stops after this.',
      { detail: z.string().optional() },
      async ({ detail }) => {
        const msg = detail ? String(detail) : `logged in successfully (final URL: ${page.url()})`;
        onSuccess(msg);
        return textResult(`auth_success acknowledged: ${msg}`);
      },
    ),

    tool(
      'auth_failed',
      'Call this if you cannot log in (wrong credentials, captcha required, login form unreachable, etc.). Terminal.',
      { reason: z.string().min(1) },
      async ({ reason }) => {
        onFailed(String(reason));
        return textResult(`auth_failed acknowledged: ${String(reason)}`);
      },
    ),
  ];
}
