/**
 * Site-playbook generator. Runs ONCE after the auth-agent + crawler complete,
 * before persona agents spawn. Sends the crawler's sitemap to Sonnet and asks
 * it to:
 *   1. Identify what kind of site this is (e-commerce, admin/CRUD, content, etc.)
 *   2. For each persona, produce a concrete plan referencing actual routes —
 *      "click X on /#/foo, then go to /#/bar and submit Y" — instead of generic
 *      "explore the page" advice.
 *
 * Why: across runs, the functional personas (power-user, chaos-clicker,
 * completionist) found zero real-flow bugs because they navigated without
 * knowing which flows the site actually supports. Hardcoding e-commerce hints
 * in the persona prompts overfits to Juice Shop. The site-playbook layer
 * separates WHO (persona character) from WHAT (site-specific flows).
 *
 * Output is persisted to runs/<runId>/site-playbook.json for post-run
 * inspection. There is NO human-approval gate — agents proceed immediately
 * after generation. Failure is non-fatal: agents fall back to persona-only
 * prompts.
 *
 * Cost: ~$0.04-0.10 once per run (~3K input + ~2K output tokens on Sonnet).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SiteMap } from '../crawler/types.ts';
import type { LlmBackend } from '../llm/backend.ts';
import type { Logger } from '../logging/logger.ts';
import { computeCostUsd } from './cost.ts';
import type { EventWriter } from './events.ts';

export interface SitePlaybookInput {
  /** Root URL of the target. Used as orientation for the model. */
  rootUrl: string;
  /** Pristine post-crawl sitemap. Routes and pageModels both consumed. */
  sitemap: SiteMap;
  /** Personas to brief, in agent-spawn order. Each has a name (= profileName,
   *  used as the dict key on the way back) and a one-line description that
   *  helps Sonnet tailor the per-persona plan. */
  personas: Array<{ name: string; description: string }>;
  backend: LlmBackend;
  /** Sonnet — site analysis is reasoning-shaped, not mechanical. Hardcoded
   *  to claude-sonnet-4-6 by default in run.ts. */
  model: string;
  /** Cap on output tokens. 4 personas × ~200 words × ~3 tokens/word ≈ 2400
   *  tokens, plus the JSON envelope; 4096 is comfortable. */
  maxOutputTokens?: number;
  logger: Logger;
  events?: EventWriter;
  /** When true, the LLM also recommends which personas to spawn (auto mode).
   *  The roster is returned in `recommendedRoster`. */
  autoMode?: boolean;
  /** Currently silently ignored by the LLM call — `LlmCallInput` does not yet
   *  surface aborts. Kept on the interface so callers compile; remove or wire
   *  through once the backend abstraction supports cancellation. */
  abortSignal?: AbortSignal;
}

export interface RosterRecommendation {
  persona: string;
  priority: number;
  reason: string;
}

