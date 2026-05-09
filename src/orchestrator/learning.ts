/**
 * Cross-run learning — persistent per-target knowledge that improves accuracy
 * and efficiency across successive scans.
 *
 * Design constraint: ADDITIVE, not RESTRICTIVE.
 * - Known routes with forms → visit and test them (even if seen before)
 * - Known findings → check if fixed (regression detection)
 * - New routes → full exploratory testing, same as first run
 * - False positive patterns → suppress known non-bugs, but never suppress NEW findings
 *
 * Storage: ~/.lazy-qa/<sha1(targetUrl).slice(0,16)>/
 * Each file is optional — the system degrades gracefully to "first run" mode.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Logger } from '../logging/logger.ts';
import type { Finding } from '../types/finding.ts';
import type { ApplicationModel } from './app-model.ts';

export interface KnownFinding {
  id: string;
  title: string;
  route?: string;
  severity: string;
  category: string;
  status: 'open' | 'fixed' | 'wont-fix';
  firstSeenRunId: string;
  lastSeenRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FalsePositivePattern {
  titlePattern: string;
  route?: string;
  reason: string;
  addedAt: string;
}

export interface RouteSnapshot {
  route: string;
  formCount: number;
  tableCount: number;
  interactiveCount: number;
  pageModelHash: string;
}

export interface LearningState {
  targetUrl: string;
  lastUpdated: string;
  appModel?: ApplicationModel;
  knownFindings: KnownFinding[];
  falsePositivePatterns: FalsePositivePattern[];
  routeSnapshots: RouteSnapshot[];
}

function resolveLearningDir(targetUrl: string): string {
  const hash = createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
  return path.join(homedir(), '.lazy-qa', hash);
}

const LEARNING_FILE = 'learning-state.json';

export async function loadLearningState(
  targetUrl: string,
  logger: Logger,
): Promise<LearningState | null> {
  const dir = resolveLearningDir(targetUrl);
  const filePath = path.join(dir, LEARNING_FILE);
  try {
    const raw = await readFile(filePath, 'utf8');
    const state = JSON.parse(raw) as LearningState;
    // Defensive: ensure required arrays exist (guards against partial writes).
    state.knownFindings ??= [];
    state.falsePositivePatterns ??= [];
    state.routeSnapshots ??= [];
    logger.info('learning.loaded', {
      targetUrl: state.targetUrl,
      knownFindings: state.knownFindings.length,
      falsePositivePatterns: state.falsePositivePatterns.length,
      routeSnapshots: state.routeSnapshots.length,
    });
    return state;
  } catch (err) {
    // Distinguish "file not found" (normal first run) from "corrupted JSON"
    // (data loss worth warning about).
    const isNotFound =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      logger.info('learning.no-prior-state', { targetUrl });
    } else {
      logger.warn('learning.corrupted-state', {
        targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

export async function saveLearningState(
  targetUrl: string,
  state: LearningState,
  logger: Logger,
): Promise<void> {
  const dir = resolveLearningDir(targetUrl);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, LEARNING_FILE);
  state.lastUpdated = new Date().toISOString();
  // Atomic write: write to a .tmp sibling then rename, so a crash mid-write
  // never produces a truncated JSON file that corrupts cross-run state.
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, filePath);
  logger.info('learning.saved', {
    knownFindings: state.knownFindings.length,
    falsePositivePatterns: state.falsePositivePatterns.length,
    routeSnapshots: state.routeSnapshots.length,
  });
}

/**
 * Compare current crawl routes against prior snapshots to identify what changed.
 */
export function diffRoutes(
  currentRoutes: string[],
  priorSnapshots: RouteSnapshot[],
  currentPageHashes?: Record<string, string>,
): {
  newRoutes: string[];
  removedRoutes: string[];
  changedRoutes: string[];
  unchangedRoutes: string[];
} {
  const priorSet = new Set(priorSnapshots.map((s) => s.route));
  const currentSet = new Set(currentRoutes);

  const priorByRoute = new Map(priorSnapshots.map((s) => [s.route, s]));

  const newRoutes = currentRoutes.filter((r) => !priorSet.has(r));
  const removedRoutes = priorSnapshots.filter((s) => !currentSet.has(s.route)).map((s) => s.route);
  const changedRoutes: string[] = [];
  const unchangedRoutes: string[] = [];

  for (const r of currentRoutes) {
    const prior = priorByRoute.get(r);
    if (!prior) continue;
    if (currentPageHashes && currentPageHashes[r] && currentPageHashes[r] !== prior.pageModelHash) {
      changedRoutes.push(r);
    } else {
      unchangedRoutes.push(r);
    }
  }

  return { newRoutes, removedRoutes, changedRoutes, unchangedRoutes };
}

/**
 * Determine whether the app has changed significantly enough to regenerate
 * the Application Model. Threshold: >30% new routes.
 */
export function shouldRegenerateAppModel(
  currentRouteCount: number,
  diff: ReturnType<typeof diffRoutes>,
): boolean {
  if (currentRouteCount === 0) return true;
  return diff.newRoutes.length / currentRouteCount > 0.3;
}

/**
 * Build route snapshots from the current sitemap for persistence.
 */
