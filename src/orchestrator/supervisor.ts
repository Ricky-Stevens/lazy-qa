import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { recoverAllSessions } from '../auth/session-pool.ts';
import type { ApiLlmBackend } from '../llm/api-backend.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import { computeCostUsd } from './cost.ts';
import {
  count4xxIn,
  count5xxIn,
  getGlobalPauseSnapshot,
  pushNudge,
  setGlobalPause,
  snapshotAll,
} from './registry.ts';
import { runSupervisorSdk } from './supervisor-sdk.ts';
import {
  buildSystemPrompt,
  type SupervisorInput,
  type SupervisorResult,
} from './supervisor-shared.ts';

export type { SupervisorInput, SupervisorResult };
// Re-export the types + system-prompt builder so existing consumers (run.ts,
// supervisor-sdk.test.ts, etc.) continue to import from './supervisor.ts'
// without touching the rest of the codebase. The canonical home is now
// supervisor-shared.ts.
export { buildSystemPrompt };

/**
 * Supervisor agent. Watches the explorer agents via the runtime registry,
 * intervenes aggressively when they get stuck.
 *
 * Detects (aggressive mode):
 *   - auth_walled (URL on Auth0 login/logout) → call relogin_session, nudge
 *   - no progress in 60s → nudge with a specific suggestion
 *   - 4xx storm (multi-agent or per-agent threshold) → pause_agents
 *
 * Tools available: list_agents, relogin_session, nudge_agent, wait, end_session.
 * No browser tools. No findings tools. The supervisor does NOT explore.
 *
 * Implementation: direct Anthropic SDK only — the supervisor's tools are
 * synthesised here; no MCP subprocess needed. Runs concurrently with the
 * explorer agents in run.ts via Promise.allSettled.
 */