export interface SitePlaybookResult {
  ok: boolean;
  /** Short tag — e-commerce / admin-crud / content / social / api-gateway /
   *  marketing / mixed / unknown. Stored on the run for post-mortem. */
  siteShape: string;
  /** Plain-English 2-3 sentence description of the site. */
  siteSummary: string;
  /** Persona name → multi-line concrete plan (referencing actual routes).
   *  Empty record on failure. */
  perPersona: Record<string, string>;
  costUsd: number;
  /** Failure reason if ok=false. */
  detail?: string;
  /** Agent roster recommendation (auto mode only). */
  recommendedRoster?: RosterRecommendation[];
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Compact line-per-route summary fed to Sonnet. Keeps the input tight while
 *  preserving enough signal (interactive count, form/table presence, page
 *  title) for shape detection and route-grade plans. */
function summariseSitemap(sitemap: SiteMap): string {
  const lines: string[] = [];
  const routes = Object.values(sitemap.routes);
  for (const r of routes) {
    const pm = sitemap.pageModels[r.route];
    const title = (pm?.title || r.title || '(no title)').slice(0, 60);
    const parts = [
      `forms=${pm?.forms.length ?? 0}`,
      `tables=${pm?.tables.length ?? 0}`,
      `modals=${pm?.modals.length ?? 0}`,
      `navLinks=${pm?.navLinks.length ?? 0}`,
      `interactive=${pm?.interactiveCount ?? 0}`,
      `status=${r.status ?? '?'}`,
    ];
    lines.push(`- ${r.url}  "${title}"  [${parts.join(', ')}]`);
  }
  return lines.join('\n');
}

/** Top-N representative interactive labels, drawn from bareInteractives plus
 *  form names plus table names. Helps Sonnet say "click Add to Basket on …"
 *  without us having to flatten every page. */
function representativeAffordances(sitemap: SiteMap, max = 40): string {
  const out: string[] = [];
  for (const r of Object.values(sitemap.routes)) {
    const pm = sitemap.pageModels[r.route];
    if (!pm) continue;
    const labels: string[] = [];
    for (const f of pm.forms) labels.push(`form "${f.name ?? f.id}"`);
    for (const t of pm.tables) labels.push(`table "${t.name ?? t.id}"`);
    for (const bi of pm.bareInteractives.slice(0, 8)) {
      if (bi.label && bi.label.length < 40) labels.push(`"${bi.label}"`);
    }
    if (labels.length === 0) continue;
    out.push(`  ${r.url} → ${labels.slice(0, 6).join(', ')}`);
    if (out.length >= max) break;
  }
  return out.join('\n');
}

function buildSystemPrompt(
  rootUrl: string,
  personas: SitePlaybookInput['personas'],
  autoMode: boolean,
): string {
  const personaList = personas.map((p) => `  - ${p.name}: ${p.description}`).join('\n');

  const schemaLines = [
    'OUTPUT — a single JSON object, no prose before or after. Schema:',
    '{',
    '  "siteShape": "ecommerce" | "admin-crud" | "content" | "social" | "api-gateway" | "marketing" | "mixed" | "unknown",',
    '  "siteSummary": "2-3 sentences in plain English describing what this app is and what users do here.",',
    '  "perPersona": {',
    '    "<persona-name>": "100-200 words. CONCRETE flow tailored to THIS site. Reference actual route URLs from the sitemap. Use bullets if you like."',
    '  }',
  ];

  if (autoMode) {
    schemaLines.push(
      '  "recommendedRoster": [',
      '    { "persona": "<persona-name>", "priority": 1, "reason": "one sentence why this persona has work here" }',
      '  ]',
    );
  }
  schemaLines.push('}');

  const rules = [
    "- Reference real route URLs verbatim (e.g. `/#/basket`, `/#/order-history`). Don't invent paths that aren't in the sitemap.",
    '- If a flow does not apply (e.g. checkout on a content site), do NOT fabricate it. Tell the persona what to do instead.',
    '- Each plan must give the persona at least one HIGH-VALUE concrete action sequence (e.g. "Search → click product → Add to Basket → /#/basket → Checkout"). The persona will follow it, not interpret it.',
    "- The attacker's plan should suggest attack vectors implied by the visible surface (search forms → injection, admin panels → IDOR/privilege, JWT tokens → role manipulation, file routes → path traversal). Stay within the configured target — never propose off-host probes.",
    '- 100-200 words per persona. Concrete is better than long.',
    '- Output JSON only. No markdown fences. No commentary.',
  ];

  if (autoMode) {
    rules.push(
      '',
      'ROSTER SELECTION (recommendedRoster):',
      '- Only include personas that have meaningful work on THIS site. If there are no tables, skip table-focused personas. If there are no forms, skip form-focused personas.',
      '- priority: 1 = must-have (critical coverage gap without), 2 = high-value (significant testing surface), 3 = nice-to-have (some value but could be skipped under budget pressure).',
      '- You MUST include a perPersona entry for every persona you recommend in the roster.',
      '- Do NOT recommend a persona unless you can write a concrete 100+ word plan for it.',
    );
  }

  return [
    'You are analysing a web application sitemap to brief other AI agents on what to do here.',
    `The target is ${rootUrl}. Agents start ALREADY AUTHENTICATED — they inherit a logged-in session.`,
    '',
    autoMode
      ? 'Your job: (1) describe the site, (2) recommend which personas to spawn, and (3) give each recommended persona a concrete, route-grade plan.'
      : 'Your job: produce a JSON object describing the site and giving each persona a concrete, route-grade plan.',
    '',
    autoMode ? 'Available personas (recommend only those with work to do):' : 'Personas to brief:',
    personaList,
    '',
    ...schemaLines,
    '',
    'RULES:',
    ...rules,
  ].join('\n');
}

function buildUserPrompt(rootUrl: string, sitemap: SiteMap): string {
  const summary = summariseSitemap(sitemap);
  const affordances = representativeAffordances(sitemap);
  return [
    `Root URL: ${rootUrl}`,
    `Routes discovered: ${Object.keys(sitemap.routes).length}`,
    '',
    'Sitemap (one route per line, with interactive density):',
    summary,
    '',
    'Representative affordances (form/table names + bare interactive labels):',
    affordances || '(none extracted)',
    '',
    'Produce the JSON now.',
  ].join('\n');
}

/** Robust JSON extraction from the model's response. Sonnet usually obeys the
 *  "no markdown fences" rule but we tolerate them anyway — strip the fences
 *  and any leading/trailing whitespace before parsing. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip a markdown fence if present (```json ... ``` or ``` ... ```).
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fence?.[1] ?? trimmed;
  return JSON.parse(candidate);
}

function validateAndNormalise(
  raw: unknown,
  personas: SitePlaybookInput['personas'],
  autoMode: boolean,
): {
  siteShape: string;
  siteSummary: string;
  perPersona: Record<string, string>;
  recommendedRoster?: RosterRecommendation[];
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const siteShape = typeof obj.siteShape === 'string' ? obj.siteShape : 'unknown';
  const siteSummary =
    typeof obj.siteSummary === 'string' && obj.siteSummary.length > 0
      ? obj.siteSummary
      : '(no summary)';
  const rawPerPersona = (obj.perPersona ?? {}) as Record<string, unknown>;
  const perPersona: Record<string, string> = {};
  const personaNames = new Set(personas.map((p) => p.name));
  for (const p of personas) {
    const v = rawPerPersona[p.name];
    if (typeof v === 'string' && v.trim().length > 0) {
      perPersona[p.name] = v.trim();
    }
  }

  let recommendedRoster: RosterRecommendation[] | undefined;
  if (autoMode && Array.isArray(obj.recommendedRoster)) {
    recommendedRoster = [];
    for (const entry of obj.recommendedRoster) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const persona = typeof e.persona === 'string' ? e.persona : '';
      if (!personaNames.has(persona)) continue;
      const priority = typeof e.priority === 'number' ? e.priority : 2;
      const reason = typeof e.reason === 'string' ? e.reason : '';
      recommendedRoster.push({ persona, priority, reason });
    }
  }

  return { siteShape, siteSummary, perPersona, recommendedRoster };
}

export async function generateSitePlaybook(input: SitePlaybookInput): Promise<SitePlaybookResult> {
  const { rootUrl, sitemap, personas, backend, model, logger, events } = input;
  const startedAt = Date.now();

  logger.info('site-playbook.start', {
    rootUrl,
    routeCount: Object.keys(sitemap.routes).length,
    personaCount: personas.length,
    model,
  });
  await events?.write({
    type: 'site-playbook.start',
    rootUrl,
    routeCount: Object.keys(sitemap.routes).length,
    personas: personas.map((p) => p.name),
    model,
  });

  if (personas.length === 0) {
    return {
      ok: false,
      siteShape: 'unknown',
      siteSummary: '',
      perPersona: {},
      costUsd: 0,
      detail: 'no personas to brief',
    };
  }
  if (Object.keys(sitemap.routes).length === 0) {
    logger.warn('site-playbook.skip.empty-sitemap', {});
    await events?.write({
      type: 'site-playbook.complete',
      ok: false,
      siteShape: 'unknown',
      personas: [],
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      detail: 'sitemap was empty',
    });
    return {
      ok: false,
      siteShape: 'unknown',
      siteSummary: '',
      perPersona: {},
      costUsd: 0,
      detail: 'sitemap was empty — crawler likely failed',
    };
  }

  const autoMode = input.autoMode ?? false;
  // Auto mode outputs the roster recommendation + more personas → more tokens.
  const maxOutput = input.maxOutputTokens ?? (autoMode ? 6144 : DEFAULT_MAX_OUTPUT_TOKENS);
  const systemPrompt = buildSystemPrompt(rootUrl, personas, autoMode);
  const userPrompt = buildUserPrompt(rootUrl, sitemap);

  let costUsd = 0;
  try {
    const response = await backend.call({
      model,
      maxTokens: maxOutput,
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [],
      cacheSystem: true,
    });

    costUsd = computeCostUsd(model, {
      input: response.usage.inputTokens,
      output: response.usage.outputTokens,
      cacheRead: response.usage.cacheReadTokens,
      cacheWrite: response.usage.cacheWriteTokens,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw new Error(
        `JSON parse failed: ${err instanceof Error ? err.message : String(err)}. Body: ${text.slice(0, 300)}`,
      );
    }

    const { siteShape, siteSummary, perPersona, recommendedRoster } = validateAndNormalise(
      parsed,
      personas,
      autoMode,
    );
    const missing = personas.map((p) => p.name).filter((n) => !(n in perPersona));

    logger.info('site-playbook.complete', {
      siteShape,
      personasOk: Object.keys(perPersona),
      missingPersonas: missing,
      costUsd: costUsd.toFixed(4),
      durationMs: Date.now() - startedAt,
    });
    await events?.write({
      type: 'site-playbook.complete',
      ok: true,
      siteShape,
      personas: Object.keys(perPersona),
      costUsd,
      durationMs: Date.now() - startedAt,
    });

    return {
      ok: missing.length === 0,
      siteShape,
      siteSummary,
      perPersona,
      costUsd,
      detail: missing.length > 0 ? `missing personas: ${missing.join(', ')}` : undefined,
      recommendedRoster,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('site-playbook.failed', { detail, costUsd: costUsd.toFixed(4) });
    await events?.write({
      type: 'site-playbook.complete',
      ok: false,
      siteShape: 'unknown',
      personas: [],
      costUsd,
      durationMs: Date.now() - startedAt,
      detail,
    });
    return {
      ok: false,
      siteShape: 'unknown',
      siteSummary: '',
      perPersona: {},
      costUsd,
      detail,
    };
  }
}
