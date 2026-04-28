/**
 * Coverage report writer.
 *
 * Aggregates the SiteMap + per-agent playbook outcomes + journeys into a
 * `CoverageReport` and writes both `coverage.json` and `coverage.md` to the
 * run directory. Spec §10 defines the markdown format.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SiteMap } from '../crawler/types.ts';
import type { Journey } from '../types/journey.ts';
import type { CoverageReport } from './coverage-types.ts';

/** Per-(agent,playbook,target) attempt record used to compute coverage. */
export interface PlaybookOutcomeRecord {
  agentId: string;
  playbookName: string;
  route: string;
  /** Stable id of the form/table/modal/wizard the playbook targeted, when applicable. */
  targetId: string | null;
  status: 'ok' | 'failed' | 'suspicious';
}

/** Per-agent counts of primitive tool calls. Drawn from events.jsonl alongside
 *  playbook outcomes — primitive interactions (click, fill_form, type) are
 *  invisible to the playbook-outcome tally but represent the bulk of what
 *  honest personas actually do. Exposing them in the coverage report stops
 *  "0/6 forms exercised" misreading what really happened. */
export interface PrimitiveActivity {
  agentId: string;
  fillForm: number;
  click: number;
  type: number;
  navigate: number;
  reportFinding: number;
}

export interface CoverageInputs {
  runId: string;
  siteMap: SiteMap;
  journeys: Journey[];
  playbookOutcomes: PlaybookOutcomeRecord[];
  /** Optional — when omitted the markdown's "Primitive interactions" section is
   *  skipped. Caller is expected to derive this from events.jsonl. */
  primitiveActivity?: PrimitiveActivity[];
}

const PCT = (numerator: number, denominator: number): string => {
  if (denominator === 0) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
};

/**
 * Count unique target ids that any playbook outcome with the given playbook
 * name touched. Outcomes with `targetId === null` are ignored — those are
 * playbooks that don't operate against a single target (e.g. nav audits).
 */
function uniqueTargetsFor(outcomes: PlaybookOutcomeRecord[], playbookName: string): number {
  const ids = new Set<string>();
  for (const o of outcomes) {
    if (o.playbookName !== playbookName) continue;
    if (o.targetId === null) continue;
    ids.add(o.targetId);
  }
  return ids.size;
}

export function buildCoverageReport(inputs: CoverageInputs): CoverageReport {
  const { runId, siteMap, journeys, playbookOutcomes } = inputs;

  const routes = Object.values(siteMap.routes);
  const routesDiscovered = routes.length;
  const routesVisited = routes.filter((r) => r.visited).length;
  const routesByCrawler = routes.filter((r) => r.source === 'crawler').length;
  const routesByAgent = routes.filter((r) => r.source === 'agent').length;
  const routes4xx = routes.filter(
    (r) => typeof r.status === 'number' && r.status >= 400 && r.status < 500,
  ).length;
  const routes5xx = routes.filter(
    (r) => typeof r.status === 'number' && r.status >= 500 && r.status < 600,
  ).length;

  // Sums of per-route component counts.
  const formsFound = routes.reduce((acc, r) => acc + r.formIds.length, 0);
  const tablesFound = routes.reduce((acc, r) => acc + r.tableIds.length, 0);
  const modalsFound = routes.reduce((acc, r) => acc + r.modalIds.length, 0);
  const wizardsFound = routes.reduce((acc, r) => acc + r.wizardIds.length, 0);

  // Per-playbook tally (ok/failed/suspicious).
  const playbooks: CoverageReport['playbooks'] = {};
  for (const o of playbookOutcomes) {
    if (!playbooks[o.playbookName]) {
      playbooks[o.playbookName] = { ok: 0, failed: 0, suspicious: 0 };
    }
    playbooks[o.playbookName][o.status] += 1;
  }

  // Per-agent depth: playbook-attempts and findings.
  const perAgent: CoverageReport['perAgent'] = {};
  for (const o of playbookOutcomes) {
    if (!perAgent[o.agentId]) perAgent[o.agentId] = { playbooks: 0, findings: 0 };
    perAgent[o.agentId].playbooks += 1;
  }
  for (const j of journeys) {
    if (!perAgent[j.agentId]) perAgent[j.agentId] = { playbooks: 0, findings: 0 };
    perAgent[j.agentId].findings += j.findings.length;
  }

  return {
    runId,
    generatedAt: new Date().toISOString(),
    sitemap: {
      routesDiscovered,
      routesVisited,
      routesByCrawler,
      routesByAgent,
      routes4xx,
      routes5xx,
    },
    forms: {
      found: formsFound,
      crudCreateAttempted: uniqueTargetsFor(playbookOutcomes, 'crud_create_form'),
      crudEditAttempted: uniqueTargetsFor(playbookOutcomes, 'crud_edit_first_row'),
      fuzzAttempted: uniqueTargetsFor(playbookOutcomes, 'form_fuzz_validation'),
    },
    tables: {
      found: tablesFound,
      sorted: uniqueTargetsFor(playbookOutcomes, 'table_sort_each_column'),
      paginated: uniqueTargetsFor(playbookOutcomes, 'table_paginate_walk'),
      filtered: uniqueTargetsFor(playbookOutcomes, 'table_filter_search'),
    },
    modals: {
      found: modalsFound,
      lifecycleTested: uniqueTargetsFor(playbookOutcomes, 'modal_lifecycle'),
    },
    wizards: {
      found: wizardsFound,
      walkthroughAttempted: uniqueTargetsFor(playbookOutcomes, 'wizard_full_walkthrough'),
    },
    playbooks,
    perAgent,
    primitiveActivity: inputs.primitiveActivity,
  };
}

