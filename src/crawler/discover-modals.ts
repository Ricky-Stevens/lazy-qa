/**
 * Post-crawl modal/drawer discovery.
 *
 * The pre-run crawler only sees the page at rest — forms hidden behind "Add",
 * "Create", "Edit" buttons that open modals/drawers are invisible. This module
 * runs AFTER the main crawl but BEFORE agents start. For each route whose
 * page model contains toolbar or bare-interactive buttons matching a trigger
 * pattern, it:
 *
 *   1. Navigates to the route
 *   2. Clicks each candidate trigger
 *   3. Waits for a modal/drawer to appear
 *   4. Re-parses the page (capturing the modal's form in the new PageModel)
 *   5. Dismisses the modal (Escape, then cancel/close buttons)
 *   6. Updates the sitemap with the enriched page model
 *
 * This is intentionally coarse — we don't need to be clever. We just need to
 * discover the forms that are gated behind a click, so agents know they exist
 * and the test plan can cover them.
 */

import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';
import { parsePage } from '../page-model/parser.ts';
import type { ActionRef, PageModel } from '../page-model/types.ts';
import { buildRouteEntry } from './sitemap.ts';
import type { SiteMapAccessor } from './types.ts';

/** Labels that suggest the button opens a creation/edit form or modal. */
const MODAL_TRIGGER_RE =
  /^(add|create|new|edit|import|upload|invite|configure|settings|manage|connect|register|setup|link|assign)/i;

export interface DiscoverModalsOptions {
  sitemap: SiteMapAccessor;
  page: Page;
  logger: Logger;
  /** Hard cap on routes to probe. Default 20. */
  maxRoutesToProbe?: number;
  /** Max candidate buttons to try per route. Default 5. */
  maxTriggersPerRoute?: number;
}

export interface DiscoveryResult {
  routesProbed: number;
  modalsFound: number;
  formsDiscovered: number;
}

/**
 * Collect candidate trigger buttons from a page model. These are toolbar
 * buttons and bare interactives whose labels match the trigger regex.
 */
function collectCandidates(model: PageModel): ActionRef[] {
  const all: ActionRef[] = [...(model.toolbars ?? []), ...(model.bareInteractives ?? [])];
  return all.filter((a) => !a.disabled && MODAL_TRIGGER_RE.test(a.label));
}

/**
 * Run modal/drawer discovery across the sitemap's routes.
 */
