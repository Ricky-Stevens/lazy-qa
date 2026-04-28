/**
 * In-memory implementation of the shared SiteMap. Built by the pre-run
 * crawler and mutated at runtime as agents discover new routes / record
 * playbook outcomes. All read APIs return shallow copies so callers can
 * mutate freely without poisoning internal state.
 */

import type { PageModel } from '../page-model/types.ts';
import { isHostAllowed } from '../safety/guards.ts';
import type { RouteEntry, SiteMap, SiteMapAccessor } from './types.ts';

type PlaybookOutcomeStatus = 'ok' | 'failed' | 'suspicious';

/** Concrete implementation of SiteMapAccessor, holding the shared mutable state. */
export class SiteMapImpl implements SiteMapAccessor {
  private readonly startedAt: string;
  private readonly rootUrl: string;
  private readonly allowedHosts: string[];
  private readonly routes = new Map<string, RouteEntry>();
  private readonly pageModels = new Map<string, PageModel>();
  /**
   * Per-(playbook, targetId) record of attempts that have been recorded with
   * a non-failed status. Keyed `${playbook}::${targetId ?? '*'}`. The Set
   * holds the routes on which the (playbook, targetId) was recorded so we can
   * answer `listFormsUntested(playbook)` etc by route iteration.
   */
  private readonly playbookAttempts = new Map<string, Set<string>>();

  constructor(opts: { rootUrl: string; startedAt?: string; allowedHosts?: string[] }) {
    this.rootUrl = opts.rootUrl;
    this.startedAt = opts.startedAt ?? new Date().toISOString();
    this.allowedHosts = opts.allowedHosts ?? [];
  }

  getRoute(route: string): RouteEntry | undefined {
    const entry = this.routes.get(route);
    return entry ? { ...entry } : undefined;
  }

  getPageModel(route: string): PageModel | undefined {
    return this.pageModels.get(route);
  }

  listAllRoutes(): RouteEntry[] {
    return Array.from(this.routes.values()).map((r) => ({ ...r }));
  }

  listUnvisitedRoutes(): RouteEntry[] {
    const out: RouteEntry[] = [];
    for (const r of this.routes.values()) {
      if (!r.visited) out.push({ ...r });
    }
    return out;
  }

  listFormsUntested(playbook: string): Array<{ route: string; formId: string }> {
    return this.listTargetsUntested(playbook, 'formIds').map(({ route, targetId }) => ({
      route,
      formId: targetId,
    }));
  }

  listTablesUntested(playbook: string): Array<{ route: string; tableId: string }> {
    return this.listTargetsUntested(playbook, 'tableIds').map(({ route, targetId }) => ({
      route,
      tableId: targetId,
    }));
  }

  listModalsUntested(playbook: string): Array<{ route: string; modalId: string }> {
    return this.listTargetsUntested(playbook, 'modalIds').map(({ route, targetId }) => ({
      route,
      modalId: targetId,
    }));
  }

  listWizardsUntested(playbook: string): Array<{ route: string; wizardId: string }> {
    return this.listTargetsUntested(playbook, 'wizardIds').map(({ route, targetId }) => ({
      route,
      wizardId: targetId,
    }));
  }

  recordVisit(route: string): void {
    const entry = this.routes.get(route);
    if (!entry) return;
    entry.visited = true;
    entry.visitedAt = new Date().toISOString();
  }

  recordPlaybookOutcome(
    route: string,
    playbookName: string,
    targetId: string | null,
    status: PlaybookOutcomeStatus,
  ): void {
    // We only consider an attempt as "tested" if the outcome was ok or
    // suspicious — failed attempts shouldn't bar the agent from re-trying.
    if (status === 'failed') return;
    const key = `${playbookName}::${targetId ?? '*'}`;
    let set = this.playbookAttempts.get(key);
    if (!set) {
      set = new Set();
      this.playbookAttempts.set(key, set);
    }
    set.add(route);
  }

  upsertRoute(entry: RouteEntry, model: PageModel): void {
    // Host filter — drop entries that aren't on the configured allowlist.
    // Without this, a stray external link in the page (e.g. a github.com
    // anchor in a footer) leaks into "unvisited routes" and agents waste
    // turns trying to navigate off-host. Only enforced when allowedHosts
    // was supplied — backward-compatible with callers that don't pass it.
    if (this.allowedHosts.length > 0) {
      const candidate = entry.url || entry.route;
      if (!isHostAllowed(candidate, this.allowedHosts)) return;
    }
    const existing = this.routes.get(entry.route);
    const merged: RouteEntry = {
      ...entry,
      // Preserve original discoveredAt if the route was previously seen.
      discoveredAt: existing ? existing.discoveredAt : entry.discoveredAt,
    };
    this.routes.set(entry.route, merged);
    this.pageModels.set(entry.route, model);
  }

  serialize(): SiteMap {
    const routes: Record<string, RouteEntry> = {};
    for (const [k, v] of this.routes.entries()) routes[k] = { ...v };
    const pageModels: Record<string, PageModel> = {};
    for (const [k, v] of this.pageModels.entries()) pageModels[k] = v;
    return {
      startedAt: this.startedAt,
      rootUrl: this.rootUrl,
      routes,
      pageModels,
    };
  }

  /** Internal iterator: enumerate (route, targetId) pairs whose
   *  (playbook, targetId) attempt has not been recorded as ok/suspicious. */
  private listTargetsUntested(
    playbook: string,
    field: 'formIds' | 'tableIds' | 'modalIds' | 'wizardIds',
  ): Array<{ route: string; targetId: string }> {
    const out: Array<{ route: string; targetId: string }> = [];
    for (const entry of this.routes.values()) {
      const ids = entry[field];
      for (const targetId of ids) {
        const key = `${playbook}::${targetId}`;
        const attempted = this.playbookAttempts.get(key);
        if (attempted?.has(entry.route)) continue;
        out.push({ route: entry.route, targetId });
      }
    }
    return out;
  }
}

/** Build a RouteEntry from a parsed PageModel. The crawler/expander wraps
 * this; exposed because it gives callers a single canonical mapping
 * (PageModel → RouteEntry) without duplicating field-extraction logic. */
export function buildRouteEntry(opts: {
  url: string;
  route: string;
  title: string;
  status?: number;
  formIds: string[];
  tableIds: string[];
  modalIds: string[];
  wizardIds: string[];
  source: 'crawler' | 'agent';
  visited: boolean;
  discoveredAt?: string;
  visitedAt?: string;
  affordancesProbed?: boolean;
}): RouteEntry {
  const entry: RouteEntry = {
    url: opts.url,
    route: opts.route,
    title: opts.title,
    formIds: opts.formIds,
    tableIds: opts.tableIds,
    modalIds: opts.modalIds,
    wizardIds: opts.wizardIds,
    source: opts.source,
    discoveredAt: opts.discoveredAt ?? new Date().toISOString(),
    visited: opts.visited,
    affordancesProbed: opts.affordancesProbed ?? false,
  };
  if (opts.status !== undefined) entry.status = opts.status;
  if (opts.visitedAt !== undefined) entry.visitedAt = opts.visitedAt;
  return entry;
}
