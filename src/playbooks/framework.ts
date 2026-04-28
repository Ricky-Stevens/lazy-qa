/**
 * Playbook framework — runtime registry + MCP tool wrapping. Playbooks
 * implement deterministic Playwright orchestration (form-fill-and-verify,
 * table-pagination, idor-probe). The agent invokes them as MCP tools with
 * persona-supplied inputs.
 */

import type { Page } from 'playwright';
import type { z } from 'zod';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import { withProbeMode } from '../orchestrator/registry.ts';
import type { PageModel } from '../page-model/types.ts';
import type { PlaybookOutcome, PlaybookStep } from './outcome.ts';

export type PlaybookCategory =
  | 'crud'
  | 'form'
  | 'table'
  | 'modal'
  | 'wizard'
  | 'button'
  | 'security'
  | 'chaos'
  | 'search'
  | 'file'
  | 'async'
  | 'discovery';

/** Runtime context available to every playbook. Supplied by the caller (the
 * browser MCP server's handler-builder). */
export interface PlaybookContext {
  page: Page;
  /** Re-extract a fresh PageModel. Cached by the browser server with a TTL,
   * so calling this multiple times within ~2s returns the same model. */
  pageModel: () => Promise<PageModel>;
  siteMap: SiteMapAccessor;
  agentId: string;
  /** Raw persona prose. Most playbooks ignore it; a few (e.g. inputGenerator
   * helpers) may inspect it. */
  persona: string;
  /** Run directory — for screenshot writes etc. */
  runDir: string;
  logger: Logger;
  /** Hosts the agent is permitted to navigate to (post-login allowlist).
   * Empty array = no restriction. Populated from target.allowed_hosts.
   * (WP1.5 scope: this field is the single source of truth for all
   * allowlist-aware playbooks.) */
  allowedHosts: string[];
}

/** A playbook definition. The framework registers these and exposes them as
 * MCP tools to the agent. */
export interface Playbook<I = Record<string, unknown>> {
  name: string;
  /** Shown to the LLM as the MCP tool description. Should describe WHEN to
   * use the playbook and WHAT it expects in inputs. */
  description: string;
  /** Categories. Informational only — agent still picks. */
  categories: PlaybookCategory[];
  /** Estimated wall-clock cost, used for budget enforcement and prioritisation. */
  estimatedDurationMs: number;
  /** Zod shape for inputs. Converted to JSON Schema for the SDK. */
  inputShape: z.ZodRawShape;
  /** When true, runPlaybook wraps execution in `withProbeMode` so any
   *  4xx/5xx generated inside is excluded from the agent's storm-detection
   *  counter. Set on speculative URL-guessing probes (sensitive_path_audit,
   *  idor_probe, route_404_probe) where 4xx/5xx is the *expected* outcome,
   *  not a backend-health signal. */
  speculative?: boolean;
  run: (input: I, ctx: PlaybookContext) => Promise<PlaybookOutcome>;
}

/** Tool definition shape the browser server uses; mirrored from
 * `src/tools/browser-server.ts` so playbooks compile without circular deps. */
export interface RawToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>;
}

/**
 * Run a playbook with timing + error handling. Always returns an outcome —
 * never throws. Captures unhandled exceptions as `failed` outcomes.
 *
 * If the playbook is marked `speculative: true`, execution is wrapped in
 * `withProbeMode` so the per-agent storm counter ignores 4xx/5xx generated
 * inside the playbook. URL-guessing probes always trip 4xx/5xx — that's the
 * point — and shouldn't poison the "is the backend sick?" detector.
 */
export async function runPlaybook<I>(
  pb: Playbook<I>,
  input: I,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  const start = Date.now();
  try {
    const outcome = pb.speculative
      ? await withProbeMode(ctx.agentId, () => pb.run(input, ctx))
      : await pb.run(input, ctx);
    outcome.durationMs = Date.now() - start;
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedStep: PlaybookStep = {
      label: 'playbook crashed',
      ok: false,
      detail: message,
    };
    return {
      playbookName: pb.name,
      status: 'failed',
      summary: `Playbook crashed: ${message}`,
      evidence: { error: message },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [failedStep],
      durationMs: Date.now() - start,
    };
  }
}
