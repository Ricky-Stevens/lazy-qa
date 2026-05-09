/**
 * Application Model — Phase 0 understanding.
 *
 * After crawl, one Sonnet call analyses sample pages to build a structured
 * understanding of what "normal" looks like for this application. This context
 * is injected into every agent's system prompt, preventing entire categories
 * of false positives (Auth0 400s, server-side sort, expected empty states).
 */

import type { SiteMap } from '../crawler/types.ts';
import type { LlmBackend } from '../llm/backend.ts';
import type { Logger } from '../logging/logger.ts';
import { serializeForAgent } from '../page-model/serialize.ts';
import { computeCostUsd } from './cost.ts';

export interface ApplicationModel {
  appType: string;
  errorPatterns: string[];
  successPatterns: string[];
  emptyStates: string[];
  sortBehavior: string;
  authProvider: string;
  navigationStructure: string;
  knownPatterns: string[];
}

const SYSTEM_PROMPT = `You are analysing a web application to understand its UI patterns and expected behaviour. You will receive serialised page snapshots from a crawl. Your output will be injected into QA/security testing agents' system prompts so they can distinguish normal behaviour from bugs.

Return ONE JSON object with this schema:
{
  "appType": "short description — e.g. 'data analytics portal', 'e-commerce store', 'SaaS admin panel'",
  "errorPatterns": ["how the app shows errors — e.g. 'red toast notification at top right', 'inline error text below fields'"],
  "successPatterns": ["how the app shows success — e.g. 'green toast notification', 'redirects to list page'"],
  "emptyStates": ["what empty/no-data states look like — e.g. ''No data available' with illustration', ''No results found' text'"],
  "sortBehavior": "how tables sort — 'client-side (rows visually reorder)' or 'server-side (column header updates but rows may not visually reorder on small datasets)' or 'unknown'",
  "authProvider": "if you see an external auth provider (Auth0, Okta, Cognito, Azure AD), name it and note that its login URL returns 400 when accessed directly — this is expected OAuth/OIDC behaviour, NOT a bug. 'none detected' if no external provider.",
  "navigationStructure": "describe the nav layout — e.g. 'left sidebar with 12 items in 3 groups: Data, Administration, Settings'",
  "knownPatterns": ["any other patterns that a tester should treat as NORMAL — e.g. 'all tables have an unnamed first column that is a row-select checkbox', 'the /api/extension/version endpoint always returns 500 — this appears to be a background health check, not a user-facing error'"]
}

Be specific and concrete. Every pattern you describe prevents a false positive. If you're unsure about a pattern, include it with a qualifier like 'appears to'.`;

export async function buildApplicationModel(opts: {
  sitemap: SiteMap;
  siteShape: string;
  siteSummary: string;
  backend: LlmBackend;
  model: string;
  logger: Logger;
}): Promise<{ model: ApplicationModel; costUsd: number }> {
  const { sitemap, backend, model, logger } = opts;

  const routes = Object.values(sitemap.routes);
  const routesWithModels = routes.filter((r) => sitemap.pageModels[r.route]);

  const sampleSize = Math.min(10, routesWithModels.length);
  const step = Math.max(1, Math.floor(routesWithModels.length / sampleSize));
  const sampleRoutes = routesWithModels.filter((_, i) => i % step === 0).slice(0, sampleSize);

  const pageSnapshots = sampleRoutes
    .map((r) => {
      const pageModel = sitemap.pageModels[r.route];
      if (!pageModel) return null;
      return `--- Page: ${r.route} (${r.title || 'untitled'}) ---\n${serializeForAgent(pageModel)}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const userMessage = `Site classification: ${opts.siteShape} — ${opts.siteSummary}

Routes discovered: ${routes.length}
Sample page snapshots (${sampleRoutes.length} of ${routes.length}):

${pageSnapshots}`;

  logger.info('app-model.generating', {
    samplePages: sampleRoutes.length,
    totalRoutes: routes.length,
  });

  try {
    const result = await backend.call({
      model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [],
      maxTokens: 2048,
      cacheSystem: true,
    });

    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
    const body = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;

    const parsed = JSON.parse(body) as ApplicationModel;
    // Defensive: LLM may omit array fields; ensure they exist to prevent
    // downstream TypeError when accessing .length or iterating.
    parsed.errorPatterns ??= [];
    parsed.successPatterns ??= [];
    parsed.emptyStates ??= [];
    parsed.knownPatterns ??= [];

    const costUsd = computeCostUsd(model, {
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
      cacheRead: result.usage.cacheReadTokens,
      cacheWrite: result.usage.cacheWriteTokens,
    });

    logger.info('app-model.generated', {
      appType: parsed.appType,
      patternCount:
        parsed.errorPatterns.length + parsed.successPatterns.length + parsed.knownPatterns.length,
      costUsd: costUsd.toFixed(4),
    });

    return { model: parsed, costUsd };
  } catch (err) {
    logger.warn('app-model.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      model: {
        appType: opts.siteShape || 'unknown',
        errorPatterns: [],
        successPatterns: [],
        emptyStates: [],
        sortBehavior: 'unknown',
        authProvider: 'unknown',
        navigationStructure: 'unknown',
        knownPatterns: [],
      },
      costUsd: 0,
    };
  }
}

export function renderApplicationModelForPrompt(model: ApplicationModel): string {
  const lines: string[] = [
    'APPLICATION CONTEXT — what "normal" looks like for this app (do NOT file findings about expected behaviour):',
  ];

  if (model.appType) lines.push(`App type: ${model.appType}`);
  if (model.errorPatterns.length > 0)
    lines.push(`Error handling: ${model.errorPatterns.join('; ')}`);
  if (model.successPatterns.length > 0)
    lines.push(`Success feedback: ${model.successPatterns.join('; ')}`);
  if (model.emptyStates.length > 0) lines.push(`Empty states: ${model.emptyStates.join('; ')}`);
  if (model.sortBehavior && model.sortBehavior !== 'unknown')
    lines.push(`Sort behaviour: ${model.sortBehavior}`);
  if (
    model.authProvider &&
    model.authProvider !== 'none detected' &&
    model.authProvider !== 'unknown'
  )
    lines.push(`Auth provider: ${model.authProvider}`);
  if (model.navigationStructure && model.navigationStructure !== 'unknown')
    lines.push(`Navigation: ${model.navigationStructure}`);
  if (model.knownPatterns.length > 0) {
    lines.push('Known-normal patterns (NOT bugs):');
    for (const p of model.knownPatterns) lines.push(`  - ${p}`);
  }

  return lines.join('\n');
}
