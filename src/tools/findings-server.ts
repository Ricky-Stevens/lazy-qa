import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import type { EventWriter } from '../orchestrator/events.ts';
import type { FindingCache } from '../orchestrator/finding-cache.ts';
import type { SharedKnowledge } from '../orchestrator/shared-knowledge.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { captureScreenshot } from './screenshot.ts';

/**
 * Throttle: max findings an agent may file in this rolling window. When the
 * agent thrashes on a cascade (e.g. every route returns 4xx) it can otherwise
 * fire ~30 duplicate findings in 60s, burning model output tokens for content
 * the post-run reviewer just deduplicates anyway. Past this threshold,
 * report_finding returns a synthetic THROTTLED message and does not record.
 */
const FINDINGS_RATE_LIMIT = 8;
const FINDINGS_RATE_WINDOW_MS = 60_000;

export interface HarnessServerInput {
  journey: Journey;
  logger: Logger;
  /** Returns the live Playwright page. Required for `attach_screenshot`. */
  getPage?: () => Page;
  /** Run directory used to materialise screenshot files. Required for `attach_screenshot`. */
  runDir?: string;
  /** Event writer for this run. Optional — emits finding.report events. */
  events?: EventWriter;
  /** Shared cross-agent finding cache. When supplied, every reported finding
   *  is registered so OTHER agents see it in their per-turn user message and
   *  skip rediscovering the same issue. */
  findingCache?: FindingCache;
  /** Shared cross-agent intelligence store (credentials / discovered routes /
   *  tokens). When supplied, the agent gets a `share_with_team` tool that
   *  publishes intelligence into this store; every other agent's next turn
   *  renders the contents. */
  sharedKnowledge?: SharedKnowledge;
}

