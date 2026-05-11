import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouteEntry, SiteMap } from '../crawler/types.ts';
import type { PageModel } from '../page-model/types.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import {
  buildCoverageReport,
  type PlaybookOutcomeRecord,
  writeCoverageReport,
} from './coverage.ts';

function makeRoute(partial: Partial<RouteEntry> & { route: string }): RouteEntry {
  return {
    url: `http://app.example${partial.route}`,
    title: partial.route,
    formIds: [],
    tableIds: [],
    modalIds: [],
    wizardIds: [],
    source: 'crawler',
    discoveredAt: new Date().toISOString(),
    visited: false,
    ...partial,
  };
}

function makeSiteMap(routes: RouteEntry[]): SiteMap {
  const routesByKey: Record<string, RouteEntry> = {};
  // PageModels keyed by route — we don't need them populated for coverage
  // aggregation, just present so the type is satisfied.
  const pageModels: Record<string, PageModel> = {};
  for (const r of routes) routesByKey[r.route] = r;
  return {
    startedAt: new Date().toISOString(),
    rootUrl: 'http://app.example/',
    routes: routesByKey,
    pageModels,
  };
}

function makeJourney(agentId: string, findingTitles: string[]): Journey {
  const findings: Finding[] = findingTitles.map((title, i) => ({
    id: `${agentId}-f${i}`,
    ts: new Date().toISOString(),
    severity: 'minor',
    category: 'unexpected-behavior',
    title,
    description: 'desc desc desc desc desc',
    stepsToReproduce: ['x'],
    expected: 'e',
    actual: 'a',
    confidence: 'likely',
    source: 'agent',
  }));
  return {
    runId: 'run-test',
    agentId,
    startedAt: new Date().toISOString(),
    startUrl: 'http://app.example/',
    turns: 10,
    findings,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  };
}

