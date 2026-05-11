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

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ApiLlmBackend } from '../llm/api-backend.ts';
import { runAuthAgentSdk } from './auth-agent-sdk.ts';
import {
  AUTH_AGENT_SYSTEM_PROMPT,
  AUTH_TOOL_DESCRIPTIONS,
  AUTH_TOOL_SHAPES,
  type AuthAgentInput,
  type AuthAgentResult,
  captureSessionInfo,
  DEFAULT_MAX_TURNS,
  decodeJwtClaim,
  findString,
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

// Re-export types and helpers so external consumers (run.ts, auth-agent-sdk.test.ts,
// spawn-agent.ts, etc.) continue to work without import churn.
export type { AuthAgentInput, AuthAgentResult };
export { AUTH_AGENT_SYSTEM_PROMPT, captureSessionInfo, decodeJwtClaim, findString, safeSnapshot };

const MAX_OUTPUT_TOKENS = 1024;

interface AuthRawTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{ content: string }>;
}

export async function runAuthAgent(input: AuthAgentInput): Promise<AuthAgentResult> {
  // Dispatch to the SDK variant early — before we spin up a browser — so we
  // don't waste a launch/close cycle for non-API backends.
  if (input.backend.kind === 'sdk') {
    return runAuthAgentSdk(input);
  }

  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  input.logger.info('auth-agent.start', {
    targetUrl: input.targetUrl,
    loginUrl: input.loginUrl,
    model: input.model,
    username: input.credentials.username,
  });

  // 1. Launch browser using the shared helper.
  const { browser, context, page } = await launchAuthBrowser(input);

  // 2. Build the tight tool set. Handlers delegate to shared functions.
  let terminalSignal: 'success' | 'failed' | null = null;
  let terminalDetail = '';
  const onSuccess = (detail: string) => {
    terminalSignal = 'success';
    terminalDetail = detail;
  };
  const onFailed = (reason: string) => {
    terminalSignal = 'failed';
    terminalDetail = reason;
  };

  const tools: AuthRawTool[] = [
    {
      name: 'snapshot',
      description: AUTH_TOOL_DESCRIPTIONS.snapshot,
      shape: AUTH_TOOL_SHAPES.snapshot,
      handler: async () => {
        const r = await handleSnapshot(page);
        return { content: r.text };
      },
    },
    {
      name: 'navigate',
      description: AUTH_TOOL_DESCRIPTIONS.navigate,
      shape: AUTH_TOOL_SHAPES.navigate,
      handler: async (args) => {
        const r = await handleNavigate(page, input.allowedHosts, String(args.url));
        return { content: r.text };
      },
    },
    {
      name: 'click',
      description: AUTH_TOOL_DESCRIPTIONS.click,
      shape: AUTH_TOOL_SHAPES.click,
      handler: async (args) => {
        const r = await handleClick(page, String(args.locator));
        return { content: r.text };
      },
    },
    {
      name: 'type',
      description: AUTH_TOOL_DESCRIPTIONS.type,
      shape: AUTH_TOOL_SHAPES.type,
      handler: async (args) => {
        const r = await handleType(page, String(args.locator), String(args.value));
        return { content: r.text };
      },
    },
    {
      name: 'fill_form',
      description: AUTH_TOOL_DESCRIPTIONS.fill_form,
      shape: AUTH_TOOL_SHAPES.fill_form,
      handler: async (args) => {
        const r = await handleFillForm(
          page,
          args.fields as Array<{ locator: string; value: string }>,
        );
        return { content: r.text };
      },
    },
    {
      name: 'press_key',
      description: AUTH_TOOL_DESCRIPTIONS.press_key,
      shape: AUTH_TOOL_SHAPES.press_key,
      handler: async (args) => {
        const r = await handlePressKey(
          page,
          String(args.key),
          args.locator ? String(args.locator) : undefined,
        );
        return { content: r.text };
      },
    },
    {
      name: 'auth_success',
      description: AUTH_TOOL_DESCRIPTIONS.auth_success,
      shape: AUTH_TOOL_SHAPES.auth_success,
      handler: async (args) => {
        const r = handleAuthSuccess(page, onSuccess, args.detail ? String(args.detail) : undefined);
        return { content: r.text };
      },
    },
    {
      name: 'auth_failed',
      description: AUTH_TOOL_DESCRIPTIONS.auth_failed,
      shape: AUTH_TOOL_SHAPES.auth_failed,
      handler: async (args) => {
        const r = handleAuthFailed(onFailed, String(args.reason));
        return { content: r.text };
      },
    },
  ];

  // 3. Run the loop. (SDK-mode was already dispatched above; only 'api' reaches here.)
  const client = (input.backend as ApiLlmBackend).getRawClient();
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

    // 4. On success, capture storage state. Cast away TS narrowing — the
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
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
