/**
 * Discovery playbooks — surface untested coverage to the agent.
 *
 * `ask_sitemap` queries the SiteMap accessor for unvisited routes / untested
 * forms / untested tables / etc., returning up to 10 items as evidence.
 *
 * `route_404_probe` navigates a caller-provided list of paths (relative to the
 * current origin) and records the HTTP status of each, marking the run
 * `suspicious` if any path returns 5xx (server error masquerading as a 404).
 */

import { z } from 'zod';
import { probeAffordances } from '../crawler/affordance-probe.ts';
import { buildRouteEntry } from '../crawler/sitemap.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const ACTION_TIMEOUT_MS = 5_000;
const MAX_ITEMS = 10;

// ─── ask_sitemap ─────────────────────────────────────────────────────────────

export type AskSitemapQuery =
  | 'unvisited routes'
  | 'untested forms'
  | 'unsorted tables'
  | 'unexercised modals'
  | 'unexercised wizards'
  | '4xx routes';

export interface AskSitemapInput {
  query: AskSitemapQuery;
}

const askSitemapShape = {
  query: z.enum([
    'unvisited routes',
    'untested forms',
    'unsorted tables',
    'unexercised modals',
    'unexercised wizards',
    '4xx routes',
  ]),
} satisfies z.ZodRawShape;