export function renderCoverageMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`# Coverage — run ${report.runId}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  // Sitemap.
  lines.push('## Sitemap');
  lines.push(
    `- Routes discovered: ${report.sitemap.routesDiscovered} (crawler ${report.sitemap.routesByCrawler}, agents ${report.sitemap.routesByAgent})`,
  );
  lines.push(
    `- Routes visited:    ${report.sitemap.routesVisited} (${PCT(report.sitemap.routesVisited, report.sitemap.routesDiscovered)})`,
  );
  lines.push(
    `- Routes 4xx/5xx:     ${report.sitemap.routes4xx + report.sitemap.routes5xx} (4xx=${report.sitemap.routes4xx}, 5xx=${report.sitemap.routes5xx})`,
  );
  lines.push('');

  // Forms.
  lines.push('## Forms');
  lines.push(`- Found: ${report.forms.found}`);
  lines.push(
    `- crud_create attempted: ${report.forms.crudCreateAttempted} (${PCT(report.forms.crudCreateAttempted, report.forms.found)})`,
  );
  lines.push(
    `- crud_edit attempted:    ${report.forms.crudEditAttempted} (${PCT(report.forms.crudEditAttempted, report.forms.found)})`,
  );
  lines.push(
    `- form_fuzz attempted:    ${report.forms.fuzzAttempted} (${PCT(report.forms.fuzzAttempted, report.forms.found)})`,
  );
  lines.push('');

  // Tables.
  lines.push('## Tables');
  lines.push(`- Found: ${report.tables.found}`);
  lines.push(
    `- Sorted:    ${report.tables.sorted}/${report.tables.found} (${PCT(report.tables.sorted, report.tables.found)})`,
  );
  lines.push(
    `- Paginated: ${report.tables.paginated}/${report.tables.found} (${PCT(report.tables.paginated, report.tables.found)})`,
  );
  lines.push(
    `- Filtered:  ${report.tables.filtered}/${report.tables.found} (${PCT(report.tables.filtered, report.tables.found)})`,
  );
  lines.push('');

  // Modals.
  lines.push('## Modals');
  lines.push(`- Found:           ${report.modals.found}`);
  lines.push(
    `- Lifecycle tested: ${report.modals.lifecycleTested} (${PCT(report.modals.lifecycleTested, report.modals.found)})`,
  );
  lines.push('');

  // Wizards.
  lines.push('## Wizards');
  lines.push(`- Found: ${report.wizards.found}`);
  lines.push(
    `- Walkthrough attempted: ${report.wizards.walkthroughAttempted}/${report.wizards.found} (${PCT(report.wizards.walkthroughAttempted, report.wizards.found)})`,
  );
  lines.push('');

  // Playbooks.
  lines.push('## Playbooks executed');
  lines.push('');
  const playbookNames = Object.keys(report.playbooks).sort();
  if (playbookNames.length === 0) {
    lines.push('_No playbooks executed._');
  } else {
    lines.push('| playbook | ok | failed | suspicious |');
    lines.push('|---|---|---|---|');
    for (const name of playbookNames) {
      const s = report.playbooks[name];
      lines.push(`| ${name} | ${s.ok} | ${s.failed} | ${s.suspicious} |`);
    }
  }
  lines.push('');

  // Per-agent depth.
  lines.push('## Per-agent depth');
  lines.push('');
  const agents = Object.keys(report.perAgent).sort();
  if (agents.length === 0) {
    lines.push('_No agents recorded._');
  } else {
    lines.push('| agent | playbooks | findings |');
    lines.push('|---|---|---|');
    for (const id of agents) {
      const a = report.perAgent[id];
      lines.push(`| ${id} | ${a.playbooks} | ${a.findings} |`);
    }
  }
  lines.push('');

  // Primitive interactions — only present when the caller supplied them. This
  // is the honest "what actually happened" view; playbook-only stats hide
  // primitive-driven exploration (clicks, fill_forms, navigates).
  if (report.primitiveActivity && report.primitiveActivity.length > 0) {
    lines.push('## Primitive interactions (per agent)');
    lines.push('');
    lines.push('| agent | navigate | click | type | fill_form | report_finding |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of report.primitiveActivity) {
      lines.push(
        `| ${p.agentId} | ${p.navigate} | ${p.click} | ${p.type} | ${p.fillForm} | ${p.reportFinding} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Compute the coverage report and write it to `<runDir>/coverage.json` and
 * `<runDir>/coverage.md`. Returns the in-memory report for callers that want
 * to log or inspect it without re-reading from disk.
 */
export async function writeCoverageReport(
  runDir: string,
  inputs: CoverageInputs,
): Promise<CoverageReport> {
  const report = buildCoverageReport(inputs);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'coverage.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'coverage.md'), renderCoverageMarkdown(report), 'utf8');
  return report;
}
