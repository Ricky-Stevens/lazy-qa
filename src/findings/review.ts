import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { BrowserContext } from 'playwright';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import { computeCacheSavingsUsd, computeCostUsd } from '../orchestrator/cost.ts';
import type { EventWriter } from '../orchestrator/events.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { type VerifyResult, type VerifyVerdict, verifyFinding } from './verify.ts';

/**
 * Post-run findings reviewer.
 *
 * Re-reads the persisted findings + journey metadata from a run dir, asks a
 * critic LLM to triage each finding against the agent's context, and returns
 * a structured review. The caller (CLI or run.ts) renders this to markdown.
 *
 * Operates only on persisted artefacts so it can be re-run on past runs (no
 * dependency on the live agent state).
 *
 * Single batch LLM call: all findings go in one prompt. The model can spot
 * duplicates and themes that per-finding calls would miss. With Sonnet's
 * context budget this comfortably handles a few hundred findings.
 */

export type ReviewClassification =
  | 'confirmed_bug'
  | 'likely_bug'
  | 'duplicate'
  | 'environmental'
  | 'not_a_bug';

const SEVERITY_ENUM = ['critical', 'major', 'minor', 'cosmetic'] as const;

const ReviewItemSchema = z.object({
  id: z.string().min(1),
  classification: z.enum([
    'confirmed_bug',
    'likely_bug',
    'duplicate',
    'environmental',
    'not_a_bug',
  ]),
  reasoning: z.string().min(1),
  suggestedSeverity: z.enum(SEVERITY_ENUM).optional(),
  duplicateOf: z.string().optional(),
});

const ClusterSchema = z.object({
  label: z.string().min(1),
  findingIds: z.array(z.string()).min(1),
  note: z.string().min(1),
});

const ReviewResponseSchema = z.object({
  reviews: z.array(ReviewItemSchema),
  clusters: z.array(ClusterSchema).default([]),
  overallNotes: z.string().default(''),
});

export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export type ReviewCluster = z.infer<typeof ClusterSchema>;

export interface ReviewResult {
  runId: string;
  reviewedAt: string;
  model: string;
  reviewCostUsd: number;
  reviewTokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** All findings keyed by id, with their review attached. */
  reviews: Array<{
    finding: Finding;
    review: ReviewItem;
    /** Verifier verdict if critic-with-browser ran for this finding. */
    verify?: VerifyResult;
  }>;
  /** Findings without an LLM review (model didn't return one for them). */
  missing: Finding[];
  clusters: ReviewCluster[];
  overallNotes: string;
  /** Convenience counts. */
  counts: Record<ReviewClassification, number>;
  /** Total cost spent on critic-with-browser verifications (0 if disabled). */
  verifyCostUsd: number;
}

/** Patterns recognised by the critic rule-floor. A finding whose route
 *  matches AND whose body/title looks like real exposure cannot be flipped
 *  below `likely_bug` by the critic — verifier still re-checks. Patterns
 *  are intentionally conservative: only paths whose 200 with non-trivial
 *  body is mechanically a real bug regardless of app shape. */
