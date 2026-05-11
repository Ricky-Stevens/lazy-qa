/**
 * Tests for learning.ts — cross-run learning state management.
 *
 * Covers:
 *   - diffRoutes
 *   - shouldRegenerateAppModel
 *   - buildRouteSnapshots
 *   - updateKnownFindings
 *   - extractFalsePositivePatterns
 *   - matchesFalsePositivePattern
 *   - deduplicateFpPatterns
 *   - renderLearningContext
 */

import { describe, expect, it } from 'vitest';
import type { Finding } from '../types/finding.ts';
import {
  buildRouteSnapshots,
  deduplicateFpPatterns,
  diffRoutes,
  extractFalsePositivePatterns,
  type FalsePositivePattern,
  type KnownFinding,
  type LearningState,
  matchesFalsePositivePattern,
  renderLearningContext,
  type RouteSnapshot,
  shouldRegenerateAppModel,
  updateKnownFindings,
} from './learning.ts';

// ---------------------------------------------------------------------------
// diffRoutes
// ---------------------------------------------------------------------------

describe('diffRoutes', () => {
  const priorSnapshots: RouteSnapshot[] = [
    { route: '/dashboard', formCount: 1, tableCount: 0, interactiveCount: 5, pageModelHash: 'h1' },
    { route: '/settings', formCount: 2, tableCount: 0, interactiveCount: 8, pageModelHash: 'h2' },
    { route: '/users', formCount: 0, tableCount: 1, interactiveCount: 3, pageModelHash: 'h3' },
  ];

  it('identifies new routes', () => {
    const current = ['/dashboard', '/settings', '/users', '/reports'];
    const diff = diffRoutes(current, priorSnapshots);
    expect(diff.newRoutes).toEqual(['/reports']);
  });

  it('identifies removed routes', () => {
    const current = ['/dashboard', '/settings'];
    const diff = diffRoutes(current, priorSnapshots);
    expect(diff.removedRoutes).toEqual(['/users']);
  });

  it('identifies changed routes when page hashes differ', () => {
    const current = ['/dashboard', '/settings', '/users'];
    const hashes = { '/dashboard': 'h1', '/settings': 'CHANGED', '/users': 'h3' };
    const diff = diffRoutes(current, priorSnapshots, hashes);
    expect(diff.changedRoutes).toEqual(['/settings']);
    expect(diff.unchangedRoutes).toContain('/dashboard');
    expect(diff.unchangedRoutes).toContain('/users');
  });

  it('treats all routes as unchanged when no hashes provided', () => {
    const current = ['/dashboard', '/settings', '/users'];
    const diff = diffRoutes(current, priorSnapshots);
    expect(diff.unchangedRoutes).toHaveLength(3);
    expect(diff.changedRoutes).toHaveLength(0);
  });

  it('handles empty current routes', () => {
    const diff = diffRoutes([], priorSnapshots);
    expect(diff.newRoutes).toHaveLength(0);
    expect(diff.removedRoutes).toHaveLength(3);
  });

  it('handles empty prior snapshots', () => {
    const diff = diffRoutes(['/a', '/b'], []);
    expect(diff.newRoutes).toEqual(['/a', '/b']);
    expect(diff.removedRoutes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shouldRegenerateAppModel
// ---------------------------------------------------------------------------

describe('shouldRegenerateAppModel', () => {
  it('returns true when >30% of routes are new', () => {
    const diff = {
      newRoutes: ['/a', '/b', '/c', '/d'],
      removedRoutes: [],
      changedRoutes: [],
      unchangedRoutes: Array.from({ length: 6 }, (_, i) => `/old-${i}`),
    };
    // 4 new / 10 total = 40% > 30%
    expect(shouldRegenerateAppModel(10, diff)).toBe(true);
  });

  it('returns false when <=30% of routes are new', () => {
    const diff = {
      newRoutes: ['/a'],
      removedRoutes: [],
      changedRoutes: [],
      unchangedRoutes: Array.from({ length: 9 }, (_, i) => `/old-${i}`),
    };
    // 1 new / 10 total = 10% < 30%
    expect(shouldRegenerateAppModel(10, diff)).toBe(false);
  });

  it('returns true when current route count is 0', () => {
    const diff = { newRoutes: [], removedRoutes: [], changedRoutes: [], unchangedRoutes: [] };
    expect(shouldRegenerateAppModel(0, diff)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRouteSnapshots
// ---------------------------------------------------------------------------

describe('buildRouteSnapshots', () => {
  it('builds snapshots from sitemap', () => {
    const sitemap = {
      routes: { '/a': {}, '/b': {} },
      pageModels: {
        '/a': { forms: [1, 2], tables: [1], interactiveCount: 10, textHash: 'abc' },
        '/b': { forms: [], tables: [], interactiveCount: 2, textHash: 'def' },
      } as never,
    };
    const snaps = buildRouteSnapshots(sitemap);
    expect(snaps).toHaveLength(2);
    const a = snaps.find((s) => s.route === '/a');
    expect(a?.formCount).toBe(2);
    expect(a?.tableCount).toBe(1);
    expect(a?.interactiveCount).toBe(10);
    expect(a?.pageModelHash).toBe('abc');
  });

  it('skips routes without page models', () => {
    const sitemap = {
      routes: { '/a': {}, '/b': {} },
      pageModels: {
        '/a': { forms: [], tables: [], interactiveCount: 0, textHash: 'x' },
      } as never,
    };
    const snaps = buildRouteSnapshots(sitemap);
    expect(snaps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateKnownFindings
// ---------------------------------------------------------------------------

describe('updateKnownFindings', () => {
  function makeFinding(title: string, route?: string): Finding {
    return {
      id: `f-${Math.random().toString(36).slice(2)}`,
      ts: new Date().toISOString(),
      severity: 'major',
      category: 'broken-feature',
      title,
      description: 'desc',
      stepsToReproduce: ['step'],
      expected: 'e',
      actual: 'a',
      confidence: 'likely',
      source: 'agent',
      route,
    };
  }

  function makeKnown(title: string, route?: string): KnownFinding {
    return {
      id: 'kf-1',
      title,
      route,
      severity: 'major',
      category: 'broken-feature',
      status: 'open',
      firstSeenRunId: 'run-0',
      lastSeenRunId: 'run-0',
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
    };
  }

  it('adds new findings as open', () => {
    const result = updateKnownFindings([], [makeFinding('New bug', '/login')], 'run-1');
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('open');
    expect(result[0]?.firstSeenRunId).toBe('run-1');
  });

  it('updates lastSeen for existing findings', () => {
    const prior = [makeKnown('Existing bug', '/login')];
    const current = [makeFinding('Existing bug', '/login')];
    const result = updateKnownFindings(prior, current, 'run-2');
    expect(result).toHaveLength(1);
    expect(result[0]?.lastSeenRunId).toBe('run-2');
    expect(result[0]?.status).toBe('open');
    expect(result[0]?.firstSeenRunId).toBe('run-0'); // preserved
  });

  it('marks unseen prior findings as fixed', () => {
    const prior = [makeKnown('Fixed bug', '/login')];
    const result = updateKnownFindings(prior, [], 'run-3');
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('fixed');
  });

  it('does not mark wont-fix findings as fixed', () => {
    const prior = [{ ...makeKnown('Wontfix bug'), status: 'wont-fix' as const }];
    const result = updateKnownFindings(prior, [], 'run-4');
    expect(result[0]?.status).toBe('wont-fix');
  });

  it('re-opens fixed findings when seen again', () => {
    const prior = [{ ...makeKnown('Was fixed', '/page'), status: 'fixed' as const }];
    const current = [makeFinding('Was fixed', '/page')];
    const result = updateKnownFindings(prior, current, 'run-5');
    expect(result[0]?.status).toBe('open');
  });

  it('does not create duplicates for findings on the same route with same title', () => {
    const prior = [makeKnown('Bug A', '/login')];
    const current = [makeFinding('Bug A', '/login')];
    const result = updateKnownFindings(prior, current, 'run-6');
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extractFalsePositivePatterns
// ---------------------------------------------------------------------------

describe('extractFalsePositivePatterns', () => {
  it('extracts patterns from not_a_bug classifications', () => {
    const classifications = [
      { title: 'Cookie Banner Appears', route: '/login', classification: 'not_a_bug', reasoning: 'Expected behavior' },
      { title: 'Real Bug', route: '/api', classification: 'confirmed_bug', reasoning: 'Verified' },
    ];
    const patterns = extractFalsePositivePatterns(classifications);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.titlePattern).toBe('cookie banner appears');
    expect(patterns[0]?.reason).toBe('Expected behavior');
  });

  it('normalises whitespace in title pattern', () => {
    const classifications = [
      { title: 'Multiple    Spaces   Here', classification: 'not_a_bug', reasoning: 'ok' },
    ];
    const patterns = extractFalsePositivePatterns(classifications);
    expect(patterns[0]?.titlePattern).toBe('multiple spaces here');
  });

  it('returns empty array when no not_a_bug classifications', () => {
    const classifications = [
      { title: 'Bug', classification: 'confirmed_bug', reasoning: 'yes' },
    ];
    expect(extractFalsePositivePatterns(classifications)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchesFalsePositivePattern
// ---------------------------------------------------------------------------

describe('matchesFalsePositivePattern', () => {
  it('matches when title contains the pattern', () => {
    const patterns: FalsePositivePattern[] = [
      { titlePattern: 'cookie consent banner', reason: 'Expected', addedAt: '' },
    ];
    const match = matchesFalsePositivePattern(
      { title: 'Cookie consent banner appears on every page' },
      patterns,
    );
    expect(match).not.toBeNull();
  });

  it('returns null when no pattern matches', () => {
    const patterns: FalsePositivePattern[] = [
      { titlePattern: 'cookie consent', reason: 'FP', addedAt: '' },
    ];
    const match = matchesFalsePositivePattern(
      { title: 'SQL injection in search' },
      patterns,
    );
    expect(match).toBeNull();
  });

  it('respects route filter', () => {
    const patterns: FalsePositivePattern[] = [
      { titlePattern: 'error message', route: '/login', reason: 'Expected on login', addedAt: '' },
    ];
    expect(
      matchesFalsePositivePattern({ title: 'Error message shown', route: '/login' }, patterns),
    ).not.toBeNull();
    expect(
      matchesFalsePositivePattern({ title: 'Error message shown', route: '/register' }, patterns),
    ).toBeNull();
  });

  it('matches when pattern is subset of title (reverse containment for long titles)', () => {
    const patterns: FalsePositivePattern[] = [
      {
        titlePattern: 'this is a very specific pattern that should match the general title about specific pattern matching in the application',
        reason: 'FP',
        addedAt: '',
      },
    ];
    // The title is shorter than the pattern but at least 30 chars, and the first
    // 60 chars of the title are contained in the pattern.
    const match = matchesFalsePositivePattern(
      { title: 'this is a very specific pattern that should match the general title' },
      patterns,
    );
    expect(match).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deduplicateFpPatterns
// ---------------------------------------------------------------------------

describe('deduplicateFpPatterns', () => {
  it('removes exact duplicates', () => {
    const patterns: FalsePositivePattern[] = [
      { titlePattern: 'same', reason: 'r1', addedAt: '2026-01-01' },
      { titlePattern: 'same', reason: 'r2', addedAt: '2026-01-02' },
    ];
    const result = deduplicateFpPatterns(patterns);
    expect(result).toHaveLength(1);
  });

  it('keeps patterns with different routes', () => {
    const patterns: FalsePositivePattern[] = [
      { titlePattern: 'same', route: '/a', reason: 'r1', addedAt: '' },
      { titlePattern: 'same', route: '/b', reason: 'r2', addedAt: '' },
    ];
    const result = deduplicateFpPatterns(patterns);
    expect(result).toHaveLength(2);
  });

  it('caps at 500 entries (keeping most recent)', () => {
    const patterns: FalsePositivePattern[] = Array.from({ length: 600 }, (_, i) => ({
      titlePattern: `pattern-${i}`,
      reason: 'r',
      addedAt: `2026-01-${String(i).padStart(3, '0')}`,
    }));
    const result = deduplicateFpPatterns(patterns);
    expect(result).toHaveLength(500);
    // Should keep the LAST 500 (most recent)
    expect(result[0]?.titlePattern).toBe('pattern-100');
  });
});

// ---------------------------------------------------------------------------
// renderLearningContext
// ---------------------------------------------------------------------------

describe('renderLearningContext', () => {
  function makeState(overrides: Partial<LearningState> = {}): LearningState {
    return {
      targetUrl: 'http://localhost:3000',
      lastUpdated: new Date().toISOString(),
      knownFindings: [],
      falsePositivePatterns: [],
      routeSnapshots: [],
      ...overrides,
    };
  }

  it('renders new routes section', () => {
    const diff = {
      newRoutes: ['/new-page-1', '/new-page-2'],
      removedRoutes: [],
      changedRoutes: [],
      unchangedRoutes: ['/old-page'],
    };
    const result = renderLearningContext(makeState(), diff);
    expect(result).toContain('NEW routes');
    expect(result).toContain('/new-page-1');
    expect(result).toContain('Prioritise testing NEW routes');
  });

  it('renders known open findings for regression checking', () => {
    const state = makeState({
      knownFindings: [
        {
          id: 'kf-1',
          title: 'Save button broken',
          route: '/admin',
          severity: 'major',
          category: 'broken-feature',
          status: 'open',
          firstSeenRunId: 'r1',
          lastSeenRunId: 'r1',
          firstSeenAt: '',
          lastSeenAt: '',
        },
      ],
    });
    const diff = { newRoutes: [], removedRoutes: [], changedRoutes: [], unchangedRoutes: ['/admin'] };
    const result = renderLearningContext(state, diff);
    expect(result).toContain('Known bugs from prior runs');
    expect(result).toContain('Save button broken');
    expect(result).toContain('check if these are FIXED');
  });

  it('renders removed routes section', () => {
    const diff = {
      newRoutes: [],
      removedRoutes: ['/deleted-page'],
      changedRoutes: [],
      unchangedRoutes: [],
    };
    const result = renderLearningContext(makeState(), diff);
    expect(result).toContain('Routes removed since last run');
  });

  it('returns empty string when nothing to report', () => {
    const diff = { newRoutes: [], removedRoutes: [], changedRoutes: [], unchangedRoutes: ['/a'] };
    const result = renderLearningContext(makeState(), diff);
    expect(result).toBe('');
  });

  it('caps new routes listing at 10', () => {
    const diff = {
      newRoutes: Array.from({ length: 15 }, (_, i) => `/new-${i}`),
      removedRoutes: [],
      changedRoutes: [],
      unchangedRoutes: [],
    };
    const result = renderLearningContext(makeState(), diff);
    expect(result).toContain('and 5 more');
  });
});
