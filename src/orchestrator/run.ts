/**
 * Orchestrator entry point for the regression harness.
 *
 * Orchestrates the full scan lifecycle: config → safety → crawler → agents →
 * findings review. The crawler builds a shared `SiteMap` that every agent
 * consumes via `SiteMapAccessor`. After all agents finish, writes a
 * `coverage.md` aggregating sitemap stats and per-agent playbook outcomes.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireSession } from '../auth/session-pool.ts';
import { loadConfig, resolveApiKey } from '../config/load.ts';
import { crawlSite } from '../crawler/crawl.ts';
import { extractLinks } from '../crawler/extract-links.ts';
import { SiteMapImpl } from '../crawler/sitemap.ts';
import type { SiteMap } from '../crawler/types.ts';
import { type PlaybookOutcomeRecord, writeCoverageReport } from '../findings/coverage.ts';
import { dedupeFindings } from '../findings/evaluate.ts';
import {
  persistFindings,
  type RunManifest,
  writeRunManifest,
  writeSummaryMarkdown,
} from '../findings/persist.ts';
import { writeReviewArtefacts } from '../findings/report.ts';
import { reviewRun } from '../findings/review.ts';
import { selectBackend } from '../llm/factory.ts';
import type { Logger } from '../logging/logger.ts';
import { createLogger } from '../logging/logger.ts';
import { assertAllowedTarget, assertHostsTrusted, assertNonProdHost } from '../safety/guards.ts';
import { loadSkills } from '../skills/loader.ts';
import { ATTACKER_PROFILES } from '../tools/browser-server.ts';
import { SelectorCache } from '../tools/selector-cache.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { runAuthAgent } from './auth-agent.ts';
import { EventWriter, formatEventLine } from './events.ts';
import { FindingCache } from './finding-cache.ts';
import { resolveMemoryPath } from './memory.ts';
import { resolveAgents } from './resolve.ts';
import { SharedKnowledge } from './shared-knowledge.ts';
import { generateSitePlaybook, type SitePlaybookResult } from './site-playbook.ts';
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
  siteMap: SiteMap;
}

/** Crawler defaults. Mirrors spec §7.1 — the user can override via plugin
 *  configuration once `regress.config.ts` lands. */
const CRAWL_MAX_DEPTH = 2;
const CRAWL_MAX_ROUTES = 60;
const CRAWL_MAX_WALL_CLOCK_MS = 30_000;