const RULE_FLOOR_PATTERNS: ReadonlyArray<RegExp> = [
  /\/\.git\/HEAD\b/,
  /\/\.git\/config\b/,
  /\/\.env(?:[/?#]|$)/,
  /\/api-docs\b/,
  /\/swagger\.json\b/,
  /\/swagger-ui\b/,
  /\/metrics\b/,
  /\/actuator\/(?:env|heapdump|threaddump|mappings)\b/,
  /\/ftp\/?(?:[?#]|$)/,
];

/** Apply the critic rule-floor. If the finding's route matches a high-signal
 *  pattern AND the agent's report indicates real exposure (mention of 200 /
 *  publicly accessible / etc), refuse classifications below `likely_bug`. */
function applyRuleFloor(finding: Finding, current: ReviewClassification): ReviewClassification {
  if (current === 'confirmed_bug' || current === 'likely_bug') return current;
  const route = finding.route ?? '';
  const matches = RULE_FLOOR_PATTERNS.some((re) => re.test(route));
  if (!matches) return current;
  // Sanity-check against the finding text — agents sometimes file findings
  // that MENTION these paths but aren't about exposure (e.g. "/ftp link in
  // navbar is broken"). We only floor when the report indicates real
  // exposure: status 200 OR explicit "publicly accessible / exposed" prose.
  const hay =
    `${finding.title} ${finding.description} ${finding.actual} ${finding.expected}`.toLowerCase();
  const looksLikeExposure =
    /\b200\b/.test(hay) ||
    /publicly accessible|publicly exposed|exposed without auth|accessible without auth/.test(hay) ||
    /directory listing|stack trace|secret|credential/.test(hay);
  if (!looksLikeExposure) return current;
  return 'likely_bug';
}

/** Apply a verify verdict to a review item. Returns a (possibly new) review
 *  item with classification adjusted per the merge rules. The verifier never
 *  *upgrades* a finding — it only confirms or downgrades — so this is a safe
 *  one-way merge. */
function applyVerifyVerdict(
  review: ReviewItem,
  verdict: VerifyVerdict,
  detail: string,
): ReviewItem {
  const note = `[verifier: ${verdict}] ${detail}`;
  const reasoning = `${review.reasoning}\n\n${note}`;
  switch (verdict) {
    case 'confirmed_reproducible':
      return { ...review, reasoning };
    case 'intermittent':
      // Downgrade confirmed → likely; leave likely as-is.
      return {
        ...review,
        classification:
          review.classification === 'confirmed_bug' ? 'likely_bug' : review.classification,
        reasoning,
      };
    case 'not_reproducible':
      return { ...review, classification: 'not_a_bug', reasoning };
    case 'environmental':
      return { ...review, classification: 'environmental', reasoning };
    case 'different_bug':
      // Keep at likely_bug — there's something here, but it's not the claimed bug.
      return { ...review, classification: 'likely_bug', reasoning };
  }
}

/** Run verifications in parallel with a concurrency cap, returning a map of
 *  findingId → VerifyResult. Errors per-finding are absorbed into a fallback
 *  "intermittent" verdict; verification never throws back to reviewRun. */
async function runVerifications(
  candidates: Array<{ finding: Finding; review: ReviewItem }>,
  ctx: VerifyContext,
  apiKey: string,
  logger: Logger,
  events: EventWriter | undefined,
): Promise<Map<string, VerifyResult>> {
  const results = new Map<string, VerifyResult>();
  if (candidates.length === 0) return results;
  const concurrency = Math.max(1, Math.floor(ctx.concurrency ?? 3));
  const client = new Anthropic({ apiKey });
  const queue = [...candidates];
  const inFlight = new Set<Promise<void>>();

  const runOne = async (cand: { finding: Finding; review: ReviewItem }): Promise<void> => {
    const tab = await ctx.context.newPage();
    try {
      const result = await verifyFinding({
        finding: cand.finding,
        page: tab,
        rootUrl: ctx.rootUrl,
        allowedHosts: ctx.allowedHosts,
        client,
        model: ctx.model,
        logger,
        events,
      });
      results.set(cand.finding.id, result);
    } catch (err) {
      logger.warn('verify.unhandled', {
        findingId: cand.finding.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to intermittent so a verifier crash doesn't accidentally
      // clear a real finding.
      results.set(cand.finding.id, {
        findingId: cand.finding.id,
        verdict: 'intermittent',
        detail: `verifier crashed: ${err instanceof Error ? err.message : String(err)}`,
        costUsd: 0,
      });
    } finally {
      try {
        await tab.close();
      } catch {
        // Tab may already be closed if context tore down — ignore.
      }
    }
  };

  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0 && inFlight.size < concurrency) {
      const cand = queue.shift();
      if (!cand) break;
      const p = runOne(cand).finally(() => {
        inFlight.delete(p);
      });
      inFlight.add(p);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  return results;
}

/** Optional verify-with-browser context. When provided, every finding the
 *  triager classifies as `confirmed_bug` or `likely_bug` is re-checked against
 *  the live app: a fresh tab navigates to the route, parses a PageModel, and
 *  the verifier LLM renders a verdict. Verdicts merge back into the review
 *  result, downgrading findings the live page contradicts. */
export interface VerifyContext {
  context: BrowserContext;
  rootUrl: string;
  allowedHosts: string[];
  model: string;
  /** Concurrency cap for parallel verifications. Default 3. */
  concurrency?: number;
}

export interface ReviewInput {
  runDir: string;
  apiKey: string;
  model?: string;
  /** Controls dispatch mode. Defaults to 'auto'. */
  batchMode?: 'auto' | 'inline' | 'force_batch';
  logger: Logger;
  /**
   * Event writer for this run. Optional — the review CLI may run standalone
   * without an active writer. All emit calls silently no-op when undefined.
   */
  events?: EventWriter;
  /** When provided, enable critic-with-browser verification of confirmed/
   *  likely findings. Skipped entirely if undefined (e.g. the standalone
   *  review CLI without an authenticated browser session). */
  verify?: VerifyContext;
}

const SYSTEM_PROMPT = `You are a senior QA triager reviewing automated regression-scan findings.

You will receive a JSON payload describing a run: agent journeys (who explored what) and findings (suspected bugs filed by autonomous AI agents driving a real web app).

Your job: classify each finding so a human triager can spend minutes, not hours, deciding what to fix.

Classification rules:
- confirmed_bug: concrete evidence in the description (URL, error code, console message, repro steps), and behaviour clearly violates a reasonable user expectation
- likely_bug: plausible bug but evidence is thin, or repro is fuzzy. A human should take a quick look
- duplicate: same root cause as an earlier finding (set duplicateOf to that finding's id). One representative finding stays as confirmed_bug or likely_bug; the rest become duplicate
- environmental: flake, network blip, dev-server quirk, unrelated to the SUT (e.g. blocked by browser extension, CDN error, dev-only banner)
- not_a_bug: agent misread the UI, or behaviour described is correct/intentional (e.g. confirmation dialogs, 401 on an unauthenticated endpoint)

Severity audit: when the agent's severity feels wrong (a 'critical' that's really a UX nit, or a 'minor' that's actually data loss), set suggestedSeverity. Leave it out when the original is fine.

Clusters: group findings by underlying theme (e.g. "All routes returning 404 after auth recovery", "Pages crashing with React #418", "Silent 4xx with no UI feedback"). Aim for 0-5 clusters covering the substantive findings; do not cluster for the sake of it.

overallNotes: 2-4 sentences describing the run's overall health and standout themes. No filler.

CRITICAL: respond with ONE JSON object only, no surrounding prose, no code fences. Schema:

{
  "reviews": [{
    "id": "<finding-id>",
    "classification": "confirmed_bug" | "likely_bug" | "duplicate" | "environmental" | "not_a_bug",
    "reasoning": "<1-3 sentences>",
    "suggestedSeverity": "critical" | "major" | "minor" | "cosmetic" (omit if no change),
    "duplicateOf": "<finding-id>" (only when classification=duplicate)
  }],
  "clusters": [{
    "label": "<short theme name>",
    "findingIds": ["<id>", ...],
    "note": "<1-2 sentences>"
  }],
  "overallNotes": "<2-4 sentences>"
}

Every finding in the input MUST appear in reviews exactly once.`;

async function loadFindings(runDir: string): Promise<Finding[]> {
  const findingsPath = path.join(runDir, 'findings.json');
  const raw = await readFile(findingsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${findingsPath} to be an array; got ${typeof parsed}`);
  }
  return parsed as Finding[];
}

async function loadJourneys(runDir: string): Promise<Journey[]> {
  const journeysDir = path.join(runDir, 'journeys');
  const { readdir } = await import('node:fs/promises');
  let names: string[] = [];
  try {
    names = await readdir(journeysDir);
  } catch {
    return [];
  }
  const journeys: Journey[] = [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      const raw = await readFile(path.join(journeysDir, name), 'utf8');
      journeys.push(JSON.parse(raw));
    } catch {
      // Skip unreadable files; reviewer is best-effort.
    }
  }
  return journeys;
}

/** Build the user-message payload for the reviewer LLM. Compact JSON keeps tokens down. */
function buildReviewPayload(findings: Finding[], journeys: Journey[]): string {
  const compactJourneys = journeys.map((j) => ({
    agentId: j.agentId,
    turns: j.turns,
    findingsCount: j.findings.length,
    terminationReason: j.terminationReason,
    durationSec:
      j.endedAt && j.startedAt
        ? Math.round((Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000)
        : null,
  }));
  const compactFindings = findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    category: f.category,
    title: f.title,
    description: f.description,
    expected: f.expected,
    actual: f.actual,
    route: f.route,
    confidence: f.confidence,
    stepsToReproduce: f.stepsToReproduce,
  }));
  return JSON.stringify({ journeys: compactJourneys, findings: compactFindings });
}

function extractJsonObject(text: string): unknown {
  // The prompt asks for raw JSON; tolerate code fences just in case.
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  const body = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;
  return JSON.parse(body);
}

/** Inline (synchronous) path — single messages.create call. */
async function runCriticInline(
  client: Anthropic,
  model: string,
  payload: string,
): Promise<Anthropic.Message> {
  return client.messages.create({
    model,
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Cache the system prompt for 1h — the SYSTEM_PROMPT is static across
        // all review calls in a session, so this is safe and cuts per-call cost.
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: payload }],
  });
}

/** Batch API path — submits a 1-request batch, polls until done, returns the message. */
async function runCriticBatch(
  client: Anthropic,
  model: string,
  payload: string,
  logger: Logger,
): Promise<Anthropic.Message> {
  const batch = await client.messages.batches.create({
    requests: [
      {
        custom_id: 'critic',
        params: {
          model,
          max_tokens: 8192,
          system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
          messages: [{ role: 'user', content: payload }],
        },
      },
    ],
  });
  logger.info('review.batch.submitted', { batchId: batch.id });

  const startedAt = Date.now();
  const TIMEOUT_MS = 6 * 60 * 60 * 1000;
  let pollIntervalMs = 30_000;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const status = await client.messages.batches.retrieve(batch.id);
    logger.debug('review.batch.poll', { batchId: batch.id, status: status.processing_status });
    if (status.processing_status === 'ended') {
      const results = client.messages.batches.results(batch.id);
      for await (const result of await results) {
        if (result.custom_id === 'critic') {
          if (result.result.type === 'succeeded') {
            return result.result.message;
          }
          throw new Error(`Critic batch failed: ${JSON.stringify(result.result)}`);
        }
      }
      throw new Error('Critic batch ended but no result returned');
    }
    pollIntervalMs = Math.min(pollIntervalMs * 1.5, 5 * 60 * 1000);
  }
  throw new Error(`Critic batch timed out after ${TIMEOUT_MS / 60_000}min`);
}

export async function reviewRun(input: ReviewInput): Promise<ReviewResult> {
  const { runDir, apiKey, logger, events } = input;
  const model = input.model ?? 'claude-sonnet-4-6';
  const batchMode = input.batchMode ?? 'auto';

  const [findings, journeys] = await Promise.all([loadFindings(runDir), loadJourneys(runDir)]);

  if (findings.length === 0) {
    logger.info('review.skip', { reason: 'no findings' });
    return {
      runId: journeys[0]?.runId ?? path.basename(runDir),
      reviewedAt: new Date().toISOString(),
      model,
      reviewCostUsd: 0,
      reviewTokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reviews: [],
      missing: [],
      clusters: [],
      overallNotes: 'No findings to review.',
      counts: {
        confirmed_bug: 0,
        likely_bug: 0,
        duplicate: 0,
        environmental: 0,
        not_a_bug: 0,
      },
      verifyCostUsd: 0,
    };
  }

  const payload = buildReviewPayload(findings, journeys);
  logger.info('review.start', {
    runDir,
    findings: findings.length,
    journeys: journeys.length,
    model,
    payloadChars: payload.length,
  });

  // Emit critic.start before the API call.
  await events?.write({
    type: 'critic.start',
    findingCount: findings.length,
    model,
  });

  const reviewStartedAt = Date.now();
  const client = new Anthropic({ apiKey });

  const inputCharsApprox = payload.length;
  const useBatch =
    batchMode === 'force_batch' || (batchMode === 'auto' && inputCharsApprox > 16_000);
  const response = useBatch
    ? await runCriticBatch(client, model, payload, logger)
    : await runCriticInline(client, model, payload);

  // Aggregate token usage and cost for telemetry.
  const usage = response.usage;
  const tokenUsage = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
  let costUsd = 0;
  try {
    costUsd = computeCostUsd(model, tokenUsage);
  } catch {
    // Unknown model price — ignore; reviewer still works.
  }

  const savedUsd = computeCacheSavingsUsd(model, tokenUsage.cacheRead);
  logger.info('review.cache.savings', {
    cacheReadTokens: tokenUsage.cacheRead,
    cacheWriteTokens: tokenUsage.cacheWrite,
    savedUsd,
    ratioOfInput: tokenUsage.input > 0 ? tokenUsage.cacheRead / tokenUsage.input : 0,
  });

  // Pull the assistant's first text block. The prompt instructs JSON-only.
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`Reviewer returned no text content (stop_reason=${response.stop_reason})`);
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = extractJsonObject(textBlock.text);
  } catch (err) {
    throw new Error(
      `Reviewer returned non-JSON: ${err instanceof Error ? err.message : String(err)}\n\n--- raw output (first 500 chars) ---\n${textBlock.text.slice(0, 500)}`,
    );
  }

  const parsed = ReviewResponseSchema.parse(parsedRaw);

  // Stitch reviews back to the original findings, by id.
  const findingsById = new Map(findings.map((f) => [f.id, f]));
  const reviewsById = new Map(parsed.reviews.map((r) => [r.id, r]));
  const reviews: Array<{ finding: Finding; review: ReviewItem; verify?: VerifyResult }> = [];
  const missing: Finding[] = [];
  for (const f of findings) {
    const r = reviewsById.get(f.id);
    if (r) {
      reviews.push({ finding: f, review: r });
      // Emit critic.verdict per finding.
      await events?.write({
        type: 'critic.verdict',
        findingId: f.id,
        verdict: r.classification,
      });
    } else {
      missing.push(f);
    }
  }

  // Validate duplicateOf references — drop ones that point at unknown ids
  // rather than producing a confusing report.
  for (const entry of reviews) {
    if (entry.review.duplicateOf && !findingsById.has(entry.review.duplicateOf)) {
      entry.review.duplicateOf = undefined;
    }
  }

  // Critic rule-floor — protect deterministically-real findings from critic
  // variance. Across runs we've seen `/metrics`, `/api-docs`, `/.git/HEAD`,
  // `/ftp/` etc. flip between `confirmed_bug` and `not_a_bug` on identical
  // evidence. The critic's job is interpretation; for a small set of routes
  // the answer is mechanical (200 with non-shell body = exposure). This step
  // floors those to at least `likely_bug` so the verifier still re-checks
  // them but they can't be silently dropped.
  for (const entry of reviews) {
    const flooredVerdict = applyRuleFloor(entry.finding, entry.review.classification);
    if (flooredVerdict !== entry.review.classification) {
      logger.info('review.rulefloor.applied', {
        findingId: entry.finding.id,
        from: entry.review.classification,
        to: flooredVerdict,
        route: entry.finding.route,
      });
      entry.review.classification = flooredVerdict;
      entry.review.reasoning = `[rule-floor] ${entry.review.reasoning ?? ''}`;
    }
  }

  // Critic-with-browser verification, if a verify context was provided.
  let verifyCostUsd = 0;
  if (input.verify) {
    const candidates = reviews.filter(
      (r) =>
        r.review.classification === 'confirmed_bug' || r.review.classification === 'likely_bug',
    );
    if (candidates.length > 0) {
      logger.info('verify.start', {
        candidates: candidates.length,
        concurrency: input.verify.concurrency ?? 3,
      });
      const verifyResults = await runVerifications(
        candidates,
        input.verify,
        apiKey,
        logger,
        events,
      );
      for (const entry of reviews) {
        const v = verifyResults.get(entry.finding.id);
        if (!v) continue;
        entry.review = applyVerifyVerdict(entry.review, v.verdict, v.detail);
        entry.verify = v;
        verifyCostUsd += v.costUsd;
      }
      logger.info('verify.complete', {
        verified: verifyResults.size,
        costUsd: verifyCostUsd.toFixed(4),
      });
    }
  }

  const counts: Record<ReviewClassification, number> = {
    confirmed_bug: 0,
    likely_bug: 0,
    duplicate: 0,
    environmental: 0,
    not_a_bug: 0,
  };
  for (const entry of reviews) counts[entry.review.classification] += 1;

  // Drop cluster IDs that don't exist (model occasionally invents).
  const clusters = parsed.clusters
    .map((c) => ({ ...c, findingIds: c.findingIds.filter((id) => findingsById.has(id)) }))
    .filter((c) => c.findingIds.length > 0);

  logger.info('review.complete', {
    findings: findings.length,
    reviewed: reviews.length,
    missing: missing.length,
    counts,
    clusters: clusters.length,
    costUsd: costUsd.toFixed(4),
  });

  // Emit critic.end with final cost and duration.
  await events?.write({
    type: 'critic.end',
    totalCostUsd: costUsd,
    durationMs: Date.now() - reviewStartedAt,
  });

  return {
    runId: journeys[0]?.runId ?? path.basename(runDir),
    reviewedAt: new Date().toISOString(),
    model,
    reviewCostUsd: costUsd,
    reviewTokenUsage: tokenUsage,
    reviews,
    missing,
    clusters,
    overallNotes: parsed.overallNotes,
    counts,
    verifyCostUsd,
  };
}
