/**
 * Coverage report data shape — written to runs/<runId>/coverage.{md,json}
 * after every run. Aggregates the SiteMap + per-agent playbook outcomes.
 */

export interface CoverageReport {
  runId: string;
  generatedAt: string;
  sitemap: {
    routesDiscovered: number;
    routesVisited: number;
    routesByCrawler: number;
    routesByAgent: number;
    routes4xx: number;
    routes5xx: number;
  };
  forms: {
    found: number;
    crudCreateAttempted: number;
    crudEditAttempted: number;
    fuzzAttempted: number;
  };
  tables: {
    found: number;
    sorted: number;
    paginated: number;
    filtered: number;
  };
  modals: {
    found: number;
    lifecycleTested: number;
  };
  wizards: {
    found: number;
    walkthroughAttempted: number;
  };
  /** Per-playbook tally. */
  playbooks: Record<string, { ok: number; failed: number; suspicious: number }>;
  /** Per-agent depth. */
  perAgent: Record<string, { playbooks: number; findings: number }>;
}