export async function runScan(opts: RunOptions): Promise<RunResult> {
  // 1. Config + safety guards. Order matters: trusted-hosts first, then
  // target ∈ allowed_hosts, then a positive non-prod check. Any failure
  // aborts before we touch creds.
  const cfg = await loadConfig(opts.configPath);
  assertHostsTrusted(cfg.target.allowed_hosts);
  assertAllowedTarget(cfg.target.url, cfg.target.allowed_hosts);
  assertNonProdHost(cfg.target.url);

  // 2. Resolve auth. ANTHROPIC_API_KEY is required when LLM_AUTH=api (the default);
  // optional when LLM_AUTH=subscription (the SDK falls back to the local
  // `claude` CLI's cached OAuth token). selectBackend throws a useful error if
  // we're in api mode without a key.
  const apiKey = resolveApiKey(cfg);
  const llmAuth = process.env.LLM_AUTH;

  // Build one shared backend for all LLM calls in this run (review,
  // site-playbook, supervisor, auth-agent). The persona loop is dispatched
  // separately based on backend.kind — see runScan body below.
  const backend = selectBackend({ apiKey: apiKey ?? undefined, llmAuth });

  // Load the skills bundle once here — both resolveAgents (personas) and
  // spawnAgent (playbook tools) consume it.
  const skillsBundle = await loadSkills();
  const agents = await resolveAgents(cfg, skillsBundle);

  // 3. Run ID + output directory.
  const runId = randomUUID();
  const outputDir = opts.outputDir ?? cfg.run.output_dir;
  const runDir = path.resolve(outputDir, runId);
  await mkdir(runDir, { recursive: true });

  // 3a. Event writer — append-only JSONL for the full run trace. Optionally
  // teed to stderr in human-readable form when LOG_FORMAT=pretty (or when
  // stdout is a TTY). Tap writes to stderr so JSON consumers piping stdout
  // see only the JSON log.
  const eventsPath = path.join(runDir, 'events.jsonl');
  const events = new EventWriter(eventsPath, runId);
  await events.open();
  const wantPretty =
    process.env.LOG_FORMAT === 'pretty' ||
    (process.env.LOG_FORMAT !== 'json' && process.stdout.isTTY === true);
  if (wantPretty) {
    events.consoleTap = (e) => {
      const line = formatEventLine(e);
      if (line) process.stderr.write(`${line}\n`);
    };
  }

  // 5. Logger — hoisted above the try so the finally block can use it.
  const logger = opts.logger ?? createLogger({ runId });

  // Outer-scope accumulators so the run.end/close finally block sees whatever
  // was computed before any throw — partial state is better than no state.
  let aggregateFindings: Finding[] = [];
  let aggregateCostUsd = 0;
  const aggregateTerminationReasons: Record<string, string> = {};
  // Hoisted so the finally block can flush the cache regardless of where in
  // the try body control flow exits.
  let selectorCache: SelectorCache | undefined;

  try {
    // 4. Best-effort `last` symlink so `runs/last` always points at the most
    // recent run for ad-hoc inspection.
    try {
      const lastLink = path.resolve(outputDir, 'last');
      await unlink(lastLink).catch(() => undefined);
      await symlink(runId, lastLink);
    } catch {
      // Some filesystems (FAT, certain Windows paths) don't support symlinks —
      // silently degrade.
    }

    // 6. Early pre-run manifest stub — useful when the run crashes before
    // completing.
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
      auth: backend.kind === 'sdk' ? 'claude-subscription' : 'anthropic-api-key',
      version: 'v2',
    });

    // Emit run.start event — before any agents or crawl so it's always first.
    await events.write({
      type: 'run.start',
      targetUrl: cfg.target.url,
      agentIds: agents.map((a) => a.id),
    });

    // 7. Shared abort controller — SIGINT/SIGTERM aborts every agent + the
    // supervisor + the in-flight crawler at once.
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

    const firstAgent = agents[0];
    if (!firstAgent) {
      throw new Error('runScan: no agents resolved from config');
    }

    // 7a. AI-driven authentication phase. Replaces the brittle CSS-selector
    // form-fill — a small Haiku agent reads the page, dismisses banners,
    // fills the form, and verifies success. On success the captured
    // storageState is written to runs/<runId>/auth-state.json; the crawler
    // and every agent session below loads it and inherits the auth.
    let sessionInfo: { username: string; role?: string } | undefined;
    if (cfg.target.auth.type === 'form' && firstAgent.credentials) {
      const authStatePath = path.join(runDir, 'auth-state.json');
      const authResult = await runAuthAgent({
        targetUrl: cfg.target.url,
        loginUrl: cfg.target.auth.login_url,
        credentials: firstAgent.credentials,
        allowedHosts: cfg.target.allowed_hosts,
        backend,
        // Haiku is plenty for login-form filling and is the cheap path.
        model: 'claude-haiku-4-5-20251001',
        storageStatePath: authStatePath,
        logger: logger.child({ phase: 'auth-agent' }),
        events,
        stealth: cfg.target.stealth,
        abortSignal: runAbortController.signal,
      });
      if (!authResult.ok) {
        // Non-fatal: log and continue. Agents will still try to log in via
        // their own session-pool path (which falls back to selector form-fill
        // if auth-state.json is absent).
        logger.warn('auth-agent.unsuccessful', {
          detail: authResult.detail,
          turns: authResult.turns,
          costUsd: authResult.costUsd.toFixed(4),
        });
      } else {
        sessionInfo = authResult.sessionInfo;
      }
    }

    // 8. Pre-run crawl. Open a temporary tab on the shared session — first
    // call here triggers login (or loads auth-state.json), every subsequent
    // agent's acquireSession() shares the same authed context. Persist the
    // sitemap to disk before spawning agents so the run is debuggable from
    // the moment crawling finishes.

    const crawlerLogger = logger.child({ phase: 'crawl' });
    let siteMap: SiteMapImpl;
    let crawledMap: SiteMap;
    const crawlStartedAt = Date.now();
    let crawlerSession: Awaited<ReturnType<typeof acquireSession>> | null = null;
    try {
      crawlerSession = await acquireSession({
        targetUrl: cfg.target.url,
        auth: cfg.target.auth,
        allowedHosts: cfg.target.allowed_hosts,
        credentials: firstAgent.credentials,
        runDir,
        agentId: 'crawler',
        logger: crawlerLogger,
        stealth: cfg.target.stealth,
      });
      crawledMap = await crawlSite(crawlerSession.page, {
        maxDepth: CRAWL_MAX_DEPTH,
        maxRoutes: CRAWL_MAX_ROUTES,
        maxWallClockMs: CRAWL_MAX_WALL_CLOCK_MS,
        allowedHosts: cfg.target.allowed_hosts,
        linkExtractor: extractLinks,
        logger: crawlerLogger,
        parallelism: cfg.crawler.parallelism,
        events,
      });
    } catch (err) {
      crawlerLogger.error('crawl.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Build an empty sitemap so agents still run; coverage will show 0
      // crawler-discovered routes, which is itself a useful signal.
      crawledMap = {
        startedAt: new Date(crawlStartedAt).toISOString(),
        rootUrl: cfg.target.url,
        routes: {},
        pageModels: {},
      };
    } finally {
      if (crawlerSession) {
        await crawlerSession.release().catch((closeErr) => {
          crawlerLogger.warn('crawl.session.release.failed', {
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        });
      }
    }

    // Persist the crawler output before agents start. Agents will mutate the
    // live in-memory map (recordVisit / recordPlaybookOutcome / on-demand
    // expansion), but having the pristine pre-run snapshot on disk means we
    // can diff after the run to see what agents discovered.
    await writeFile(path.join(runDir, 'sitemap.json'), JSON.stringify(crawledMap, null, 2), 'utf8');

    logger.info('crawl.done', {
      routes: Object.keys(crawledMap.routes).length,
      durationMs: Date.now() - crawlStartedAt,
    });

    // Build the live, mutable accessor agents will share. Hydrate it from the
    // pristine crawler output.
    siteMap = new SiteMapImpl({
      rootUrl: crawledMap.rootUrl,
      startedAt: crawledMap.startedAt,
      allowedHosts: cfg.target.allowed_hosts,
    });
    for (const route of Object.values(crawledMap.routes)) {
      const model = crawledMap.pageModels[route.route];
      if (!model) continue;
      siteMap.upsertRoute(route, model);
    }

    // 8a. Site-playbook generation. Sonnet reads the crawler's sitemap and
    // produces a per-persona concrete plan ("on /#/foo click X then go to
    // /#/bar"). This separates persona character (who you are) from
    // site-specific intent (what to do here), which fixes the regression
    // where personas navigated without ever completing a flow.
    //
    // Best-effort: failure is non-fatal. Agents fall back to persona-only
    // prompts. The result is persisted to runs/<runId>/site-playbook.json
    // so the operator can inspect what was generated, but the run does NOT
    // wait for human approval — it proceeds immediately.
    let sitePlaybook: SitePlaybookResult | null = null;
    try {
      // Site-playbook is for HONEST personas only. The attacker has its own
      // OWASP-driven methodology in its persona body and should be free to
      // attack whatever it likes — not constrained to the visible site shape.
      // Filtering here also saves Sonnet output tokens (no attacker brief
      // generated that we'd then discard).
      const personaBriefs = Array.from(
        new Map(
          agents
            .filter((a) => !ATTACKER_PROFILES.has(a.profileName))
            .map((a) => {
              const persona = skillsBundle.personas.get(a.profileName);
              return [a.profileName, persona?.description ?? a.profileName];
            }),
        ).entries(),
      ).map(([name, description]) => ({ name, description }));

      sitePlaybook = await generateSitePlaybook({
        rootUrl: cfg.target.url,
        sitemap: crawledMap,
        personas: personaBriefs,
        backend,
        model: 'claude-sonnet-4-6',
        logger: logger.child({ phase: 'site-playbook' }),
        events,
        abortSignal: runAbortController.signal,
      });

      await writeFile(
        path.join(runDir, 'site-playbook.json'),
        JSON.stringify(sitePlaybook, null, 2),
        'utf8',
      );
    } catch (err) {
      // Non-fatal — log and continue without a playbook.
      logger.warn('site-playbook.crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 9. Resolve and initialise the per-target memory directory. Created once
    // before any agents spawn so concurrent agents share the same path.
    const memoryEnabled = cfg.memory.enabled;
    const memoryPath = resolveMemoryPath(cfg.target.url, cfg.memory.path);
    if (memoryEnabled) {
      await mkdir(memoryPath, { recursive: true });
    }

    // 9a. Selector cache — load once per run (per-target file). Shared across
    // all agents in the run; each agent receives the same instance so cache
    // hits on one agent immediately benefit others in the same run.
    const selectorCacheEnabled = cfg.selector_cache.enabled;
    if (selectorCacheEnabled) {
      selectorCache = await SelectorCache.load(cfg.target.url);
    }

    // 9b. Cross-agent finding cache. In-process only (per-run). Every agent
    // shares this instance so each turn's user message includes findings
    // already filed by others. Stops the duplicate-rediscovery waste that
    // dominated the previous Juice Shop run (10 of 18 findings were dupes).
    const findingCache = new FindingCache();

    // 9c. Shared cross-agent intelligence. Credentials dumped via SQLi,
    // routes discovered post-login, JWTs scraped from page state — anything
    // an agent thinks the team should know goes here. Every agent's per-turn
    // user message renders the contents; the supervisor reads it via
    // list_agents and broadcasts directives ("creds available, log in NOW").
    // Try_login also writes here on successful login (auto-marks the
    // credential as verified).
    const sharedKnowledge = new SharedKnowledge();

    // 10. Launch agents in parallel, but stagger the spawn fan-out. Each
    // spawnAgent() spins up an SDK query() which spawns a heavyweight
    // claude SEA child and a bidirectional MCP transport with 30+ tool
    // registrations. Firing all of them at the same instant produced a
    // multi-GB allocation spike in the parent that pushed V8 over its
    // default ~4 GB old-space cap (the harness runs under bun normally,
    // but the headroom is still finite). A 2 s delay between spawns lets
    // each one reach steady state before the next allocates its transport
    // — the agents still run concurrently after start. The supervisor
    // continues to launch right alongside them.
    const runStartedAt = new Date().toISOString();

    const supervisorEnabled = cfg.supervisor.enabled;
    const SPAWN_STAGGER_MS = 2_000;
    const explorerPromises: ReturnType<typeof spawnAgent>[] = [];
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      if (!agent) continue;
      explorerPromises.push(
        spawnAgent({
          runId,
          runDir,
          targetUrl: cfg.target.url,
          allowedHosts: cfg.target.allowed_hosts,
          auth: cfg.target.auth,
          agent,
          backend,
          siteMap,
          logger,
          abortSignal: runAbortController.signal,
          stealth: cfg.target.stealth,
          memoryEnabled,
          memoryPath,
          skillsBundle,
          events,
          selectorCache,
          findingCache,
          sharedKnowledge,
          sessionInfo,
          sitePlaybookText: sitePlaybook?.perPersona[agent.profileName],
          siteSummary: sitePlaybook?.siteSummary,
          siteShape: sitePlaybook?.siteShape,
        }),
      );
      if (i < agents.length - 1) {
        await new Promise((r) => setTimeout(r, SPAWN_STAGGER_MS));
      }
    }

    const supervisorPromise = supervisorEnabled
      ? runSupervisor({
          backend,
          model: cfg.supervisor.model,
          maxMinutes: cfg.supervisor.max_minutes,
          maxUsd: cfg.supervisor.max_usd,
          maxTurns: cfg.supervisor.max_turns,
          abortSignal: runAbortController.signal,
          logger: logger.child({ agentId: 'supervisor' }),
          events,
          authType: cfg.target.auth.type,
          sharedKnowledge,
        }).catch((err) => {
          // Supervisor is best-effort — never fail the run if it errors.
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

    // 10. Collect journeys; build placeholders for rejected agents so the
    // manifest is always complete.
    const journeys: Journey[] = [];
    for (const [i, result] of explorerResults.entries()) {
      const agent = agents[i];
      if (!agent) continue;
      if (result.status === 'fulfilled') {
        journeys.push(result.value.journey);
      } else {
        logger.error('agent.rejected', {
          agentId: agent.id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
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

    // 11. Aggregate findings.
    const allFindings = dedupeFindings(journeys.flatMap((j) => j.findings));
    aggregateFindings = allFindings;

    // 12. Persist run manifest, findings, summary.
    const runEndedAt = new Date().toISOString();
    const totalCostUsd = journeys.reduce((sum, j) => sum + j.costUsd, 0);
    aggregateCostUsd = totalCostUsd;
    const terminationReasons: Record<string, string> = {};
    for (const j of journeys) {
      terminationReasons[j.agentId] = j.terminationReason ?? 'unknown';
      aggregateTerminationReasons[j.agentId] = j.terminationReason ?? 'unknown';
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

    // 13. Coverage report. Reads playbook.outcome events from the run's
    // events.jsonl trace — every runPlaybook call emits one.
    try {
      const playbookOutcomes = await collectPlaybookOutcomesFromEvents(eventsPath);
      const primitiveActivity = await collectPrimitiveActivityFromEvents(eventsPath);
      await writeCoverageReport(runDir, {
        runId,
        siteMap: siteMap.serialize(),
        journeys,
        playbookOutcomes,
        primitiveActivity,
      });
    } catch (err) {
      logger.error('coverage.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 14. Post-run reviewer. Re-reads the artefacts we just wrote and produces
    // review.md / review.json. Best-effort — a reviewer crash never fails the
    // run; the raw findings are already on disk for manual triage.
    const reviewEnabled = cfg.review.enabled && allFindings.length > 0;
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
      // Acquire a verifier session if critic-with-browser verification is on.
      // We re-use the session pool's de-duplication: this will share the
      // browser/context with any agent session still alive, otherwise it
      // performs a fresh login. Released in a finally block below.
      let verifySession: Awaited<ReturnType<typeof acquireSession>> | null = null;
      if (cfg.review.verify_with_browser) {
        try {
          // Reuse the first resolved agent's credentials (they were already
          // env-resolved upstream). The session pool de-duplicates against
          // existing sessions for the same target+credentials.
          const firstResolved = agents[0];
          if (firstResolved) {
            verifySession = await acquireSession({
              targetUrl: cfg.target.url,
              auth: cfg.target.auth,
              allowedHosts: cfg.target.allowed_hosts,
              credentials: firstResolved.credentials,
              runDir,
              agentId: 'verifier',
              logger: logger.child({ tool: 'verify' }),
              stealth: cfg.target.stealth,
            });
          }
        } catch (err) {
          logger.warn('verify.session.acquire.failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through — review proceeds without verification.
        }
      }

      try {
        const review = await reviewRun({
          runDir,
          backend,
          model: cfg.review.model,
          batchMode: cfg.review.batch_mode,
          logger: logger.child({ tool: 'review' }),
          events,
          ...(verifySession
            ? {
                verify: {
                  context: verifySession.context,
                  rootUrl: cfg.target.url,
                  allowedHosts: cfg.target.allowed_hosts,
                  model: cfg.review.verify_model ?? cfg.review.model,
                  concurrency: cfg.review.verify_concurrency,
                },
              }
            : {}),
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
      } finally {
        if (verifySession) {
          try {
            await verifySession.release();
          } catch (err) {
            logger.warn('verify.session.release.failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // 15. Run-level budget warning (informational only — can't enforce mid-run).
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

    return {
      runId,
      runDir,
      journeys,
      findings: allFindings,
      totalCostUsd,
      siteMap: siteMap.serialize(),
    };
  } finally {
    // Emit run.end and close the writer. Best-effort — a failure here must not
    // mask the run result. Runs that throw mid-execution still get a terminal
    // event with whatever was accumulated before the throw.
    try {
      await events.write({
        type: 'run.end',
        totalCostUsd: aggregateCostUsd,
        terminationReasons: aggregateTerminationReasons,
        totalFindings: aggregateFindings.length,
      });
      await events.close();
    } catch (err) {
      logger.error('events.close.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Flush selector cache — best-effort. The 2s debounce will have persisted
    // most entries during the run; this final close() catches the last batch.
    if (selectorCache) {
      try {
        await selectorCache.close();
      } catch (err) {
        logger.error('selector-cache.close.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** Read the run's events.jsonl and reconstruct PlaybookOutcomeRecords from
 *  every `playbook.outcome` event. Source of truth for "which playbooks did
 *  the agents actually execute?" — used by the coverage builder. */
async function collectPlaybookOutcomesFromEvents(
  eventsPath: string,
): Promise<PlaybookOutcomeRecord[]> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf8');
  } catch {
    return [];
  }
  const out: PlaybookOutcomeRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'playbook.outcome') continue;
    const status = e.status as string;
    // Coverage records only tally ok/failed/suspicious; 'skipped' isn't
    // tracked because it's not a real attempt.
    if (status !== 'ok' && status !== 'failed' && status !== 'suspicious') continue;
    out.push({
      agentId: String(e.agentId ?? ''),
      playbookName: String(e.playbookName ?? ''),
      // `playbook.outcome` events don't carry route/targetId yet; coverage's
      // overall "Playbooks executed" tally and per-agent depth still work
      // without them, but per-target percentages will read 0%. That's fine
      // for now — the bare execution count is the regression we're fixing.
      route: '',
      targetId: null,
      status,
    });
  }
  return out;
}

/** Read events.jsonl and tally per-agent primitive tool calls. Used to drive
 *  the "Primitive interactions" section of the coverage report — the playbook-
 *  only stats hide what honest personas actually did with click/fill_form/etc. */
async function collectPrimitiveActivityFromEvents(eventsPath: string): Promise<
  Array<{
    agentId: string;
    fillForm: number;
    click: number;
    type: number;
    navigate: number;
    reportFinding: number;
  }>
> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf8');
  } catch {
    return [];
  }
  const map = new Map<
    string,
    { fillForm: number; click: number; type: number; navigate: number; reportFinding: number }
  >();
  function bucket(agentId: string) {
    let b = map.get(agentId);
    if (!b) {
      b = { fillForm: 0, click: 0, type: 0, navigate: 0, reportFinding: 0 };
      map.set(agentId, b);
    }
    return b;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'tool.call') continue;
    const agentId = String(e.agentId ?? '');
    if (!agentId) continue;
    const name = String(e.name ?? '');
    if (name === 'fill_form') bucket(agentId).fillForm += 1;
    else if (name === 'click' || name === 'find_and_click') bucket(agentId).click += 1;
    else if (name === 'type') bucket(agentId).type += 1;
    else if (name === 'navigate') bucket(agentId).navigate += 1;
    else if (name === 'report_finding' || name === 'mcp__harness__report_finding')
      bucket(agentId).reportFinding += 1;
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([agentId, counts]) => ({ agentId, ...counts }));
}
