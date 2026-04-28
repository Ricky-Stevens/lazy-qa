/**
 * Critic-with-browser (Agent-as-a-Judge) — verifies a single finding by
 * driving a real browser tab and asking the LLM to render a verdict against
 * what it observed.
 *
 * Pragmatic shape (vs the "full agent loop" sketched in the plan):
 *
 *   1. Navigate to `finding.route`
 *   2. Capture an `ax_snapshot`-like page summary via `parsePage`
 *   3. Send the finding + page summary + recent network/console anomalies to
 *      the LLM with the locked verifier system prompt
 *   4. Parse the verdict
 *
 * Single LLM call per finding, no multi-turn tool use. Trade-off: a real
 * 2-turn agent loop would let the verifier perform reproduction steps the
 * agent claims trigger the bug. The single-call form catches the cleaner
 * cases — pages that no longer 4xx, claims that don't match the live page —
 * which empirically dominate trace-only false positives. Multi-turn can be
 * layered on later without changing this module's public types.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import { computeCostUsd } from '../orchestrator/cost.ts';
import type { EventWriter } from '../orchestrator/events.ts';
import { parsePage } from '../page-model/parser.ts';
import type { Finding } from '../types/finding.ts';

export type VerifyVerdict =
  | 'confirmed_reproducible'
  | 'intermittent'
  | 'not_reproducible'
  | 'environmental'
  | 'different_bug';

export interface VerifyResult {
  findingId: string;
  verdict: VerifyVerdict;
  detail: string;
  costUsd: number;
}

export interface VerifyInput {
  finding: Finding;
  /** A pre-authenticated tab the verifier may navigate. Caller owns the tab
   * (open/close/cleanup); the verifier never closes it. */
  page: Page;
  /** Origin/host root used as a fallback when finding.route is relative. */
  rootUrl: string;
  /** Allowed-host filter. Passed in so the verifier doesn't re-derive policy. */
  allowedHosts: string[];
  /** Anthropic SDK client. Injected for testability — tests pass a mock. */
  client: Pick<Anthropic, 'messages'>;
  model: string;
  logger: Logger;
  events?: EventWriter;
}

const VERIFIER_SYSTEM_PROMPT = `You are a senior QA engineer verifying a single bug claim against a live web app.

You receive:
- The bug claim (title, route, expected, actual, evidence, repro steps the agent recorded)
- A live PageModel snapshot of the claimed route, captured just now
- Any network anomalies / console errors observed during navigation

Your job: decide whether the claim still reproduces, given what you see now.

VERDICTS (pick exactly one):
- "confirmed_reproducible" — observable evidence on this page is consistent with the claim (matching error UI, broken state, missing affordance, etc.)
- "intermittent" — the claim is plausible but the live page looks fine; flake suspected but real bug not ruled out
- "not_reproducible" — the live page does not show what the claim describes; the agent likely hallucinated or misread the UI
- "environmental" — the claim is real but only happens in specific data state we can't reach now (e.g. claim says "fails when there are 0 rows" and we're seeing a populated table)
- "different_bug" — there IS a problem on this page, but it's not the one claimed

Be ruthless. False positives in the report are the #1 trust issue. If the live page contradicts the claim, mark "not_reproducible". If you literally cannot tell from the snapshot, prefer "intermittent" over "confirmed_reproducible".

Respond with exactly ONE JSON object, no surrounding prose, no code fences:

{
  "verdict": "confirmed_reproducible" | "intermittent" | "not_reproducible" | "environmental" | "different_bug",
  "detail": "<1-3 sentences justifying the verdict, citing what you saw>"
}`;

const VerifyResponseSchema = z.object({
  verdict: z.enum([
    'confirmed_reproducible',
    'intermittent',
    'not_reproducible',
    'environmental',
    'different_bug',
  ]),
  detail: z.string().min(1),
});

function deriveTargetUrl(finding: Finding, rootUrl: string): string {
  const r = finding.route;
  if (!r) return rootUrl;
  if (/^https?:/.test(r)) return r;
  try {
    return new URL(r, rootUrl).toString();
  } catch {
    return rootUrl;
  }
}

