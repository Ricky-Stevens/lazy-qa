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
 * Shared helpers (AUTH_AGENT_SYSTEM_PROMPT, captureSessionInfo, safeSnapshot,
 * makeNoopLogger, launchAuthBrowser, handle*, AuthAgentInput, AuthAgentResult)
 * are imported from auth-agent-shared.ts — not from auth-agent.ts — to avoid a
 * runtime circular import (auth-agent.ts imports runAuthAgentSdk from this file).
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeBinaryPath } from '../llm/sdk-binary.ts';
import {
  AUTH_AGENT_SYSTEM_PROMPT,
  AUTH_TOOL_DESCRIPTIONS,
  AUTH_TOOL_SHAPES,
  type AuthAgentInput,
  type AuthAgentResult,
  captureSessionInfo,
  DEFAULT_MAX_TURNS,
  handleAuthFailed,
  handleAuthSuccess,
  handleClick,
  handleFillForm,
  handleNavigate,
  handlePressKey,
  handleSnapshot,
  handleType,
  launchAuthBrowser,
  safeSnapshot,
} from './auth-agent-shared.ts';
import { computeCostUsd } from './cost.ts';

/** Wrap a plain text string as an MCP CallToolResult content block array.
 *  The SDK's `tool()` expects `content` to be `ContentBlock[]` (MCP spec),
 *  not a plain string. */
function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

export async function runAuthAgentSdk(input: AuthAgentInput): Promise<AuthAgentResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = Date.now();
  input.logger.info('auth-agent-sdk.start', {
    targetUrl: input.targetUrl,
    loginUrl: input.loginUrl,
    model: input.model,
    username: input.credentials.username,
  });

  // 1. Launch browser using the shared helper.
  const { browser, context, page } = await launchAuthBrowser(input);

  // 2. Shared closure state. Mutated by auth_success / auth_failed tool handlers.
  let terminalSignal: 'success' | 'failed' | null = null;
  let terminalDetail = '';
  let totalCostUsd = 0;
  let turn = 0;
  let lastFinalUrl = page.url();

  const onSuccess = (detail: string) => {
    terminalSignal = 'success';
    terminalDetail = detail;
  };
  const onFailed = (reason: string) => {
    terminalSignal = 'failed';
    terminalDetail = reason;
  };

  // 3. Build MCP tools using SDK tool() — handlers delegate to shared functions.
  const authTools = [
    tool(
      'snapshot',
      AUTH_TOOL_DESCRIPTIONS.snapshot,
      AUTH_TOOL_SHAPES.snapshot,
      async () => {
        const r = await handleSnapshot(page);
        return textResult(r.text);
      },
    ),

    tool(
      'navigate',
      AUTH_TOOL_DESCRIPTIONS.navigate,
      AUTH_TOOL_SHAPES.navigate,
      async ({ url }: { url: string }) => {
        const r = await handleNavigate(page, input.allowedHosts, url);
        return textResult(r.text);
      },
    ),

    tool(
      'click',
      AUTH_TOOL_DESCRIPTIONS.click,
      AUTH_TOOL_SHAPES.click,
      async ({ locator }: { locator: string }) => {
        const r = await handleClick(page, locator);
        return textResult(r.text);
      },
    ),

    tool(
      'type',
      AUTH_TOOL_DESCRIPTIONS.type,
      AUTH_TOOL_SHAPES.type,
      async ({ locator, value }: { locator: string; value: string }) => {
        const r = await handleType(page, locator, value);
        return textResult(r.text);
      },
    ),

    tool(
      'fill_form',
      AUTH_TOOL_DESCRIPTIONS.fill_form,
      AUTH_TOOL_SHAPES.fill_form,
      async ({ fields }: { fields: Array<{ locator: string; value: string }> }) => {
        const r = await handleFillForm(page, fields);
        return textResult(r.text);
      },
    ),

    tool(
      'press_key',
      AUTH_TOOL_DESCRIPTIONS.press_key,
      AUTH_TOOL_SHAPES.press_key,
      async ({ key, locator }: { key: string; locator?: string }) => {
        const r = await handlePressKey(page, key, locator);
        return textResult(r.text);
      },
    ),

    tool(
      'auth_success',
      AUTH_TOOL_DESCRIPTIONS.auth_success,
      AUTH_TOOL_SHAPES.auth_success,
      async ({ detail }: { detail?: string }) => {
        const r = handleAuthSuccess(page, onSuccess, detail ? String(detail) : undefined);
        return textResult(r.text);
      },
    ),

    tool(
      'auth_failed',
      AUTH_TOOL_DESCRIPTIONS.auth_failed,
      AUTH_TOOL_SHAPES.auth_failed,
      async ({ reason }: { reason: string }) => {
        const r = handleAuthFailed(onFailed, String(reason));
        return textResult(r.text);
      },
    ),
  ];

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

  // 4. AbortController bridging — same pattern as loop-sdk.ts.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.abortSignal?.aborted) {
    controller.abort();
  } else if (input.abortSignal) {
    input.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // 5. Per-turn snapshot injection via async generator.
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
        permissionMode: 'dontAsk',
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

  // 6. If the loop ended without a terminal signal, set a fallback reason.
  if (!terminalSignal) {
    if (controller.signal.aborted || input.abortSignal?.aborted) {
      terminalSignal = 'failed';
      terminalDetail = 'auth-agent aborted before resolving';
    } else {
      terminalSignal = 'failed';
      terminalDetail = `Loop exited without calling auth_success or auth_failed (${turn} turn(s))`;
    }
  }

  // 7. On success, capture storage state + derive sessionInfo.
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
