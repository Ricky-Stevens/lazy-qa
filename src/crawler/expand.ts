/**
 * On-demand route expansion. Called by the browser server when an agent
 * navigates to a URL the pre-run crawler didn't reach. Idempotent — if the
 * route already exists in the SiteMap, the existing entry is returned and a
 * visit is recorded; otherwise a fresh PageModel is parsed and stored as
 * `source: 'agent'`.
 */

import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';
import { parsePage } from '../page-model/parser.ts';
import { probeAffordances } from './affordance-probe.ts';
import { buildRouteEntry } from './sitemap.ts';
import type { RouteEntry, SiteMapAccessor } from './types.ts';

export interface ExpandRouteOptions {
  /** Run the affordance probe on first visit (idempotent). Default true.
   * Disable via `probe: false` for tests or for routes the caller knows
   * shouldn't be probed (e.g. logout pages). */
  probe?: boolean;
  /** Optional logger forwarded to the probe. */
  logger?: Logger;
  /** Forwarded to the affordance probe so it can skip navigation to off-host
   * URLs discovered behind buttons/menus. Empty array = no restriction. */
  allowedHosts?: string[];
}

function deriveRoute(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Capture (or refresh) the route currently loaded in `page`. The `route`
 * argument is the canonical key the caller wants to associate with this
 * expansion — it is normalized to origin+pathname before lookup.
 *
 * Returns the (newly built or pre-existing) RouteEntry. The caller is
 * expected to assert before calling that the page is already on the desired
 * URL — this function does NOT navigate.
 */
export async function expandRoute(
  siteMap: SiteMapAccessor,
  page: Page,
  route: string,
  options: ExpandRouteOptions = {},
): Promise<RouteEntry> {
  const normalized = deriveRoute(route);
  const probe = options.probe !== false;
  const existing = siteMap.getRoute(normalized);

  if (existing) {
    siteMap.recordVisit(normalized);
    // If a probe hasn't run yet on this route, fire it now even though the
    // entry exists — agents that visit a crawler-discovered route should
    // still get the affordance map populated. Keep it idempotent.
    if (probe && !existing.affordancesProbed) {
      const refreshedModel = siteMap.getPageModel(normalized);
      if (refreshedModel) {
        const discovered = await probeAffordances(page, refreshedModel, {
          ...(options.logger ? { logger: options.logger } : {}),
          ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
        });
        const updatedModel = { ...refreshedModel, discovered };
        const updatedEntry: RouteEntry = {
          ...existing,
          affordancesProbed: true,
          visited: true,
          visitedAt: new Date().toISOString(),
        };
        siteMap.upsertRoute(updatedEntry, updatedModel);
        return updatedEntry;
      }
    }
    const refreshed = siteMap.getRoute(normalized);
    return refreshed ?? existing;
  }

  const model = await parsePage(page);
  let discovered: ReturnType<typeof probeAffordances> extends Promise<infer T> ? T : never = [];
  if (probe) {
    discovered = await probeAffordances(page, model, {
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    });
  }
  const enrichedModel = { ...model, discovered };
  const entry = buildRouteEntry({
    url: model.url || page.url(),
    route: model.route || normalized,
    title: model.title,
    formIds: model.forms.map((f) => f.id),
    tableIds: model.tables.map((t) => t.id),
    modalIds: model.modals.map((m) => m.id),
    wizardIds: model.wizards.map((w) => w.id),
    source: 'agent',
    visited: true,
    visitedAt: new Date().toISOString(),
    affordancesProbed: probe,
  });
  siteMap.upsertRoute(entry, enrichedModel);
  return entry;
}