export function buildRouteSnapshots(sitemap: {
  routes: Record<string, unknown>;
  pageModels: Record<
    string,
    { forms: unknown[]; tables: unknown[]; interactiveCount: number; textHash: string }
  >;
}): RouteSnapshot[] {
  const snapshots: RouteSnapshot[] = [];
  for (const route of Object.keys(sitemap.routes)) {
    const model = sitemap.pageModels[route];
    if (!model) continue;
    snapshots.push({
      route,
      formCount: model.forms.length,
      tableCount: model.tables.length,
      interactiveCount: model.interactiveCount,
      pageModelHash: model.textHash,
    });
  }
  return snapshots;
}

/**
 * Update known findings with results from the current run.
 * - New findings → add as 'open'
 * - Findings seen before → update lastSeen
 * - Prior findings NOT seen this run → mark 'fixed' (tentative — may need multiple runs)
 */
export function updateKnownFindings(
  prior: KnownFinding[],
  currentFindings: Finding[],
  runId: string,
): KnownFinding[] {
  const now = new Date().toISOString();
  const updated = prior.map((kf) => ({ ...kf }));
  const priorByKey = new Map(
    updated.map((kf) => [`${kf.route ?? ''}::${kf.title.toLowerCase().slice(0, 80)}`, kf]),
  );

  const seenKeys = new Set<string>();

  for (const f of currentFindings) {
    const key = `${f.route ?? ''}::${f.title.toLowerCase().slice(0, 80)}`;
    seenKeys.add(key);
    const existing = priorByKey.get(key);
    if (existing) {
      existing.lastSeenRunId = runId;
      existing.lastSeenAt = now;
      existing.status = 'open';
    } else {
      const newKf: KnownFinding = {
        id: f.id,
        title: f.title,
        route: f.route,
        severity: f.severity,
        category: f.category,
        status: 'open',
        firstSeenRunId: runId,
        lastSeenRunId: runId,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      updated.push(newKf);
      priorByKey.set(key, newKf);
    }
  }

  // Mark prior 'open' findings not seen this run as 'fixed'.
  for (const kf of updated) {
    if (kf.status !== 'open') continue;
    const key = `${kf.route ?? ''}::${kf.title.toLowerCase().slice(0, 80)}`;
    if (!seenKeys.has(key)) {
      kf.status = 'fixed';
    }
  }

  return updated;
}

/**
 * Update false positive patterns from review results.
 * When the critic classifies a finding as 'not_a_bug', extract a pattern
 * so future runs can suppress similar findings at filing time.
 */
export function extractFalsePositivePatterns(
  reviewClassifications: Array<{
    title: string;
    route?: string;
    classification: string;
    reasoning: string;
  }>,
): FalsePositivePattern[] {
  const now = new Date().toISOString();
  return reviewClassifications
    .filter((r) => r.classification === 'not_a_bug')
    .map((r) => ({
      titlePattern: r.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100),
      route: r.route,
      reason: r.reasoning.slice(0, 200),
      addedAt: now,
    }));
}

/**
 * Check if a finding matches any known false positive pattern.
 */
/** Hard cap on false-positive patterns to prevent unbounded growth across runs. */
const MAX_FP_PATTERNS = 500;

export function deduplicateFpPatterns(patterns: FalsePositivePattern[]): FalsePositivePattern[] {
  const seen = new Set<string>();
  const deduped = patterns.filter((p) => {
    const key = `${p.titlePattern}::${p.route ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Keep most recent patterns when over the cap.
  if (deduped.length > MAX_FP_PATTERNS) {
    return deduped.slice(deduped.length - MAX_FP_PATTERNS);
  }
  return deduped;
}

export function matchesFalsePositivePattern(
  finding: { title: string; route?: string },
  patterns: FalsePositivePattern[],
): FalsePositivePattern | null {
  const normTitle = finding.title.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const p of patterns) {
    const titleMatchesPattern = normTitle.includes(p.titlePattern);
    const patternMatchesTitle =
      normTitle.length >= 30 && p.titlePattern.includes(normTitle.slice(0, 60));
    if (titleMatchesPattern || patternMatchesTitle) {
      if (!p.route || p.route === finding.route) {
        return p;
      }
    }
  }
  return null;
}

/**
 * Render learning context for agent system prompts.
 * Tells agents what was found before and what to check for regression.
 */
export function renderLearningContext(
  state: LearningState,
  diff: ReturnType<typeof diffRoutes>,
): string {
  const lines: string[] = [];

  if (diff.newRoutes.length > 0) {
    lines.push(
      `CROSS-RUN CONTEXT — this app was tested before. ${diff.newRoutes.length} NEW routes discovered since last run:`,
    );
    for (const r of diff.newRoutes.slice(0, 10)) lines.push(`  NEW: ${r}`);
    if (diff.newRoutes.length > 10) lines.push(`  ... and ${diff.newRoutes.length - 10} more`);
    lines.push('Prioritise testing NEW routes — they have never been tested.');
  }

  const openFindings = state.knownFindings.filter((kf) => kf.status === 'open');
  if (openFindings.length > 0) {
    lines.push('');
    lines.push(`Known bugs from prior runs (${openFindings.length}) — check if these are FIXED:`);
    for (const kf of openFindings.slice(0, 8)) {
      lines.push(
        `  - [${kf.severity}] ${kf.title.slice(0, 80)}${kf.route ? ` @ ${kf.route}` : ''}`,
      );
    }
    lines.push('If a known bug is fixed, do NOT re-file it. Move on to finding NEW bugs.');
  }

  if (diff.removedRoutes.length > 0) {
    lines.push('');
    lines.push(
      `Routes removed since last run (${diff.removedRoutes.length}) — these pages no longer exist.`,
    );
  }

  return lines.length > 0 ? lines.join('\n') : '';
}
