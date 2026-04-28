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
- The HTTP status code from re-navigating to the claimed route
- A PAGE STRUCTURE summary (forms / tables / modals / interactives) — useful only for HTML application pages
- A RESPONSE BODY SAMPLE — the first ~2KB of the literal response (may be HTML, JSON, plaintext, directory listing, raw file content, etc.)

Your job: decide whether the claim still reproduces, given what you see now.

CRITICAL — HOW TO READ THE EVIDENCE:
- For HTTP-shape claims ("returns 500", "returns 200 without auth", "exposes secrets in body", "leaks DB error in title"), the **HTTP status** and **RESPONSE BODY SAMPLE** are authoritative. Trust them over the page-structure summary, which is built for interactive HTML apps and will report \`looksBroken: true / interactiveCount: 0\` for any non-HTML response (JSON endpoints, file dumps, directory listings, plaintext) — that does NOT mean the bug is absent.
- For UI claims ("button does nothing", "form fails to submit", "wrong heading appears"), the page-structure summary is authoritative.
- For text-leakage claims ("SQLite error in page title", "stack trace in body", "JWT in HTML"), grep the BODY SAMPLE for the claimed string. If you see it, the bug reproduces.
- For directory-listing claims, the body sample will contain anchor tags / file names — that IS the listing.
- A 200 response on a route the claim says should be 401/403/404 IS the bug, regardless of what the page looks like. A 500 with a stack trace in the body confirms the claimed crash.

VERDICTS (pick exactly one):
- "confirmed_reproducible" — observable evidence (status, body, structure) is consistent with the claim
- "intermittent" — the claim is plausible but you cannot see the evidence right now (e.g. status looks ok and body is empty); flake suspected but real bug not ruled out
- "not_reproducible" — the live evidence directly contradicts the claim (e.g. claim says "returns 500" but status is 200 and body is healthy; claim says ".env exposed" but status is 404)
- "environmental" — the claim is real but only happens in specific data state we can't reach now
- "different_bug" — there IS a problem here, but it's not the one claimed

Be ruthless about hallucinations (claim says "/.env exposed" but status is 404 → not_reproducible) AND ruthless about not downgrading real bugs (claim says "/swagger.json exposed" and status=200 with JSON body containing API spec → confirmed_reproducible, even though the page-structure summary says \`looksBroken: true\`).

Respond with exactly ONE JSON object, no surrounding prose, no code fences:

{
  "verdict": "confirmed_reproducible" | "intermittent" | "not_reproducible" | "environmental" | "different_bug",
  "detail": "<1-3 sentences justifying the verdict, citing the specific status code, body sample, or structure element you observed>"
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

/** Extract the first absolute http(s) URL from a string. Returns null if no
 *  match. Used to preserve query params from `stepsToReproduce[0]` — the
 *  bare `finding.route` field strips them, which silently kills SQLi /
 *  injection findings in the verifier (the payload IS the query string).
 *
 *  We accept fairly liberal characters in the path/query — most injection
 *  payloads include `'`, `(`, `)`, `;`, `%`-encoded bytes, etc. We stop at
 *  whitespace or a quote that isn't URL-safe. */