describe('coverage', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'coverage-test-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('aggregates synthetic sitemap + journeys + playbook outcomes correctly', async () => {
    // 5 routes: 3 crawler / 2 agent. 4 visited. 1 with status=404.
    const routes: RouteEntry[] = [
      makeRoute({
        route: '/',
        source: 'crawler',
        visited: true,
        formIds: ['form-home'],
        tableIds: [],
        modalIds: ['modal-welcome'],
        wizardIds: [],
        status: 200,
      }),
      makeRoute({
        route: '/clients',
        source: 'crawler',
        visited: true,
        formIds: [],
        tableIds: ['tbl-clients'],
        modalIds: [],
        wizardIds: [],
        status: 200,
      }),
      makeRoute({
        route: '/clients/new',
        source: 'crawler',
        visited: true,
        formIds: ['form-client-new'],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        status: 200,
      }),
      makeRoute({
        route: '/onboarding',
        source: 'agent',
        visited: true,
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: ['wiz-onb'],
        status: 200,
      }),
      makeRoute({
        route: '/missing',
        source: 'agent',
        visited: false,
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        status: 404,
      }),
    ];
    const siteMap = makeSiteMap(routes);

    const journeys: Journey[] = [
      makeJourney('power-user', ['bug-1', 'bug-2', 'bug-3']),
      makeJourney('chaos', ['bug-4']),
      makeJourney('completionist', []),
    ];

    // 7 playbook outcomes covering different shapes.
    const playbookOutcomes: PlaybookOutcomeRecord[] = [
      {
        agentId: 'power-user',
        playbookName: 'fill_and_verify',
        route: '/clients/new',
        targetId: 'form-client-new',
        status: 'ok',
      },
      {
        agentId: 'power-user',
        playbookName: 'fill_and_verify',
        route: '/',
        targetId: 'form-home',
        status: 'failed',
      },
      {
        agentId: 'chaos',
        playbookName: 'form_fuzz_validation',
        route: '/clients/new',
        targetId: 'form-client-new',
        status: 'suspicious',
      },
      {
        agentId: 'chaos',
        playbookName: 'table_sort_each_column',
        route: '/clients',
        targetId: 'tbl-clients',
        status: 'ok',
      },
      {
        agentId: 'chaos',
        playbookName: 'fill_and_verify',
        route: '/',
        targetId: 'modal-welcome',
        status: 'ok',
      },
      {
        agentId: 'completionist',
        playbookName: 'walk_wizard',
        route: '/onboarding',
        targetId: 'wiz-onb',
        status: 'ok',
      },
      {
        agentId: 'power-user',
        playbookName: 'button_navigation_audit',
        route: '/',
        targetId: null,
        status: 'ok',
      },
    ];

    const report = buildCoverageReport({
      runId: 'run-test',
      siteMap,
      journeys,
      playbookOutcomes,
    });

    // Sitemap counts.
    expect(report.runId).toBe('run-test');
    expect(report.sitemap.routesDiscovered).toBe(5);
    expect(report.sitemap.routesVisited).toBe(4);
    expect(report.sitemap.routesByCrawler).toBe(3);
    expect(report.sitemap.routesByAgent).toBe(2);
    expect(report.sitemap.routes4xx).toBe(1);
    expect(report.sitemap.routes5xx).toBe(0);

    // Forms / tables / modals / wizards counts.
    expect(report.forms.found).toBe(2);
    expect(report.forms.crudCreateAttempted).toBe(3); // 2 form ids + 1 modal id (all fill_and_verify)
    expect(report.forms.crudEditAttempted).toBe(0);
    expect(report.forms.fuzzAttempted).toBe(1);

    expect(report.tables.found).toBe(1);
    expect(report.tables.sorted).toBe(1);
    expect(report.tables.paginated).toBe(0);
    expect(report.tables.filtered).toBe(0);

    expect(report.modals.found).toBe(1);
    expect(report.modals.lifecycleTested).toBe(3);

    expect(report.wizards.found).toBe(1);
    expect(report.wizards.walkthroughAttempted).toBe(1);

    // Playbook tally.
    expect(report.playbooks.fill_and_verify).toEqual({ ok: 2, failed: 1, suspicious: 0 });
    expect(report.playbooks.form_fuzz_validation).toEqual({ ok: 0, failed: 0, suspicious: 1 });
    expect(report.playbooks.table_sort_each_column).toEqual({ ok: 1, failed: 0, suspicious: 0 });
    expect(report.playbooks.walk_wizard).toEqual({
      ok: 1,
      failed: 0,
      suspicious: 0,
    });
    expect(report.playbooks.button_navigation_audit).toEqual({
      ok: 1,
      failed: 0,
      suspicious: 0,
    });

    // Per-agent.
    expect(report.perAgent['power-user']).toEqual({ playbooks: 3, findings: 3 });
    expect(report.perAgent.chaos).toEqual({ playbooks: 3, findings: 1 });
    expect(report.perAgent.completionist).toEqual({ playbooks: 1, findings: 0 });
  });

  it('writes coverage.json and coverage.md to disk', async () => {
    const siteMap = makeSiteMap([
      makeRoute({ route: '/', source: 'crawler', visited: true, status: 200 }),
    ]);
    const journeys: Journey[] = [makeJourney('a', [])];
    const report = await writeCoverageReport(tmp, {
      runId: 'run-disk',
      siteMap,
      journeys,
      playbookOutcomes: [],
    });

    const jsonRaw = await readFile(path.join(tmp, 'coverage.json'), 'utf8');
    expect(JSON.parse(jsonRaw)).toEqual(report);

    const md = await readFile(path.join(tmp, 'coverage.md'), 'utf8');
    expect(md).toContain('# Coverage — run run-disk');
    expect(md).toContain('## Sitemap');
    expect(md).toContain('## Forms');
    expect(md).toContain('## Tables');
    expect(md).toContain('## Modals');
    expect(md).toContain('## Wizards');
    expect(md).toContain('## Playbooks executed');
    expect(md).toContain('## Per-agent depth');
  });
});