export function createHarnessMcpServer(
  inputOrJourney: HarnessServerInput | Journey,
  loggerArg?: Logger,
) {
  // Back-compat: old call shape was (journey, logger). New shape is ({journey, logger, getPage, runDir}).
  const input: HarnessServerInput =
    'journey' in inputOrJourney
      ? inputOrJourney
      : { journey: inputOrJourney, logger: loggerArg as Logger };
  const { journey, logger, getPage, runDir, events, findingCache, sharedKnowledge } = input;
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
    name: 'harness',
    version: '1.0.0',
    tools: [
      defTool(
        'report_finding',
        'Report a suspected bug, regression, or unexpected behaviour. Call this whenever you see something weird — human triagers filter. Be specific and concrete. ONE finding per occurrence — never aggregate ("multiple routes have 404s" is wrong; file each route as its own finding). The route field MUST be the specific URL where the issue happened. After filing, KEEP USING THE APP — a finding is never a reason to stop.',
        {
          severity: z
            .enum(['critical', 'major', 'minor', 'cosmetic'])
            .describe(
              'critical=data loss/security. major=feature broken. minor=UX flaw. cosmetic=visual only.',
            ),
          category: z.enum([
            'validation',
            'error-handling',
            'ux-confusion',
            'visual-regression',
            'broken-feature',
            'performance',
            'unexpected-behavior',
            'accessibility',
            'other',
          ]),
          title: z
            .string()
            .min(5)
            .max(200)
            .describe("Short headline. Prefer '[<route>] <what's wrong>'."),
          description: z.string().min(20).describe('Detail that helps a developer reproduce.'),
          stepsToReproduce: z.array(z.string()).min(1),
          expected: z.string(),
          actual: z.string(),
          route: z.string().optional().describe('URL path where you saw it, if known'),
          confidence: z
            .enum(['certain', 'likely', 'maybe-flake'])
            .describe(
              'certain=reproduced. likely=one-shot but real. maybe-flake=possibly environmental.',
            ),
          attach_screenshot: z
            .boolean()
            .optional()
            .describe(
              'If true, the harness captures a viewport screenshot of the current page and attaches it to the finding.',
            ),
          reproduction_actions: z
            .array(
              z.object({
                tool: z.string(),
                args: z.record(z.string(), z.unknown()),
              }),
            )
            .optional()
            .describe(
              'Optional ordered list of tool calls a reviewer/replay can use to reproduce the finding.',
            ),
        },
        async (args) => {
          // Rate limit. Count findings filed by this agent in the last window;
          // if over threshold, return synthetic THROTTLED status and DO NOT
          // record. The reviewer deduplicates aggressively so 30 near-identical
          // findings collapse to one anyway — better to skip the cost up front.
          const cutoff = Date.now() - FINDINGS_RATE_WINDOW_MS;
          const recentCount = journey.findings.filter((f) => Date.parse(f.ts) >= cutoff).length;
          if (recentCount >= FINDINGS_RATE_LIMIT) {
            logger.warn('finding.throttled', {
              agentId: journey.agentId,
              recentCount,
              windowMs: FINDINGS_RATE_WINDOW_MS,
              droppedTitle: args.title,
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `THROTTLED: you've filed ${recentCount} findings in the last ${Math.round(FINDINGS_RATE_WINDOW_MS / 1000)}s. The harness is dropping further reports for now. The post-run reviewer deduplicates aggressively, so the findings already on file cover the same root cause. Stop filing variants of the same bug — switch to a different module/feature. If a NEW kind of bug appears later you may file again once the rate window clears.`,
                },
              ],
            };
          }
          const finding: Finding = {
            id: randomUUID(),
            ts: new Date().toISOString(),
            severity: args.severity,
            category: args.category,
            title: args.title,
            description: args.description,
            stepsToReproduce: args.stepsToReproduce,
            expected: args.expected,
            actual: args.actual,
            route: args.route,
            confidence: args.confidence,
            source: 'agent',
          };
          if (args.reproduction_actions && args.reproduction_actions.length > 0) {
            finding.reproductionActions = args.reproduction_actions;
          }
          if (args.attach_screenshot === true) {
            if (getPage && runDir) {
              try {
                const page = getPage();
                finding.screenshotPath = await captureScreenshot(page, runDir, finding.id);
              } catch (err) {
                logger.warn('finding.screenshot.failed', {
                  agentId: journey.agentId,
                  findingId: finding.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            } else {
              logger.warn('finding.screenshot.unavailable', {
                agentId: journey.agentId,
                findingId: finding.id,
                reason: 'getPage/runDir not provided to harness server',
              });
            }
          }
          journey.findings.push(finding);
          // Register in the cross-agent finding cache so other agents in the
          // same run see this on their next turn and skip rediscovery.
          findingCache?.add(journey.agentId, finding);
          // Emit finding.report event after the finding is recorded.
          await events?.write({
            type: 'finding.report',
            agentId: journey.agentId,
            finding,
          });
          logger.info('finding.reported', {
            agentId: journey.agentId,
            findingId: finding.id,
            severity: args.severity,
            title: args.title,
          });
          return {
            content: [
              {
                type: 'text',
                text: `Finding recorded (id: ${finding.id}). Now KEEP using the app — find another bug.`,
              },
            ],
          };
        },
      ),
      defTool(
        'share_with_team',
        'Share intelligence with the team. Use this whenever you find something OTHER AGENTS could exploit: credentials (from SQLi dumps, exposed configs, FTP files, etc.), authenticated routes you discovered post-login, JWTs/bearer tokens. The supervisor sees these and may broadcast a directive to all agents; every agent\'s next turn renders the team intelligence inline. Distinct from report_finding — a finding is a bug; team intelligence is REUSABLE STATE that helps the next exploration step. Examples: dumped admin password from UNION SQLi, found "/admin/users" route that 200s with admin cookie, found JWT in localStorage post-login.',
        {
          kind: z.enum(['credentials', 'route', 'token']).describe('What you are sharing.'),
          // credentials fields
          username: z.string().optional().describe('Required if kind=credentials.'),
          password: z.string().optional().describe('Required if kind=credentials.'),
          role: z.string().optional().describe('Optional: role/privilege if known (e.g. admin).'),
          // route fields
          url: z
            .string()
            .optional()
            .describe(
              'Required if kind=route. Absolute or origin-relative URL of the discovered route.',
            ),
          last_status: z.number().int().optional().describe('Last HTTP status seen at this URL.'),
          requires_auth: z
            .boolean()
            .optional()
            .describe(
              'True if this route requires authentication (observed redirect to login, or 401/403 without auth).',
            ),
          // token fields
          token_kind: z
            .enum(['jwt', 'bearer', 'cookie', 'other'])
            .optional()
            .describe('Required if kind=token.'),
          token_value: z.string().optional().describe('Required if kind=token.'),
          cookie_name: z.string().optional(),
          // common
          source: z
            .string()
            .min(5)
            .describe(
              'Short phrase describing where you obtained this — e.g. "UNION SQLi /rest/products/search", "ftp/users.json", "post-login localStorage".',
            ),
          note: z
            .string()
            .optional()
            .describe('Optional extra context for the team. Visible in the intelligence block.'),
        },
        async (args) => {
          if (!sharedKnowledge) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'share_with_team is unavailable in this run (no SharedKnowledge instance configured). Skipping.',
                },
              ],
            };
          }
          const ts = new Date().toISOString();
          let summary: string;
          let added = false;
          if (args.kind === 'credentials') {
            if (!args.username || !args.password) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'share_with_team(kind=credentials) requires both username and password. Re-call with both fields.',
                  },
                ],
              };
            }
            added = sharedKnowledge.addCredential({
              username: args.username,
              password: args.password,
              role: args.role,
              source: args.source,
              foundBy: journey.agentId,
              foundAt: ts,
            });
            summary = `credentials ${args.username}:${args.password.slice(0, 2)}*** (role=${args.role ?? 'unknown'})`;
          } else if (args.kind === 'route') {
            if (!args.url) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'share_with_team(kind=route) requires url. Re-call with the discovered route.',
                  },
                ],
              };
            }
            added = sharedKnowledge.addRoute({
              url: args.url,
              lastStatus: args.last_status ?? -1,
              requiresAuth: args.requires_auth ?? false,
              note: args.note ?? '',
              foundBy: journey.agentId,
              foundAt: ts,
            });
            summary = `route ${args.url} (status=${args.last_status ?? '?'}, requiresAuth=${args.requires_auth ?? false})`;
          } else {
            // token
            if (!args.token_kind || !args.token_value) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'share_with_team(kind=token) requires token_kind and token_value. Re-call with both.',
                  },
                ],
              };
            }
            const origin = (() => {
              try {
                if (getPage) return new URL(getPage().url()).origin;
              } catch {}
              return '';
            })();
            added = sharedKnowledge.addToken({
              kind: args.token_kind,
              value: args.token_value,
              cookieName: args.cookie_name,
              origin,
              source: args.source,
              foundBy: journey.agentId,
              foundAt: ts,
            });
            summary = `token kind=${args.token_kind} (length=${args.token_value.length})`;
          }
          // Always emit an event — the durable record. `added=false` means
          // dedup hit; the team already had it.
          await events?.write({
            type: 'team.intel.share',
            agentId: journey.agentId,
            kind: args.kind,
            added,
            summary,
            source: args.source,
          });
          logger.info('team.intel.share', {
            agentId: journey.agentId,
            kind: args.kind,
            added,
            summary,
            source: args.source,
          });
          return {
            content: [
              {
                type: 'text',
                text: added
                  ? `Shared with team: ${summary}. Other agents will see this on their next turn. ${args.kind === 'credentials' ? 'CRITICAL: now call try_login(username, password) to use these credentials yourself before continuing.' : ''}`
                  : `Already known to team: ${summary}. No new entry added.`,
              },
            ],
          };
        },
      ),
      defTool(
        'end_session',
        'HARD-FLOOR ONLY. Call this ONLY if you literally cannot continue. NEVER call this because you "finished exploring", "covered the site", or "ran out of ideas" — those are not reasons to stop. There is always another flow to try, another field to fill, another path to navigate.',
        {
          reason: z
            .enum(['auth_wall', 'site_unreachable', 'browser_dead'])
            .describe(
              'auth_wall=redirected to login, cannot recover. site_unreachable=target host completely down, every navigation fails. browser_dead=cannot interact with the browser at all. NOTHING ELSE qualifies. Server errors / 4xx / 5xx / broken features / missing pages = file a finding and CONTINUE.',
            ),
          detail: z
            .string()
            .min(10)
            .describe(
              'Concrete evidence of the hard-floor condition (URLs, error messages, what you tried).',
            ),
        },
        async (args) => {
          journey.terminationReason = 'end_session';
          journey.endedAt = new Date().toISOString();
          logger.info('session.end', {
            agentId: journey.agentId,
            reason: args.reason,
            detail: args.detail,
          });
          return {
            content: [{ type: 'text', text: `Session ended (reason=${args.reason}).` }],
          };
        },
      ),
    ],
  });

  return { mcpServer, rawTools };
}