function extractUrlFromText(text: string): string | null {
  const match = text.match(/\bhttps?:\/\/[^\s'"`<>]+/);
  return match ? match[0] : null;
}

/** Decide which URL to navigate to during verification.
 *
 *  Preference order:
 *    1. `stepsToReproduce[0]` if it contains an absolute URL — preserves
 *       query string / fragment / encoded-payload that finding.route omits.
 *    2. `finding.route` resolved against rootUrl.
 *    3. rootUrl as fallback.
 *
 *  Why we prefer steps[0] over `route`: the agent records the bare
 *  origin+pathname in `route` (the sitemap key). Injection findings put the
 *  actual exploit payload in the query string, which is captured in the
 *  `stepsToReproduce` text. The previous Juice Shop run lost two real SQLi
 *  findings to this gap — the verifier re-navigated to `/rest/products/search`
 *  with no `?q=` and saw a clean response. */
function deriveTargetUrl(finding: Finding, rootUrl: string): string {
  // 1. Try to recover a fuller URL from the first reproduction step.
  const firstStep = finding.stepsToReproduce?.[0];
  if (firstStep) {
    const stepUrl = extractUrlFromText(firstStep);
    if (stepUrl) {
      const stepUrlNoFragment = stepUrl.split('#')[0] ?? stepUrl;
      const routePathOnly =
        finding.route && !/^https?:/.test(finding.route) ? finding.route.split('?')[0] : null;
      // Sanity: if the step URL's path matches the route's path (or there's
      // no route to compare against), trust it. Otherwise the agent may have
      // pasted a different URL into the steps and we shouldn't follow that.
      try {
        const u = new URL(stepUrl);
        if (!routePathOnly || u.pathname === routePathOnly || stepUrl.includes(routePathOnly)) {
          // Prefer the URL with query params; only strip fragment when route
          // didn't carry one.
          const wantsHash = finding.route?.includes('#') ?? false;
          return wantsHash ? stepUrl : stepUrlNoFragment;
        }
      } catch {
        // bad URL parse — fall through.
      }
    }
  }

  // 2. Fall back to the bare route.
  const r = finding.route;
  if (!r) return rootUrl;
  if (/^https?:/.test(r)) return r;
  try {
    return new URL(r, rootUrl).toString();
  } catch {
    return rootUrl;
  }
}

/** Detect whether the body content is HTML (in which case parsePage's
 *  structured summary is useful) or non-HTML (JSON/text/raw — in which
 *  case the LLM needs to see the raw body to verify). Cheap heuristic on
 *  the first ~512 chars. */
function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 512).toLowerCase().trim();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    (head.includes('<body') && head.includes('<'))
  );
}

const BODY_SAMPLE_BYTES = 2 * 1024;

function summarisePageModel(model: Awaited<ReturnType<typeof parsePage>>): string {
  const lines: string[] = [];
  lines.push(`url: ${model.url}`);
  lines.push(`title: ${model.title || '(empty)'}`);
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

function buildUserMessage(
  finding: Finding,
  pageSummary: string,
  navStatus: number | null,
  bodySample: string | null,
): string {
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
  const statusLine = `HTTP status: ${navStatus ?? 'unknown'}`;
  const bodySection = bodySample
    ? `\n\nRESPONSE BODY SAMPLE (first ${BODY_SAMPLE_BYTES} bytes, may be HTML, JSON, or plain text):\n${bodySample}`
    : '';
  return `BUG CLAIM:\n${claim}\n\nLIVE OBSERVATION (just navigated):\n${statusLine}\n\nPAGE STRUCTURE (parsePage summary — only useful for HTML application pages):\n${pageSummary}${bodySection}\n\nReturn the verdict JSON.`;
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
  let bodySample: string | null = null;
  try {
    const response = await page.goto(navUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });
    navStatus = response?.status() ?? null;
    // Prefer the raw response body — for non-HTML routes (JSON, plaintext,
    // directory listings, raw file dumps) the rendered DOM may be empty or
    // misleading (browsers wrap JSON in <pre>, etc.). The response body is
    // what an attacker / curl user actually sees.
    if (response) {
      try {
        const raw = await response.text();
        bodySample = raw.slice(0, BODY_SAMPLE_BYTES);
        if (raw.length > BODY_SAMPLE_BYTES) {
          bodySample += `\n…[truncated; full body ${raw.length} bytes]`;
        }
      } catch {
        // response.text() may fail on certain navigations (e.g. data URLs);
        // fall back to page.content() so the verifier still has something.
        try {
          const html = await page.content();
          bodySample = html.slice(0, BODY_SAMPLE_BYTES);
          if (html.length > BODY_SAMPLE_BYTES) {
            bodySample += `\n…[truncated; full HTML ${html.length} bytes]`;
          }
        } catch {
          bodySample = null;
        }
      }
    }
  } catch (err) {
    navError = err instanceof Error ? err.message : String(err);
    logger.debug('verify.navError', { findingId: finding.id, url: navUrl, error: navError });
  }

  let pageSummary: string;
  if (navError) {
    pageSummary = `(navigation failed: ${navError})`;
  } else if (bodySample && !looksLikeHtml(bodySample)) {
    // Non-HTML response (JSON, plaintext, file dump). parsePage would just
    // report looksBroken: true with no interactives, which actively misleads
    // the verifier on text-leakage / API-exposure claims. Skip it; the body
    // sample carries the signal.
    pageSummary = '(non-HTML response — see RESPONSE BODY SAMPLE below for evidence)';
  } else {
    try {
      const pageModel = await parsePage(page);
      pageSummary = summarisePageModel(pageModel);
    } catch (err) {
      pageSummary = `(parsePage failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  const userMessage = buildUserMessage(finding, pageSummary, navStatus, bodySample);

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
