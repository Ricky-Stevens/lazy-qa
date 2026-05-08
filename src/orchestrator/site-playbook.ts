/**
 * Site classifier. Runs ONCE after the crawler completes, before agents spawn.
 * Analyses the sitemap heuristically (no LLM call) to produce:
 *   - siteShape: e-commerce / admin-crud / content / social / api-gateway / mixed / unknown
 *   - siteSummary: 1-2 sentence plain-English description
 *
 * These are injected into each agent's system prompt for orientation only.
 * Agents read the sitemap themselves every turn — they don't need per-persona
 * briefs from an LLM. This replaces a $0.04-0.10, 2+ minute Sonnet call with
 * ~5ms of string matching.
 */

import type { SiteMap } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import type { EventWriter } from './events.ts';

export interface SitePlaybookInput {
  rootUrl: string;
  sitemap: SiteMap;
  logger: Logger;
  events?: EventWriter;
}

export interface SitePlaybookResult {
  ok: boolean;
  siteShape: string;
  siteSummary: string;
  costUsd: number;
}

// ─── Keyword sets for heuristic classification ───────────────────────────────

const ECOMMERCE_KEYWORDS = [
  'cart', 'basket', 'checkout', 'payment', 'order', 'shop', 'product',
  'price', 'buy', 'purchase', 'shipping', 'delivery', 'coupon', 'discount',
  'add-to-cart', 'add-to-basket', 'wallet',
];

const ADMIN_KEYWORDS = [
  'admin', 'dashboard', 'manage', 'settings', 'config', 'users',
  'create', 'edit', 'delete', 'update', 'crud', 'panel', 'console',
  'permissions', 'roles',
];

const CONTENT_KEYWORDS = [
  'blog', 'article', 'post', 'news', 'page', 'content', 'media',
  'gallery', 'archive', 'category', 'tag', 'publish',
];

const SOCIAL_KEYWORDS = [
  'profile', 'feed', 'follow', 'message', 'chat', 'comment', 'like',
  'share', 'notification', 'friend', 'group', 'community',
];

const API_KEYWORDS = [
  'api', 'rest', 'graphql', 'swagger', 'openapi', 'endpoint',
  'api-docs', 'v1', 'v2',
];

function countKeywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

function classifySiteShape(sitemap: SiteMap): string {
  const allText = Object.values(sitemap.routes)
    .map((r) => {
      const pm = sitemap.pageModels[r.route];
      const formNames = pm?.forms.map((f) => f.name ?? f.id ?? '').join(' ') ?? '';
      const tableNames = pm?.tables.map((t) => t.name ?? t.id ?? '').join(' ') ?? '';
      return `${r.url} ${r.title ?? ''} ${formNames} ${tableNames}`;
    })
    .join(' ');

  const scores: Record<string, number> = {
    ecommerce: countKeywordHits(allText, ECOMMERCE_KEYWORDS),
    'admin-crud': countKeywordHits(allText, ADMIN_KEYWORDS),
    content: countKeywordHits(allText, CONTENT_KEYWORDS),
    social: countKeywordHits(allText, SOCIAL_KEYWORDS),
    'api-gateway': countKeywordHits(allText, API_KEYWORDS),
  };

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = sorted;

  if (!top || top[1] === 0) return 'unknown';
  if (second && second[1] > 0 && second[1] >= top[1] * 0.6) return 'mixed';
  return top[0];
}

function buildSiteSummary(sitemap: SiteMap, siteShape: string): string {
  const routes = Object.values(sitemap.routes);
  const routeCount = routes.length;

  let formCount = 0;
  let tableCount = 0;
  let modalCount = 0;
  for (const r of routes) {
    const pm = sitemap.pageModels[r.route];
    if (!pm) continue;
    formCount += pm.forms.length;
    tableCount += pm.tables.length;
    modalCount += pm.modals.length;
  }

  const shapeLabel: Record<string, string> = {
    ecommerce: 'an e-commerce application',
    'admin-crud': 'an admin/CRUD application',
    content: 'a content-driven site',
    social: 'a social platform',
    'api-gateway': 'an API-first application',
    mixed: 'a mixed-purpose application',
    unknown: 'a web application',
  };

  const parts = [`This is ${shapeLabel[siteShape] ?? 'a web application'} with ${routeCount} discovered routes.`];
  const features: string[] = [];
  if (formCount > 0) features.push(`${formCount} form${formCount > 1 ? 's' : ''}`);
  if (tableCount > 0) features.push(`${tableCount} table${tableCount > 1 ? 's' : ''}`);
  if (modalCount > 0) features.push(`${modalCount} modal${modalCount > 1 ? 's' : ''}`);
  if (features.length > 0) {
    parts.push(`Interactive surface: ${features.join(', ')}.`);
  }

  return parts.join(' ');
}

export function classifySite(input: SitePlaybookInput): SitePlaybookResult {
  const { sitemap, logger, events } = input;
  const startedAt = Date.now();

  const routeCount = Object.keys(sitemap.routes).length;
  if (routeCount === 0) {
    logger.warn('site-classify.skip.empty-sitemap', {});
    void events?.write({
      type: 'site-playbook.complete',
      ok: false,
      siteShape: 'unknown',
      personas: [],
      costUsd: 0,
      durationMs: 0,
      detail: 'sitemap was empty',
    });
    return { ok: false, siteShape: 'unknown', siteSummary: '', costUsd: 0 };
  }

  const siteShape = classifySiteShape(sitemap);
  const siteSummary = buildSiteSummary(sitemap, siteShape);
  const durationMs = Date.now() - startedAt;

  logger.info('site-classify.complete', { siteShape, routeCount, durationMs });
  void events?.write({
    type: 'site-playbook.complete',
    ok: true,
    siteShape,
    personas: [],
    costUsd: 0,
    durationMs,
  });

  return { ok: true, siteShape, siteSummary, costUsd: 0 };
}