function summarisePageModel(model: Awaited<ReturnType<typeof parsePage>>): string {
  const lines: string[] = [];
  lines.push(`url: ${model.url}`);
  lines.push(`title: ${model.title}`);
  if (model.primaryHeading) lines.push(`heading: ${model.primaryHeading}`);
  lines.push(`looksBroken: ${model.looksBroken}`);
  lines.push(`interactiveCount: ${model.interactiveCount}`);
  if (model.forms.length > 0) {
    lines.push(`forms: ${model.forms.map((f) => f.name).join(', ')}`);
  }
  if (model.tables.length > 0) {
    lines.push(`tables: ${model.tables.map((t) => `${t.name}(${t.rowCount} rows)`).join(', ')}`);
  }
  if (model.modals.length > 0) {
    lines.push(`modals: ${model.modals.map((m) => m.name).join(', ')}`);
  }
  if (model.console.length > 0) {
    const errs = model.console
      .filter((c) => c.level === 'error' || c.level === 'pageerror')
      .map((c) => c.text)
      .slice(0, 5);
    if (errs.length > 0) lines.push(`consoleErrors: ${errs.join(' | ')}`);
  }
  if (model.network.length > 0) {
    const anomalies = model.network
      .filter((n) => n.status >= 400)
      .map((n) => `${n.method} ${n.url} → ${n.status}`)
      .slice(0, 5);
    if (anomalies.length > 0) lines.push(`networkAnomalies: ${anomalies.join(' | ')}`);
  }
  return lines.join('\n');
}

function buildUserMessage(finding: Finding, pageSummary: string, navStatus: number | null): string {
  const claim = JSON.stringify(
    {
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      route: finding.route ?? '(no route recorded)',
      expected: finding.expected,
      actual: finding.actual,
      stepsToReproduce: finding.stepsToReproduce,
      description: finding.description,
    },
    null,
    2,
  );
  return `BUG CLAIM:\n${claim}\n\nLIVE PAGE OBSERVATION (just navigated, status ${navStatus ?? 'unknown'}):\n${pageSummary}\n\nReturn the verdict JSON.`;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // Try direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to extraction by braces.
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('no JSON object found in response');
  }
  return JSON.parse(trimmed.slice(first, last + 1));
}

/**
 * Run the verifier for a single finding. Caller is responsible for emitting
 * critic.verify.start / critic.verify.end events around this call so timing
 * brackets accurately.
 */
export async function verifyFinding(input: VerifyInput): Promise<VerifyResult> {
  const { finding, page, rootUrl, client, model, logger, events } = input;

  await events?.write({
    type: 'critic.verify.start',
    findingId: finding.id,
    model,
  });

  const navUrl = deriveTargetUrl(finding, rootUrl);
  let navStatus: number | null = null;
  let navError: string | undefined;
  try {
    const response = await page.goto(navUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });
    navStatus = response?.status() ?? null;
  } catch (err) {
    navError = err instanceof Error ? err.message : String(err);
    logger.debug('verify.navError', { findingId: finding.id, url: navUrl, error: navError });
  }

  let pageSummary: string;
  if (navError) {
    pageSummary = `(navigation failed: ${navError})`;
  } else {
    try {
      const model = await parsePage(page);
      pageSummary = summarisePageModel(model);
    } catch (err) {
      pageSummary = `(parsePage failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  const userMessage = buildUserMessage(finding, pageSummary, navStatus);

  let verdict: VerifyVerdict = 'intermittent';
  let detail = '';
  let costUsd = 0;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system: VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const usage = response.usage;
    try {
      costUsd = computeCostUsd(model, {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
      });
    } catch {
      // Unknown model — leave costUsd at 0 rather than fail verification.
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error(`verifier returned no text content (stop_reason=${response.stop_reason})`);
    }
    const parsed = VerifyResponseSchema.parse(extractJsonObject(textBlock.text));
    verdict = parsed.verdict;
    detail = parsed.detail;
  } catch (err) {
    // On verifier failure, fall back to "intermittent" — neither confirming
    // nor rejecting the finding. Surface the error in detail so a human
    // triager can investigate why verification couldn't run.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('verify.failed', { findingId: finding.id, error: msg });
    detail = `verifier error: ${msg}`;
    verdict = 'intermittent';
  }

  await events?.write({
    type: 'critic.verify.end',
    findingId: finding.id,
    verdict,
    costUsd,
  });

  return {
    findingId: finding.id,
    verdict,
    detail,
    costUsd,
  };
}