export async function runSupervisor(input: SupervisorInput): Promise<SupervisorResult> {
  if (input.backend.kind === 'sdk') {
    return runSupervisorSdk(input);
  }
  const client = (input.backend as ApiLlmBackend).getRawClient();
  const { events } = input;
  const startedAt = Date.now();
  let turns = 0;
  let costUsd = 0;
  let reloginCount = 0;
  let nudgeCount = 0;
  let pauseCount = 0;
  let broadcastCount = 0;
  let selfEnded = false;
  let endedReason: SupervisorResult['endedReason'] = 'max-turns';

  const systemPrompt = buildSystemPrompt(input.authType);
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Tool definitions. RawToolDef shape is reused so we get z.toJSONSchema for free.
  const rawTools: RawToolDef[] = [
    {
      name: 'list_agents',
      description:
        'Return live runtime state for every explorer agent: id, profileName, status (starting | active | auth_walled | finished | errored), currentUrl, last action timestamp, last turn timestamp, findings count, turns completed, recent tool names, pending nudge. Call this at the start of each cycle to decide who needs help.',
      shape: {},
      handler: async () => {
        const all = snapshotAll();
        const now = Date.now();
        const globalPause = getGlobalPauseSnapshot();
        const lines = all.map((a) => {
          const lastActionAgo = a.lastActionAt ? Math.round((now - a.lastActionAt) / 1000) : null;
          const lastTurnAgo = a.lastTurnAt ? Math.round((now - a.lastTurnAt) / 1000) : null;
          const recent4xx = count4xxIn(a.agentId, 30_000);
          const recent5xx = count5xxIn(a.agentId, 30_000);
          const agentPauseRemainingSec =
            a.pauseUntil && a.pauseUntil > now ? Math.round((a.pauseUntil - now) / 1000) : 0;
          return JSON.stringify({
            agentId: a.agentId,
            profile: a.profileName,
            status: a.status,
            authWalled: a.authWalled,
            currentUrl: a.currentUrl,
            lastActionSecondsAgo: lastActionAgo,
            lastTurnSecondsAgo: lastTurnAgo,
            turns: a.turnsCompleted,
            findings: a.findingsCount,
            recentTools: a.recentTools,
            recent4xxCount: recent4xx,
            recent5xxCount: recent5xx,
            agentPauseRemainingSec,
            hasPendingNudge: a.pendingNudge !== null,
          });
        });
        const globalPauseRemainingSec =
          globalPause.until > now ? Math.round((globalPause.until - now) / 1000) : 0;
        const header =
          globalPauseRemainingSec > 0
            ? `Global pause: ${globalPauseRemainingSec}s remaining (reason: ${globalPause.reason}).\n`
            : '';

        // Team intel block — credentials and discovered routes the team has
        // accumulated. Surfacing these is how the supervisor decides when
        // to broadcast "creds available, log in NOW" directives.
        let intelText = '';
        if (input.sharedKnowledge) {
          const snap = input.sharedKnowledge.snapshot();
          if (snap.credentials.length > 0 || snap.routes.length > 0) {
            const intelLines: string[] = ['Team intelligence:'];
            if (snap.credentials.length > 0) {
              intelLines.push(`  Credentials (${snap.credentials.length}):`);
              for (const c of snap.credentials.slice(0, 8)) {
                const ver = c.loginVerified ? ' [verified]' : '';
                intelLines.push(
                  `    ${c.username}:${c.password.slice(0, 3)}***${ver} (by ${c.foundBy}, source: ${c.source})`,
                );
              }
            }
            if (snap.routes.length > 0) {
              intelLines.push(`  Discovered routes (${snap.routes.length}):`);
              for (const r of snap.routes.slice(0, 10)) {
                intelLines.push(
                  `    ${r.url} ${r.requiresAuth ? '[auth]' : ''} status=${r.lastStatus} (by ${r.foundBy})`,
                );
              }
            }
            intelText = `${intelLines.join('\n')}\n\n`;
          }
        }

        let exhaustedText = '';
        if (input.siteMap) {
          const untestedForms = new Set(
            input.siteMap.listFormsUntested('form_fuzz_validation').map((f) => f.route),
          );
          const untestedTables = new Set(
            input.siteMap.listTablesUntested('table_sort_each_column').map((t) => t.route),
          );
          const untestedModals = new Set(
            input.siteMap.listModalsUntested('modal_lifecycle').map((m) => m.route),
          );
          const untestedWizards = new Set(
            input.siteMap.listWizardsUntested('walk_wizard').map((w) => w.route),
          );
          const allRoutes = input.siteMap.listAllRoutes();
          const exhausted = allRoutes
            .filter((r) => {
              if (!r.visited) return false;
              const hasAffordances =
                r.formIds.length > 0 ||
                r.tableIds.length > 0 ||
                r.modalIds.length > 0 ||
                r.wizardIds.length > 0;
              if (!hasAffordances) return false;
              return (
                !untestedForms.has(r.route) &&
                !untestedTables.has(r.route) &&
                !untestedModals.has(r.route) &&
                !untestedWizards.has(r.route)
              );
            })
            .map((r) => r.route);
          if (exhausted.length > 0) {
            exhaustedText = `\nExhausted routes (fully tested — agents should AVOID these):\n  ${exhausted.slice(0, 30).join('\n  ')}\n`;
          }
        }

        const text =
          lines.length === 0
            ? `${intelText}No agents registered yet. Wait and check again.`
            : `${header}${intelText}${exhaustedText}Agents (${lines.length}):\n${lines.join('\n')}`;
        return { content: [{ type: 'text' as const, text }] };
      },
    },
    {
      name: 'broadcast_to_team',
      description:
        'Push a directive to ALL agents (or all agents matching a profile). Distinct from nudge_agent which targets ONE agent — broadcasts go to every explorer. Use for team-wide intelligence: "credentials X:Y are available, log in now", "admin panel discovered at /admin/users, prioritise it", "target backend is down for everyone, switch to read-only exploration". The harness watermarks per-agent so each broadcast renders exactly once per agent. Cap broadcasts at one per significant team event — repeated broadcasts on the same topic are noise.',
      shape: {
        message: z
          .string()
          .min(20)
          .max(800)
          .describe(
            'The directive. Be concrete: include the credentials/URL/instructions agents will need.',
          ),
        for_profile: z
          .string()
          .optional()
          .describe(
            'Optional: scope the broadcast to agents whose profileName matches (e.g. "bobby-tables"). Omit to broadcast to all profiles.',
          ),
      },
      handler: async (args) => {
        const { message, for_profile } = args as { message: string; for_profile?: string };
        if (!input.sharedKnowledge) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'broadcast_to_team is unavailable in this run (no SharedKnowledge instance). Use nudge_agent instead.',
              },
            ],
          };
        }
        input.sharedKnowledge.addBroadcast({
          message,
          forProfile: for_profile,
          issuedBy: 'supervisor',
          issuedAt: new Date().toISOString(),
        });
        broadcastCount += 1;
        input.logger.info('supervisor.broadcast', {
          forProfile: for_profile,
          preview: message.slice(0, 200),
        });
        await events?.write({
          type: 'team.broadcast',
          message,
          forProfile: for_profile,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Broadcast queued${for_profile ? ` for profile=${for_profile}` : ' for all agents'}. Each agent will see the message exactly once on their next turn.`,
            },
          ],
        };
      },
    },
    {
      name: 'relogin_session',
      description:
        'Re-authenticate every active shared browser session. Use this when ANY agent is auth_walled. The harness opens a recovery tab on each shared context, fills the login form, and closes the tab. Cookies are context-scoped so all agents on that session immediately see the new auth. Deduplicates concurrent calls — calling more than once per minute is harmless but wasteful.',
      shape: {},
      handler: async () => {
        const result = await recoverAllSessions();
        reloginCount += 1;
        const text = `relogin_session result: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} | ${result.detail}`;
        input.logger.info('supervisor.relogin', {
          ok: result.ok,
          recovered: result.recovered,
          failed: result.failed,
          detail: result.detail,
        });
        await events?.write({
          type: 'supervisor.intervention',
          kind: 'auth-walled',
          detail: `relogin: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} — ${result.detail}`,
        });
        return { content: [{ type: 'text' as const, text }] };
      },
    },
    {
      name: 'nudge_agent',
      description:
        "Queue a directive message for a specific agent. The message is delivered as a [SUPERVISOR INTERVENTION] line at the top of that agent's next chunk's user prompt (≤30s latency). Be specific: name what they were doing, what to try instead. A vague nudge is wasted. ONE pending nudge per agent — calling again before consumption overwrites the previous nudge.",
      shape: {
        agentId: z.string().min(1).describe('The agentId from list_agents.'),
        message: z
          .string()
          .min(20)
          .max(1000)
          .describe(
            'Directive for the agent. Reference their currentUrl and recentTools. Tell them what to do, not what to think about.',
          ),
      },
      handler: async (args) => {
        const { agentId, message } = args as { agentId: string; message: string };
        const ok = pushNudge(agentId, message);
        if (ok) nudgeCount += 1;
        const text = ok
          ? `Nudge queued for ${agentId}. They will read it at the start of their next chunk (≤30s).`
          : `Failed: no agent registered with id '${agentId}'. Call list_agents to see valid IDs.`;
        input.logger.info('supervisor.nudge', { agentId, ok, preview: message.slice(0, 200) });
        if (ok) {
          await events?.write({
            type: 'supervisor.intervention',
            kind: 'no-progress',
            detail: `nudge → ${agentId}: ${message.slice(0, 200)}`,
          });
        }
        return { content: [{ type: 'text' as const, text }] };
      },
    },
    {
      name: 'pause_agents',
      description:
        "Pause ALL explorer agents for the given duration. Agents' next browser action will sleep until the pause expires (capped at 30s per call, but the pause persists across calls — they re-sleep on each subsequent action). Use when the backend is unhealthy (multi-agent 4xx storm, global outage) so agents stop burning budget thrashing on errors. Calling again before the previous pause expires extends it. Clamped to [10, 180] seconds.",
      shape: {
        duration_seconds: z.number().int().min(10).max(180),
        reason: z
          .string()
          .min(10)
          .max(200)
          .describe('Why the pause is needed. Surfaced in agent logs and useful for debugging.'),
      },
      handler: async (args) => {
        const { duration_seconds, reason } = args as {
          duration_seconds: number;
          reason: string;
        };
        const clamped = Math.max(10, Math.min(180, duration_seconds));
        const until = Date.now() + clamped * 1000;
        setGlobalPause(until, reason);
        pauseCount += 1;
        input.logger.info('supervisor.pause_agents', { durationSec: clamped, reason });
        await events?.write({
          type: 'supervisor.intervention',
          kind: 'backend-storm',
          detail: `pause_agents ${clamped}s: ${reason}`,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `pause_agents: all agents will sleep until ~${clamped}s from now. Reason: ${reason}. Their next browser action will block; nudges and finding reports continue to work.`,
            },
          ],
        };
      },
    },
    {
      name: 'wait',
      description:
        'Pause for the specified number of seconds before your next turn. The harness sleeps real time — do not poll faster than every 30 seconds. Clamped to [10, 120].',
      shape: {
        seconds: z.number().int().min(10).max(120),
      },
      handler: async (args) => {
        const { seconds } = args as { seconds: number };
        const clamped = Math.max(10, Math.min(120, seconds));
        await new Promise((r) => setTimeout(r, clamped * 1000));
        return { content: [{ type: 'text' as const, text: `Waited ${clamped}s.` }] };
      },
    },
    {
      name: 'end_session',
      description:
        'Stop the supervisor loop. Use ONLY when all agents have status=finished or status=errored. NEVER use while any agent is still active or auth_walled.',
      shape: {
        reason: z.string().min(5).max(200),
      },
      handler: async (args) => {
        const { reason } = args as { reason: string };
        selfEnded = true;
        input.logger.info('supervisor.end_session', { reason });
        return { content: [{ type: 'text' as const, text: `Supervisor ending: ${reason}` }] };
      },
    },
  ];

  if (input.testPlan) {
    rawTools.push({
      name: 'check_plan_coverage',
      description:
        'Return the current test plan with completion status. Shows which items have been completed by agents, which are still uncovered, and suggests the best persona for each gap. Call this periodically to decide whether to nudge agents toward uncovered items.',
      shape: {},
      handler: async () => {
        const { getPlanSummary } = await import('./test-plan.ts');
        const summary = getPlanSummary(input.testPlan!);
        return { content: [{ type: 'text' as const, text: summary }] };
      },
    });
  }

  // For runs with auth.type='none' there is no login to recover. Hide the
  // relogin_session tool entirely so the supervisor's LLM can't waste a turn
  // calling it (and getting "Cannot recover: session was started without
  // form credentials" back).
  const enabledTools =
    input.authType === 'form' ? rawTools : rawTools.filter((t) => t.name !== 'relogin_session');

  const anthropicToolsRaw: Anthropic.Tool[] = enabledTools.map((rt) => {
    const objSchema = z.object(rt.shape);
    const jsonSchema = z.toJSONSchema(objSchema) as Record<string, unknown>;
    return {
      name: rt.name,
      description: rt.description,
      input_schema: jsonSchema as Anthropic.Tool['input_schema'],
    };
  });

  // Cache the tools array: mark the last entry with a 1h breakpoint.
  // Anthropic caches tools[0..lastIndex] inclusive when the last has cache_control.
  const anthropicTools: Anthropic.Tool[] =
    anthropicToolsRaw.length > 0
      ? [
          ...anthropicToolsRaw.slice(0, -1),
          {
            ...anthropicToolsRaw[anthropicToolsRaw.length - 1]!,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ]
      : [];

  const handlerByName = new Map(enabledTools.map((rt) => [rt.name, rt.handler]));

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Begin supervising. Call list_agents to see who is active, then act. Do not narrate.',
    },
  ];

  while (
    !input.abortSignal.aborted &&
    !selfEnded &&
    turns < input.maxTurns &&
    costUsd < input.maxUsd &&
    Date.now() - startedAt < input.maxMinutes * 60_000
  ) {
    let response!: Anthropic.Message;
    const SUPERVISOR_API_RETRIES = 3;
    const SUPERVISOR_RETRY_BASE_MS = 5_000;
    let supervisorAttempt = 0;
    let apiFailed = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      supervisorAttempt += 1;
      try {
        response = await client.messages.create({
          model: input.model,
          max_tokens: 2048,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages,
          tools: anthropicTools,
          // Force tool use every turn. The supervisor's job is to observe
          // (list_agents) and intervene (nudge/pause/broadcast) — it should
          // never produce text-only turns. Eliminates the "output text without
          // calling a tool" correction logic below.
          tool_choice: { type: 'any' },
        });
        break;
      } catch (err) {
        if (input.abortSignal.aborted) {
          endedReason = 'signal';
          apiFailed = true;
          break;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number }).status;
        const isRetryable =
          status === 429 ||
          status === 529 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up/i.test(errMsg);
        if (isRetryable && supervisorAttempt < SUPERVISOR_API_RETRIES) {
          const delayMs = SUPERVISOR_RETRY_BASE_MS * 2 ** (supervisorAttempt - 1);
          input.logger.warn('supervisor.api.retry', {
            attempt: supervisorAttempt,
            status,
            error: errMsg,
            delayMs,
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        endedReason = 'error';
        input.logger.error('supervisor.api.error', {
          error: errMsg,
          attempts: supervisorAttempt,
        });
        apiFailed = true;
        break;
      }
    }
    if (apiFailed) break;

    turns += 1;
    const usage = response.usage;
    tokenUsage.input += usage.input_tokens ?? 0;
    tokenUsage.output += usage.output_tokens ?? 0;
    tokenUsage.cacheRead += usage.cache_read_input_tokens ?? 0;
    tokenUsage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    try {
      costUsd = computeCostUsd(input.model, tokenUsage);
    } catch {
      // Unknown model → keep going on token totals only.
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // No tool call → supervisor emitted prose only. That's a violation of
      // its prompt; nudge it back into shape.
      messages.push({
        role: 'user',
        content:
          'You output text without calling a tool. That is forbidden. Call list_agents now, then act, then wait.',
      });
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use) => {
        const handler = handlerByName.get(use.name);
        if (!handler) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Unknown tool: ${use.name}`,
            is_error: true,
          } satisfies Anthropic.ToolResultBlockParam;
        }
        try {
          const result = await handler(use.input as Record<string, unknown>);
          const text = result.content[0]?.text ?? '';
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: text,
          } satisfies Anthropic.ToolResultBlockParam;
        } catch (err) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: err instanceof Error ? err.message : String(err),
            is_error: true,
          } satisfies Anthropic.ToolResultBlockParam;
        }
      }),
    );

    messages.push({ role: 'user', content: toolResults });

    if (selfEnded) {
      endedReason = 'self-ended';
      break;
    }

    // Cheap belt-and-braces: if every registered agent is in a terminal state,
    // we can stop early without waiting for the supervisor to call end_session.
    const all = snapshotAll();
    if (all.length > 0 && all.every((a) => a.status === 'finished' || a.status === 'errored')) {
      endedReason = 'all-finished';
      break;
    }
  }

  if (input.abortSignal.aborted && endedReason === 'max-turns') endedReason = 'signal';
  if (costUsd >= input.maxUsd && endedReason === 'max-turns') endedReason = 'budget-hit';

  input.logger.info('supervisor.complete', {
    turns,
    costUsd: costUsd.toFixed(4),
    reloginCount,
    nudgeCount,
    pauseCount,
    broadcastCount,
    endedReason,
  });

  return { turns, costUsd, endedReason, reloginCount, nudgeCount, pauseCount, broadcastCount };
}
