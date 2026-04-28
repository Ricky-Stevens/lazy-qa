import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import type { EventWriter } from '../orchestrator/events.ts';
import type { FindingCache } from '../orchestrator/finding-cache.ts';
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
  const { journey, logger, getPage, runDir, events, findingCache } = input;
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
