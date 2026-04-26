import { randomUUID } from 'node:crypto';
import { mkdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveApiKey } from '../config/load.ts';
import { dedupeFindings } from '../findings/evaluate.ts';
import {
  persistFindings,
  type RunManifest,
  writeRunManifest,
  writeSummaryMarkdown,
} from '../findings/persist.ts';
import { writeReviewArtefacts } from '../findings/report.ts';
import { reviewRun } from '../findings/review.ts';
import type { Logger } from '../logging/logger.ts';
import { createLogger } from '../logging/logger.ts';
import { assertAllowedTarget, assertHostsTrusted, assertNonProdHost } from '../safety/guards.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { resolveAgents } from './resolve.ts';
import { spawnAgent } from './spawn-agent.ts';
import { runSupervisor } from './supervisor.ts';

export interface RunOptions {
  configPath: string;
  outputDir?: string;
  logger?: Logger;
}

export interface RunResult {
  runId: string;
  runDir: string;
  journeys: Journey[];
  findings: Finding[];
  totalCostUsd: number;
}

export async function runScan(opts: RunOptions): Promise<RunResult> {
  // 1. Load and validate config
  const cfg = await loadConfig(opts.configPath);

  // 2. Safety guards. Order matters: trusted-hosts first (operator must have
  // pre-authorised every host the YAML mentions), then target ∈ allowed_hosts,
  // then a positive non-prod check. Any failure aborts before we touch creds.
  assertHostsTrusted(cfg.target.allowed_hosts);
  assertAllowedTarget(cfg.target.url, cfg.target.allowed_hosts);
  assertNonProdHost(cfg.target.url);

  // 3. Resolve API key and agents. apiKey may be null — the SDK subprocess will
  // then fall back to the local `claude` CLI's cached subscription auth.
  const apiKey = resolveApiKey(cfg);
  const agents = await resolveAgents(cfg);

  // 4. Run ID and output directory
  const runId = randomUUID();
  const outputDir = opts.outputDir ?? cfg.run.output_dir;
  const runDir = path.resolve(outputDir, runId);
  await mkdir(runDir, { recursive: true });

  // 6. Best-effort "last" symlink
  try {
    const lastLink = path.resolve(outputDir, 'last');
    await unlink(lastLink).catch(() => undefined); // ignore if doesn't exist
    await symlink(runId, lastLink);
  } catch {
    // Silently ignore — some filesystems don't support symlinks
  }

  // 7. Logger
  const logger = opts.logger ?? createLogger({ runId });

  // 8. Early pre-run manifest stub (partial, in case of crash)
  await writeRunManifest(runDir, {
    runId,
    startedAt: new Date().toISOString(),
    endedAt: '',
    targetUrl: cfg.target.url,
    agentIds: agents.map((a) => a.id),
    totalCostUsd: 0,
    totalFindings: 0,
    terminationReasons: {},
  });

  logger.info('run.start', {
    runId,
    runDir,
    targetUrl: cfg.target.url,
    agentCount: agents.length,
    auth: apiKey == null ? 'claude-cli-subscription' : 'anthropic-api-key',
  });

  // Subscription-auth pre-flight: make the failure mode visible. If `claude` CLI
  // is not signed in, the SDK subprocess will fail with an opaque error mid-run;
  // this log makes the chain of cause obvious.
  if (apiKey == null) {
    logger.info('auth.subscription.hint', {
      message:
        'No ANTHROPIC_API_KEY set. Using whatever auth `claude` CLI has cached. If agents fail with auth errors, run `claude` interactively once to sign in, or set ANTHROPIC_API_KEY in .env.',
    });
  }

  // 9. SIGINT/SIGTERM handler — shared AbortController piped into every spawnAgent
  const runAbortController = new AbortController();
  let shuttingDown = false;

  function handleSignal(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn('run.signal', { signal, message: 'Graceful shutdown initiated' });
    runAbortController.abort();
  }

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  // 10. Launch all agents in parallel — and the supervisor too, if enabled.
  // The supervisor watches the registry the explorers populate; it intervenes
  // by triggering shared-session re-logins and queuing nudges for stuck
  // agents. It runs concurrently and finishes when all explorers terminate.
  const runStartedAt = new Date().toISOString();

  const supervisorEnabled = cfg.supervisor.enabled && apiKey != null;
  if (cfg.supervisor.enabled && apiKey == null) {
    logger.warn('supervisor.disabled', {
      reason:
        'supervisor.enabled=true but no ANTHROPIC_API_KEY — the supervisor uses the direct Anthropic SDK and cannot run on subscription auth. Set ANTHROPIC_API_KEY in .env to enable.',
    });
  }

  const explorerPromises = agents.map((agent) =>
    spawnAgent({
      runId,
      runDir,
      targetUrl: cfg.target.url,
      allowedHosts: cfg.target.allowed_hosts,
      auth: cfg.target.auth,
      agent,
      apiKey,
      useDirectApi: cfg.anthropic.direct_api && apiKey != null,
      logger,
      abortSignal: runAbortController.signal,
    }),
  );

  const supervisorPromise = supervisorEnabled
    ? runSupervisor({
        // Non-null asserted via supervisorEnabled guard above.
        apiKey: apiKey as string,
        model: cfg.supervisor.model,
        maxMinutes: cfg.supervisor.max_minutes,
        maxUsd: cfg.supervisor.max_usd,
        maxTurns: cfg.supervisor.max_turns,
        abortSignal: runAbortController.signal,
        logger: logger.child({ agentId: 'supervisor' }),
      }).catch((err) => {
        // The supervisor is best-effort — never fail the run if it errors.
        logger.error('supervisor.crashed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
    : Promise.resolve(null);

  const [explorerResults] = await Promise.all([
    Promise.allSettled(explorerPromises),
    supervisorPromise,
  ]);
  const results = explorerResults;

  // 11. Collect journeys; build placeholders for rejected agents
  const journeys: Journey[] = [];
  for (const [i, result] of results.entries()) {
    const agent = agents[i];
    if (!agent) continue; // length matches by construction; defensive
    if (result.status === 'fulfilled') {
      journeys.push(result.value.journey);
    } else {
      logger.error('agent.rejected', {
        agentId: agent.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      // Placeholder journey so we still produce a complete manifest
      journeys.push({
        runId,
        agentId: agent.id,
        startedAt: runStartedAt,
        endedAt: new Date().toISOString(),
        startUrl: cfg.target.url,
        turns: 0,
        findings: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        terminationReason: 'error',
      });
    }
  }

  // 12. Aggregate findings (heuristic findings dropped along with note_step —
  // the agent reports everything explicitly via report_finding now).
  const allFindings = dedupeFindings(journeys.flatMap((j) => j.findings));

  // 13. Persist
  const runEndedAt = new Date().toISOString();
  const totalCostUsd = journeys.reduce((sum, j) => sum + j.costUsd, 0);

  const terminationReasons: Record<string, string> = {};
  for (const j of journeys) {
    terminationReasons[j.agentId] = j.terminationReason ?? 'unknown';
  }

  const manifest: RunManifest = {
    runId,
    startedAt: runStartedAt,
    endedAt: runEndedAt,
    targetUrl: cfg.target.url,
    agentIds: agents.map((a) => a.id),
    totalCostUsd,
    totalFindings: allFindings.length,
    terminationReasons,
  };

  await persistFindings(runDir, allFindings);
  await writeRunManifest(runDir, manifest);
  await writeSummaryMarkdown(runDir, journeys, allFindings);

  // 14. Post-run reviewer. Re-reads the artefacts we just wrote and produces
  // review.md / review.json. Best-effort — a reviewer crash never fails the
  // run; the raw findings are already on disk for manual triage.
  const reviewEnabled = cfg.review.enabled && apiKey != null && allFindings.length > 0;
  if (cfg.review.enabled && apiKey == null) {
    logger.warn('review.disabled', {
      reason:
        'review.enabled=true but no ANTHROPIC_API_KEY — the reviewer uses the direct Anthropic SDK and cannot run on subscription auth.',
    });
  }
  let reviewSummary: {
    confirmedBug: number;
    likelyBug: number;
    duplicate: number;
    environmental: number;
    notABug: number;
    themes: number;
    reviewCostUsd: number;
  } | null = null;
  if (reviewEnabled) {
    try {
      const review = await reviewRun({
        runDir,
        apiKey: apiKey as string,
        model: cfg.review.model,
        logger: logger.child({ tool: 'review' }),
      });
      await writeReviewArtefacts(runDir, review);
      reviewSummary = {
        confirmedBug: review.counts.confirmed_bug,
        likelyBug: review.counts.likely_bug,
        duplicate: review.counts.duplicate,
        environmental: review.counts.environmental,
        notABug: review.counts.not_a_bug,
        themes: review.clusters.length,
        reviewCostUsd: review.reviewCostUsd,
      };
    } catch (err) {
      logger.error('review.crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 15. Run-level budget warning (informational only — can't enforce mid-run in v1)
  if (totalCostUsd > cfg.run.max_budget_usd) {
    logger.warn('run.budget.exceeded', {
      totalCostUsd: totalCostUsd.toFixed(4),
      maxBudgetUsd: cfg.run.max_budget_usd,
      message:
        'Run exceeded the configured max_budget_usd. Consider reducing agent budgets or agent count.',
    });
  }

  logger.info('run.complete', {
    runId,
    runDir,
    totalFindings: allFindings.length,
    totalCostUsd: totalCostUsd.toFixed(4),
    agentCount: journeys.length,
    review: reviewSummary,
  });

  return { runId, runDir, journeys, findings: allFindings, totalCostUsd };
}
