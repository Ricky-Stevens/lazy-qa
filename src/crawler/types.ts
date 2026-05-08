/**
 * Crawler types: SiteMap is the shared "what does this app look like" map
 * agents read from. Built by the pre-run BFS crawler and extended on-demand
 * as agents discover new routes at runtime.
 */

import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';
import type { EventWriter } from '../orchestrator/events.ts';
import type { PageModel } from '../page-model/types.ts';

export interface RouteEntry {
  url: string;
  /** origin + pathname (no query/fragment). */
  route: string;
  title: string;
  /** Last HTTP status seen on the navigation response. */
  status?: number;
  /** Stable IDs of forms/tables/modals/wizards on this route, for sitemap queries. */
  formIds: string[];
  tableIds: string[];
  modalIds: string[];
  wizardIds: string[];
  /** Was this route reached by the pre-run crawler, or discovered by an agent? */
  source: 'crawler' | 'agent';
  discoveredAt: string;
  visitedAt?: string;
  /** Has any agent visited this in the current run? */
  visited: boolean;
  /** Have we run the affordance probe on this route yet? Idempotency flag —
   * the probe is non-destructive but takes ~5-10s, so we skip if already
   * done. Agents can force a re-probe via the `discover_route_affordances`
   * playbook (e.g. after creating a new row). Optional: defaults to false. */
  affordancesProbed?: boolean;
}

export interface SiteMap {
  startedAt: string;
  rootUrl: string;
  /** Keyed by route (origin + pathname). */
  routes: Record<string, RouteEntry>;
  /** Full PageModels keyed by route. Sites with thousands of routes may want
   * to externalise; for v2 we keep them in memory. */
  pageModels: Record<string, PageModel>;
}

export interface CrawlOptions {
  /** Root URL to start crawling from. */
  rootUrl: string;
  /** Hard cap on routes visited during pre-run crawl. Default 60. */
  maxRoutes: number;
  /** Max wall-clock for pre-run crawl, ms. Default 60_000. */
  maxWallClockMs: number;
  /** Allowed-host filter from config. */
  allowedHosts: string[];
  /** Path prefixes to skip (e.g. "/users" blocks "/users/123"). */
  bannedPathPrefixes?: string[];
  /** Path to auth-state.json for authenticated crawling. */
  storageStatePath?: string;
  /** Optional custom link extractor. Defaults to Crawlee's built-in. */
  linkExtractor?: (page: Page) => Promise<string[]>;
  logger: Logger;
  /** Event writer for this run. Optional — emits crawl.* events. */
  events?: EventWriter;
  /** Number of concurrent browser tabs. Default 3. */
  parallelism?: number;
  /** Use CloakBrowser stealth mode. */
  stealth?: boolean;
}

/**
 * Read+write accessor over a SiteMap, used by playbooks and the agent loop.
 * The `listXUntested` queries underpin the `ask_sitemap` discovery playbook.
 */
export interface SiteMapAccessor {
  getRoute(route: string): RouteEntry | undefined;
  getPageModel(route: string): PageModel | undefined;
  listAllRoutes(): RouteEntry[];
  listUnvisitedRoutes(): RouteEntry[];
  listFormsUntested(playbook: string): Array<{ route: string; formId: string }>;
  listTablesUntested(playbook: string): Array<{ route: string; tableId: string }>;
  listModalsUntested(playbook: string): Array<{ route: string; modalId: string }>;
  listWizardsUntested(playbook: string): Array<{ route: string; wizardId: string }>;
  recordVisit(route: string): void;
  /** Record that a playbook ran against a target on a route, with status. */
  recordPlaybookOutcome(
    route: string,
    playbookName: string,
    targetId: string | null,
    status: 'ok' | 'failed' | 'suspicious',
  ): void;
  /** Add or replace a route's PageModel + RouteEntry. Used by on-demand expansion. */
  upsertRoute(entry: RouteEntry, model: PageModel): void;
  /** Plain-data dump for serialization. */
  serialize(): SiteMap;
}