export const askSitemap: Playbook<AskSitemapInput> = {
  name: 'ask_sitemap',
  description:
    'Query the shared SiteMap for unvisited routes, untested forms, unsorted tables, unexercised modals, unexercised wizards, or 4xx routes. Returns up to 10 items in evidence.',
  categories: ['discovery'],
  estimatedDurationMs: 200,
  inputShape: askSitemapShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { query: input.query, items: [] as unknown[] };

    let items: unknown[] = [];
    try {
      switch (input.query) {
        case 'unvisited routes': {
          items = ctx.siteMap.listUnvisitedRoutes().slice(0, MAX_ITEMS).map((r) => ({
            route: r.route,
            url: r.url,
            title: r.title,
          }));
          break;
        }
        case 'untested forms': {
          items = ctx.siteMap
            .listFormsUntested('crud_create_form')
            .slice(0, MAX_ITEMS);
          break;
        }
        case 'unsorted tables': {
          items = ctx.siteMap
            .listTablesUntested('table_sort_each_column')
            .slice(0, MAX_ITEMS);
          break;
        }
        case 'unexercised modals': {
          items = ctx.siteMap
            .listModalsUntested('modal_open_close')
            .slice(0, MAX_ITEMS);
          break;
        }
        case 'unexercised wizards': {
          items = ctx.siteMap
            .listWizardsUntested('wizard_full_walkthrough')
            .slice(0, MAX_ITEMS);
          break;
        }
        case '4xx routes': {
          items = ctx.siteMap
            .listAllRoutes()
            .filter((r) => typeof r.status === 'number' && r.status >= 400 && r.status < 500)
            .slice(0, MAX_ITEMS)
            .map((r) => ({ route: r.route, url: r.url, status: r.status, title: r.title }));
          break;
        }
      }
      steps.push({ label: `query: ${input.query}`, ok: true });
    } catch (err) {
      steps.push({
        label: `query: ${input.query}`,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    evidence.items = items;
    evidence.itemCount = items.length;

    return ok(
      askSitemap.name,
      `ask_sitemap("${input.query}") → ${items.length} item(s)`,
      evidence,
      steps,
    );
  },
};

// ─── route_404_probe ─────────────────────────────────────────────────────────

export interface Route404ProbeInput {
  paths: string[];
}

const route404ProbeShape = {
  paths: z.array(z.string()),
} satisfies z.ZodRawShape;

export const route404Probe: Playbook<Route404ProbeInput> = {
  name: 'route_404_probe',
  description:
    'Navigate each caller-supplied path (relative to the current origin) and record the HTTP status. Suspicious when any path returns 5xx. Inputs: paths (array of strings).',
  categories: ['discovery'],
  estimatedDurationMs: 8_000,
  inputShape: route404ProbeShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      paths: input.paths,
      results: [] as Array<{ path: string; status: number | null; ok: boolean }>,
    };
    const results = evidence.results as Array<{
      path: string;
      status: number | null;
      ok: boolean;
    }>;

    let origin = '';
    try {
      origin = new URL(ctx.page.url()).origin;
    } catch {
      // about:blank → leave origin empty; navigations will likely fail but be captured.
    }
    evidence.origin = origin;

    let any5xx = false;
    for (const path of input.paths) {
      const url = origin && path.startsWith('/') ? `${origin}${path}` : path;
      let status: number | null = null;
      try {
        const resp = await ctx.page.goto(url, { timeout: ACTION_TIMEOUT_MS });
        status = resp ? resp.status() : null;
        steps.push({ label: `probe ${path} → ${status ?? 'no-response'}`, ok: true });
      } catch (err) {
        steps.push({
          label: `probe ${path}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      const isOk = status !== null && status >= 200 && status < 400;
      if (status !== null && status >= 500) any5xx = true;
      results.push({ path, status, ok: isOk });
    }

    evidence.any5xx = any5xx;

    if (any5xx) {
      return suspicious(
        route404Probe.name,
        `route_404_probe: at least one path returned 5xx (probable server error masquerading as 404)`,
        evidence,
        steps,
      );
    }
    return ok(
      route404Probe.name,
      `route_404_probe: probed ${input.paths.length} path(s)`,
      evidence,
      steps,
    );
  },
};

// ─── discover_route_affordances ──────────────────────────────────────────────

export interface DiscoverRouteAffordancesInput {
  /** Force a re-probe even if this route has already been probed. Use after
   * you've created a new row, opened a different tab, or otherwise changed
   * the state of the page enough that new affordances might exist. */
  force?: boolean;
}

const discoverRouteAffordancesShape = {
  force: z.boolean().optional(),
} satisfies z.ZodRawShape;

function deriveRoute(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

export const discoverRouteAffordances: Playbook<DiscoverRouteAffordancesInput> = {
  name: 'discover_route_affordances',
  description:
    'Probe the current route non-destructively: click toolbar/header buttons and table row kebabs, observe what each opens (modal, wizard, menu, navigation, toast, inert), then dismiss. Surfaces affordances the link-graph crawler can\'t see — Add forms behind buttons, Edit screens reached via row actions, multi-step wizards. Auto-runs on first agent visit per route; invoke manually with `force: true` after you create new rows or otherwise change page state. Returns a list of discovered triggers + outcomes.',
  categories: ['discovery'],
  estimatedDurationMs: 8_000,
  inputShape: discoverRouteAffordancesShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {};
    const route = deriveRoute(ctx.page.url());
    const existing = ctx.siteMap.getRoute(route);
    const force = input.force === true;

    if (existing?.affordancesProbed && !force) {
      const model = ctx.siteMap.getPageModel(route);
      const discovered = model?.discovered ?? [];
      evidence.route = route;
      evidence.alreadyProbed = true;
      evidence.discovered = discovered;
      steps.push({
        label: `cached probe (${discovered.length} affordance(s))`,
        ok: true,
      });
      return ok(
        discoverRouteAffordances.name,
        `Already probed; ${discovered.length} affordance(s) cached. Pass force:true to re-probe.`,
        evidence,
        steps,
      );
    }

    let model = ctx.siteMap.getPageModel(route);
    if (!model) {
      // Page model missing — re-parse via the browser server's pageModel(),
      // which has caching, instead of duplicating parser logic here.
      try {
        model = await ctx.pageModel();
      } catch (err) {
        steps.push({
          label: 'pageModel()',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
        return fail(
          discoverRouteAffordances.name,
          'Could not parse page model — probe aborted.',
          evidence,
          steps,
        );
      }
    }

    const discovered = await probeAffordances(ctx.page, model, {
      logger: ctx.logger,
    });

    // Persist into the SiteMap so other agents see this on their next snapshot.
    const updatedModel = { ...model, discovered };
    const updatedEntry = buildRouteEntry({
      url: model.url || ctx.page.url(),
      route,
      title: model.title,
      formIds: model.forms.map((f) => f.id),
      tableIds: model.tables.map((t) => t.id),
      modalIds: model.modals.map((m) => m.id),
      wizardIds: model.wizards.map((w) => w.id),
      source: existing?.source ?? 'agent',
      visited: true,
      visitedAt: new Date().toISOString(),
      ...(existing?.discoveredAt ? { discoveredAt: existing.discoveredAt } : {}),
      affordancesProbed: true,
    });
    ctx.siteMap.upsertRoute(updatedEntry, updatedModel);

    evidence.route = route;
    evidence.alreadyProbed = false;
    evidence.force = force;
    evidence.discovered = discovered;
    evidence.discoveredCount = discovered.length;

    const counts = discovered.reduce<Record<string, number>>((acc, d) => {
      acc[d.outcome.kind] = (acc[d.outcome.kind] ?? 0) + 1;
      return acc;
    }, {});
    steps.push({
      label: `probed ${discovered.length} affordance(s): ${
        Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || 'none'
      }`,
      ok: true,
    });

    // If everything came back as `error`, the probe is broken on this page —
    // surface as suspicious so the agent investigates.
    const errorCount = counts['error'] ?? 0;
    if (discovered.length > 0 && errorCount === discovered.length) {
      return suspicious(
        discoverRouteAffordances.name,
        `All ${discovered.length} candidate triggers failed to probe — selectors may be stale or the page may be broken.`,
        evidence,
        steps,
      );
    }

    return ok(
      discoverRouteAffordances.name,
      `Probed ${discovered.length} affordance(s) on ${route}.`,
      evidence,
      steps,
    );
  },
};

// ─── Registration ───────────────────────────────────────────────────────────

export function registerDiscoveryPlaybooks(r: PlaybookRegistry): void {
  r.register(askSitemap);
  r.register(route404Probe);
  r.register(discoverRouteAffordances);
}
