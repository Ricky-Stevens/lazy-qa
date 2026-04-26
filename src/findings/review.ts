import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import { computeCostUsd } from '../orchestrator/cost.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';

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
  reviews: Array<{ finding: Finding; review: ReviewItem }>;
  /** Findings without an LLM review (model didn't return one for them). */
  missing: Finding[];
  clusters: ReviewCluster[];
  overallNotes: string;
  /** Convenience counts. */
  counts: Record<ReviewClassification, number>;
}

export interface ReviewInput {
  runDir: string;
  apiKey: string;
  model?: string;
  logger: Logger;
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

export async function reviewRun(input: ReviewInput): Promise<ReviewResult> {
  const { runDir, apiKey, logger } = input;
  const model = input.model ?? 'claude-sonnet-4-6';

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

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: payload }],
  });

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
  const reviews: Array<{ finding: Finding; review: ReviewItem }> = [];
  const missing: Finding[] = [];
  for (const f of findings) {
    const r = reviewsById.get(f.id);
    if (r) reviews.push({ finding: f, review: r });
    else missing.push(f);
  }

  // Validate duplicateOf references — drop ones that point at unknown ids
  // rather than producing a confusing report.
  for (const entry of reviews) {
    if (entry.review.duplicateOf && !findingsById.has(entry.review.duplicateOf)) {
      entry.review.duplicateOf = undefined;
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
  };
}