export async function discoverModals(opts: DiscoverModalsOptions): Promise<DiscoveryResult> {
  const { sitemap, page, logger, maxRoutesToProbe = 20, maxTriggersPerRoute = 5 } = opts;

  let modalsFound = 0;
  let formsDiscovered = 0;
  let routesProbed = 0;

  // Build a list of (route, candidates) pairs, skipping routes with no
  // trigger buttons. Cap at maxRoutesToProbe.
  const probeTargets: Array<{ route: string; candidates: ActionRef[]; model: PageModel }> = [];
  for (const entry of sitemap.listAllRoutes()) {
    if (probeTargets.length >= maxRoutesToProbe) break;

    const model = sitemap.getPageModel(entry.route);
    if (!model) continue;

    const candidates = collectCandidates(model);
    if (candidates.length === 0) continue;

    probeTargets.push({ route: entry.route, candidates, model });
  }

  if (probeTargets.length === 0) {
    logger.info('discover-modals.skip', { reason: 'no routes with trigger buttons' });
    return { routesProbed: 0, modalsFound: 0, formsDiscovered: 0 };
  }

  logger.info('discover-modals.start', {
    routesToProbe: probeTargets.length,
    totalCandidates: probeTargets.reduce((s, t) => s + t.candidates.length, 0),
  });

  for (const { route, candidates, model } of probeTargets) {
    try {
      await page.goto(route, { waitUntil: 'networkidle', timeout: 10_000 });
    } catch {
      logger.debug('discover-modals.nav-failed', { route });
      continue;
    }

    routesProbed++;
    const oldFormCount = model.forms?.length ?? 0;

    for (const candidate of candidates.slice(0, maxTriggersPerRoute)) {
      try {
        // Click the candidate trigger
        const urlBefore = page.url();
        await page.click(candidate.locator, { timeout: 3_000 });
        await page.waitForTimeout(1_000);

        // If clicking navigated away, go back — we only want modals/drawers,
        // not page transitions. Compare origin+pathname to ignore hash changes.
        const urlAfter = page.url();
        if (urlBefore !== urlAfter) {
          try {
            const before = new URL(urlBefore);
            const after = new URL(urlAfter);
            if (before.origin + before.pathname !== after.origin + after.pathname) {
              logger.debug('discover-modals.navigated-away', {
                route,
                trigger: candidate.label,
                from: urlBefore,
                to: urlAfter,
              });
              await page.goto(route, { waitUntil: 'networkidle', timeout: 10_000 });
              continue;
            }
          } catch {
            // URL parse failed — treat as navigation, go back
            await page.goto(route, { waitUntil: 'networkidle', timeout: 10_000 });
            continue;
          }
        }

        // Re-parse the page to capture any modal/form that appeared
        const newModel = await parsePage(page);
        const newFormCount = newModel.forms?.length ?? 0;
        const newModalCount = newModel.modals?.length ?? 0;

        if (newFormCount > oldFormCount || newModalCount > 0) {
          modalsFound++;
          formsDiscovered += Math.max(0, newFormCount - oldFormCount);

          logger.info('discover-modals.found', {
            route,
            trigger: candidate.label,
            newForms: newFormCount - oldFormCount,
            newModals: newModalCount,
          });

          // Merge new forms/modals into the existing model's ID arrays and
          // upsert the enriched model into the sitemap. Defensive fallbacks
          // guard against partial/corrupted page models where arrays are missing.
          const mergedModel: PageModel = {
            ...model,
            forms: dedupeById([...(model.forms ?? []), ...(newModel.forms ?? [])]),
            modals: dedupeById([...(model.modals ?? []), ...(newModel.modals ?? [])]),
          };

          const entry = buildRouteEntry({
            url: model.url,
            route: model.route,
            title: model.title,
            formIds: (mergedModel.forms ?? []).map((f) => f.id),
            tableIds: (mergedModel.tables ?? []).map((t) => t.id),
            modalIds: (mergedModel.modals ?? []).map((m) => m.id),
            wizardIds: (mergedModel.wizards ?? []).map((w) => w.id),
            source: 'crawler',
            visited: false,
          });
          sitemap.upsertRoute(entry, mergedModel);
        }

        // Dismiss: try Escape first, then fall back to close/cancel buttons
        // if a dialog is still visible.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        const dialogStillOpen = await page
          .locator('[role="dialog"], [role="alertdialog"], .modal.show, .modal.open')
          .first()
          .isVisible()
          .catch(() => false);
        if (dialogStillOpen) {
          // Try common close affordances
          for (const closeSelector of [
            '[aria-label="Close" i]',
            '[aria-label="close" i]',
            'button:has-text("Cancel")',
            'button:has-text("Close")',
            '.modal .close',
            '.modal-close',
          ]) {
            const closer = page.locator(closeSelector).first();
            if (await closer.isVisible().catch(() => false)) {
              await closer.click({ timeout: 1_000 }).catch(() => {});
              await page.waitForTimeout(300);
              break;
            }
          }
        }
      } catch (err) {
        logger.debug('discover-modals.click-failed', {
          route,
          trigger: candidate.label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info('discover-modals.done', {
    routesProbed,
    modalsFound,
    formsDiscovered,
  });

  return { routesProbed, modalsFound, formsDiscovered };
}

/** Deduplicate an array of objects with an `id` property, keeping the last occurrence. */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}
