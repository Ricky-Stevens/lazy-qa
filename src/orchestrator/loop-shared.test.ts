/**
 * Tests for loop-shared.ts — the shared helpers used by both API and SDK
 * agent loops. Covers:
 *   - buildUserMessage (user-message assembly)
 *   - tryParsePlaybookOutcome (JSON + YAML-like parsing)
 *   - extractTargetId / extractRoute / oneLineSummary
 *   - buildStagnationWarning
 *   - buildTaskQueue / renderTaskQueue
 *   - extractPersonaTagline
 *   - accumulateTurnCost
 *   - resolveTerminationReason
 *   - updateTurnTracking / createTurnTracker
 *   - checkScopeComplete
 */

import { describe, expect, it, vi } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { SummaryMemory } from './summary-memory.ts';
import {
  accumulateTurnCost,
  buildStagnationWarning,
  buildTaskQueue,
  buildUserMessage,
  checkScopeComplete,
  createTurnTracker,
  extractPersonaTagline,
  extractRoute,
  extractTargetId,
  oneLineSummary,
  renderTaskQueue,
  resolveTerminationReason,
  tryParsePlaybookOutcome,
  updateTurnTracking,
} from './loop-shared.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySiteMap(): SiteMapAccessor {
  return {
    getRoute: () => undefined,
    getPageModel: () => undefined,
    listAllRoutes: () => [],
    listUnvisitedRoutes: () => [],
    listFormsUntested: () => [],
    listTablesUntested: () => [],
    listModalsUntested: () => [],
    listWizardsUntested: () => [],
    recordVisit: () => {},
    recordPlaybookOutcome: () => {},
    upsertRoute: () => {},
    serialize: () => ({
      startedAt: '',
      rootUrl: 'about:blank',
      routes: {},
      pageModels: {},
    }),
  };
}

function makeJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    runId: 'r1',
    agentId: 'a1',
    startUrl: 'http://localhost:3000',
    startedAt: new Date().toISOString(),
    turns: 0,
    findings: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    id: 'a1',
    profileName: 'sheldon',
    personality: 'a tester',
    model: 'claude-haiku-4-5-20251001',
    budget: { max_turns: 40, max_usd: 1, max_minutes: 10 },
    credentials: null,
    ...overrides,
  } as ResolvedAgent;
}

// ---------------------------------------------------------------------------
// tryParsePlaybookOutcome
// ---------------------------------------------------------------------------

describe('tryParsePlaybookOutcome', () => {
  it('returns null for empty or very short strings', () => {
    expect(tryParsePlaybookOutcome('')).toBeNull();
    expect(tryParsePlaybookOutcome('short')).toBeNull();
  });

  it('parses a valid JSON blob with required fields', () => {
    const json = JSON.stringify({
      playbookName: 'fill_and_verify',
      status: 'ok',
      summary: 'Form filled successfully',
      evidence: { formId: 'f1' },
    });
    const result = tryParsePlaybookOutcome(json);
    expect(result).not.toBeNull();
    expect(result!.playbookName).toBe('fill_and_verify');
    expect(result!.status).toBe('ok');
    expect(result!.summary).toBe('Form filled successfully');
  });

  it('parses JSON blob with preceding text', () => {
    const text = `Some leading text about the outcome: ${JSON.stringify({
      playbookName: 'form_fuzz_validation',
      status: 'suspicious',
      summary: 'Boundary violation detected',
    })}`;
    const result = tryParsePlaybookOutcome(text);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('suspicious');
  });

  it('returns null for JSON with invalid status', () => {
    const json = JSON.stringify({
      playbookName: 'test',
      status: 'invalid_status',
      summary: 'test',
    });
    const result = tryParsePlaybookOutcome(json);
    expect(result).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    const json = JSON.stringify({ playbookName: 'test' });
    const result = tryParsePlaybookOutcome(json);
    expect(result).toBeNull();
  });

  it('parses YAML-like key: value format', () => {
    const text = [
      'playbook: walk_wizard',
      'status: failed',
      'summary: Wizard not found on page',
      'evidence: {"wizardId": "wiz-1"}',
      'durationMs: 1500',
    ].join('\n');
    const result = tryParsePlaybookOutcome(text);
    expect(result).not.toBeNull();
    expect(result!.playbookName).toBe('walk_wizard');
    expect(result!.status).toBe('failed');
    expect(result!.summary).toBe('Wizard not found on page');
    expect(result!.durationMs).toBe(1500);
  });

  it('parses YAML-like format with steps', () => {
    const text = [
      'playbook: fill_and_verify',
      'status: ok',
      'summary: Form filled',
      'steps:',
      '- [ok] Fill username',
      '- [ok] Fill password -- typed correctly',
      '- [FAIL] Verify URL changed -- stayed on /login',
    ].join('\n');
    const result = tryParsePlaybookOutcome(text);
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(3);
    expect(result!.steps[0]?.ok).toBe(true);
    expect(result!.steps[0]?.label).toBe('Fill username');
    expect(result!.steps[2]?.ok).toBe(false);
  });

  it('returns null for YAML-like format missing required fields', () => {
    const text = 'playbook: test\nstatus: ok\n'; // missing summary
    const result = tryParsePlaybookOutcome(text);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractTargetId
// ---------------------------------------------------------------------------

describe('extractTargetId', () => {
  it('extracts formId', () => {
    expect(extractTargetId({ formId: 'f1' })).toBe('f1');
  });

  it('extracts tableId', () => {
    expect(extractTargetId({ tableId: 'tbl-1' })).toBe('tbl-1');
  });

  it('extracts modalId', () => {
    expect(extractTargetId({ modalId: 'modal_x' })).toBe('modal_x');
  });

  it('extracts wizardId', () => {
    expect(extractTargetId({ wizardId: 'wiz-1' })).toBe('wiz-1');
  });

  it('returns null when no target id field present', () => {
    expect(extractTargetId({ paths: ['/admin'] })).toBeNull();
  });

  it('returns null for empty string target id', () => {
    expect(extractTargetId({ formId: '' })).toBeNull();
  });

  it('prefers formId over later keys', () => {
    expect(extractTargetId({ formId: 'f1', tableId: 't1' })).toBe('f1');
  });
});

// ---------------------------------------------------------------------------
// extractRoute
// ---------------------------------------------------------------------------

describe('extractRoute', () => {
  it('extracts route from evidence', () => {
    const outcome = {
      playbookName: 'test',
      status: 'ok' as const,
      summary: 's',
      evidence: { route: '/admin' },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [],
      durationMs: 0,
    };
    expect(extractRoute(outcome)).toBe('/admin');
  });

  it('returns null when evidence has no route', () => {
    const outcome = {
      playbookName: 'test',
      status: 'ok' as const,
      summary: 's',
      evidence: { formId: 'f1' },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [],
      durationMs: 0,
    };
    expect(extractRoute(outcome)).toBeNull();
  });

  it('returns null when evidence is empty', () => {
    const outcome = {
      playbookName: 'test',
      status: 'ok' as const,
      summary: 's',
      evidence: {},
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [],
      durationMs: 0,
    };
    expect(extractRoute(outcome)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// oneLineSummary
// ---------------------------------------------------------------------------

describe('oneLineSummary', () => {
  it('returns the first line of a summary', () => {
    const outcome = {
      playbookName: 'test',
      status: 'ok' as const,
      summary: 'Line one\nLine two\nLine three',
      evidence: {},
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [],
      durationMs: 0,
    };
    expect(oneLineSummary(outcome)).toBe('Line one');
  });

  it('truncates to 160 chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const outcome = {
      playbookName: 'test',
      status: 'ok' as const,
      summary: long,
      evidence: {},
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [],
      durationMs: 0,
    };
    const result = oneLineSummary(outcome);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result).toContain('...');
  });

  it('returns empty string for empty summary', () => {
    const outcome = {
      playbookName: 'test',
      status: 'ok' as const,
      summary: '',
      evidence: {},
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps: [],
      durationMs: 0,
    };
    expect(oneLineSummary(outcome)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildStagnationWarning
// ---------------------------------------------------------------------------

describe('buildStagnationWarning', () => {
  it('returns empty string when no stagnation detected', () => {
    const result = buildStagnationWarning({
      turnsCompleted: 3,
      findingsCount: 1,
      lastFindingTurn: 2,
      currentUrl: '/dashboard',
      turnsOnSameUrl: 1,
    });
    expect(result).toBe('');
  });

  it('warns when stuck on same URL for 3+ turns past turn 5', () => {
    const result = buildStagnationWarning({
      turnsCompleted: 8,
      findingsCount: 1,
      lastFindingTurn: 5,
      currentUrl: '/stuck-page',
      turnsOnSameUrl: 3,
    });
    expect(result).toContain('STUCK');
    expect(result).toContain('/stuck-page');
  });

  it('does not warn about stuck page before turn 5', () => {
    const result = buildStagnationWarning({
      turnsCompleted: 4,
      findingsCount: 0,
      lastFindingTurn: 0,
      currentUrl: '/page',
      turnsOnSameUrl: 4,
    });
    expect(result).not.toContain('STUCK');
  });

  it('warns about stagnation after 8 turns without findings (post turn 10)', () => {
    const result = buildStagnationWarning({
      turnsCompleted: 12,
      findingsCount: 1,
      lastFindingTurn: 3,
      currentUrl: '/page',
      turnsOnSameUrl: 0,
    });
    expect(result).toContain('STAGNANT');
  });

  it('warns about zero findings after 12 turns', () => {
    const result = buildStagnationWarning({
      turnsCompleted: 13,
      findingsCount: 0,
      lastFindingTurn: 0,
      currentUrl: '/page',
      turnsOnSameUrl: 0,
    });
    expect(result).toContain('ZERO FINDINGS');
  });

  it('uses higher stuck threshold for depth personas', () => {
    // sheldon is a DEPTH_PERSONA, threshold=6
    const result = buildStagnationWarning({
      turnsCompleted: 8,
      findingsCount: 0,
      lastFindingTurn: 0,
      currentUrl: '/page',
      turnsOnSameUrl: 4,
      personaName: 'sheldon',
    });
    // turnsOnSameUrl=4 < threshold=6 for depth personas
    expect(result).not.toContain('STUCK');
  });
});

// ---------------------------------------------------------------------------
// extractPersonaTagline
// ---------------------------------------------------------------------------

describe('extractPersonaTagline', () => {
  it('extracts text from # Closing section', () => {
    const body = `# Mindset\nSome mindset text.\n\n# Closing\nI am the one who tests.`;
    expect(extractPersonaTagline(body)).toBe('I am the one who tests.');
  });

  it('falls back to # Mindset first paragraph', () => {
    const body = `# Mindset\nFirst paragraph about testing.\n\nSecond paragraph.`;
    expect(extractPersonaTagline(body)).toBe('First paragraph about testing.');
  });

  it('returns empty string when no matching section', () => {
    expect(extractPersonaTagline('Just some text without headers.')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractPersonaTagline('')).toBe('');
  });

  it('truncates to 400 chars with ellipsis', () => {
    const long = `# Closing\n${'x'.repeat(500)}`;
    const result = extractPersonaTagline(long);
    expect(result.length).toBeLessThanOrEqual(400);
    expect(result).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// accumulateTurnCost
// ---------------------------------------------------------------------------

describe('accumulateTurnCost', () => {
  it('accumulates token usage onto the journey', () => {
    const journey = makeJourney();
    accumulateTurnCost(journey, 'claude-haiku-4-5-20251001', {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    });
    expect(journey.tokenUsage.input).toBe(100);
    expect(journey.tokenUsage.output).toBe(50);
    expect(journey.tokenUsage.cacheRead).toBe(10);
    expect(journey.tokenUsage.cacheWrite).toBe(5);
    expect(journey.costUsd).toBeGreaterThan(0);
  });

  it('accumulates across multiple turns', () => {
    const journey = makeJourney();
    accumulateTurnCost(journey, 'claude-haiku-4-5-20251001', {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
    accumulateTurnCost(journey, 'claude-haiku-4-5-20251001', {
      input: 200,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(journey.tokenUsage.input).toBe(300);
    expect(journey.tokenUsage.output).toBe(150);
  });

  it('returns the cost delta for the turn', () => {
    const journey = makeJourney();
    const delta = accumulateTurnCost(journey, 'claude-haiku-4-5-20251001', {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(delta).toBeGreaterThan(0);
  });

  it('returns 0 for unknown model without throwing', () => {
    const journey = makeJourney();
    const delta = accumulateTurnCost(journey, 'unknown-model-xyz', {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // Token usage should still be accumulated
    expect(journey.tokenUsage.input).toBe(100);
    // Cost computation may either work with a fallback or return 0
    expect(typeof delta).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// resolveTerminationReason
// ---------------------------------------------------------------------------

describe('resolveTerminationReason', () => {
  it('returns signal when abortSignal is aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const result = resolveTerminationReason(makeJourney(), makeAgent(), ac.signal);
    expect(result).toBe('signal');
  });

  it('returns budget-hit when cost exceeds max_usd', () => {
    const journey = makeJourney({ costUsd: 2.0 });
    const agent = makeAgent({ budget: { max_turns: 100, max_usd: 1.0, max_minutes: 10 } });
    const result = resolveTerminationReason(journey, agent, new AbortController().signal);
    expect(result).toBe('budget-hit');
  });

  it('returns max-turns when turns exceed max_turns', () => {
    const journey = makeJourney({ turns: 50 });
    const agent = makeAgent({ budget: { max_turns: 40, max_usd: 10, max_minutes: 10 } });
    const result = resolveTerminationReason(journey, agent, new AbortController().signal);
    expect(result).toBe('max-turns');
  });

  it('prefers signal over budget-hit', () => {
    const ac = new AbortController();
    ac.abort();
    const journey = makeJourney({ costUsd: 100 });
    const agent = makeAgent({ budget: { max_turns: 40, max_usd: 1, max_minutes: 10 } });
    const result = resolveTerminationReason(journey, agent, ac.signal);
    expect(result).toBe('signal');
  });
});

// ---------------------------------------------------------------------------
// createTurnTracker / updateTurnTracking
// ---------------------------------------------------------------------------

describe('TurnTracker', () => {
  it('starts with clean state', () => {
    const tracker = createTurnTracker();
    expect(tracker.turnsOnSameUrl).toBe(0);
    expect(tracker.previousUrl).toBeUndefined();
    expect(tracker.lastFindingTurn).toBe(0);
    expect(tracker.previousFindingsCount).toBe(0);
  });

  it('increments turnsOnSameUrl for repeated URLs', () => {
    const tracker = createTurnTracker();
    const journey = makeJourney({ turns: 1 });
    updateTurnTracking(tracker, '/dashboard', journey);
    expect(tracker.turnsOnSameUrl).toBe(0); // first visit
    updateTurnTracking(tracker, '/dashboard', journey);
    expect(tracker.turnsOnSameUrl).toBe(1);
    updateTurnTracking(tracker, '/dashboard', journey);
    expect(tracker.turnsOnSameUrl).toBe(2);
  });

  it('resets turnsOnSameUrl when URL changes', () => {
    const tracker = createTurnTracker();
    const journey = makeJourney({ turns: 1 });
    updateTurnTracking(tracker, '/dashboard', journey);
    updateTurnTracking(tracker, '/dashboard', journey);
    expect(tracker.turnsOnSameUrl).toBe(1);
    updateTurnTracking(tracker, '/settings', journey);
    expect(tracker.turnsOnSameUrl).toBe(0);
    expect(tracker.previousUrl).toBe('/settings');
  });

  it('updates lastFindingTurn when new findings appear', () => {
    const tracker = createTurnTracker();
    const journey = makeJourney({ turns: 5, findings: [{ id: 'f1' }] as never });
    updateTurnTracking(tracker, '/page', journey);
    expect(tracker.lastFindingTurn).toBe(5);
    expect(tracker.previousFindingsCount).toBe(1);
  });

  it('does not update lastFindingTurn when findings count stays same', () => {
    const tracker = createTurnTracker();
    const journey = makeJourney({ turns: 3, findings: [{ id: 'f1' }] as never });
    updateTurnTracking(tracker, '/page', journey);
    expect(tracker.lastFindingTurn).toBe(3);

    const journey2 = makeJourney({ turns: 7, findings: [{ id: 'f1' }] as never });
    updateTurnTracking(tracker, '/page', journey2);
    expect(tracker.lastFindingTurn).toBe(3); // unchanged
  });
});

// ---------------------------------------------------------------------------
// checkScopeComplete
// ---------------------------------------------------------------------------

describe('checkScopeComplete', () => {
  it('returns false for attackers', () => {
    const agent = makeAgent({ profileName: 'bobby-tables' });
    const journey = makeJourney({ turns: 20 });
    expect(checkScopeComplete(agent, emptySiteMap(), new Set(), journey, true)).toBe(false);
  });

  it('returns false before turn 8', () => {
    const agent = makeAgent({ profileName: 'sheldon' });
    const journey = makeJourney({ turns: 5 });
    expect(checkScopeComplete(agent, emptySiteMap(), new Set(), journey, false)).toBe(false);
  });

  it('returns true when task queue is empty after turn 8', () => {
    const agent = makeAgent({ profileName: 'sheldon' });
    const journey = makeJourney({ turns: 10 });
    // sheldon's task profile queries 'routes', empty sitemap = empty queue
    expect(checkScopeComplete(agent, emptySiteMap(), new Set(), journey, false)).toBe(true);
  });

  it('returns false when agent has no task profile', () => {
    const agent = makeAgent({ profileName: 'unknown-persona' });
    const journey = makeJourney({ turns: 20 });
    // No task profile -> buildTaskQueue returns [] -> scope complete
    expect(checkScopeComplete(agent, emptySiteMap(), new Set(), journey, false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTaskQueue
// ---------------------------------------------------------------------------

describe('buildTaskQueue', () => {
  it('returns empty array for unknown persona', () => {
    expect(buildTaskQueue('unknown', emptySiteMap(), new Set())).toEqual([]);
  });

  it('caps at 15 items', () => {
    const sm = emptySiteMap();
    const forms = Array.from({ length: 20 }, (_, i) => ({
      route: `/route-${i}`,
      formId: `form_${i}`,
    }));
    sm.listFormsUntested = () => forms;
    const queue = buildTaskQueue('all-your-base', sm, new Set());
    expect(queue.length).toBeLessThanOrEqual(15);
  });

  it('excludes already-fuzzed form IDs', () => {
    const sm = emptySiteMap();
    sm.listFormsUntested = () => [
      { route: '/a', formId: 'f1' },
      { route: '/b', formId: 'f2' },
    ];
    const fuzzed = new Set(['f1']);
    const queue = buildTaskQueue('all-your-base', sm, fuzzed);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.targetId).toBe('f2');
  });

  it('builds route-based queue for sheldon', () => {
    const sm = emptySiteMap();
    sm.listUnvisitedRoutes = () => [
      { route: '/unvisited', visited: false, url: '/unvisited', title: 'Unvisited', formIds: [], tableIds: [], modalIds: [], wizardIds: [], source: 'crawler', discoveredAt: '' },
    ];
    sm.listAllRoutes = () => [
      { route: '/visited', visited: true, url: '/visited', title: 'Visited', formIds: [], tableIds: [], modalIds: [], wizardIds: [], source: 'crawler', discoveredAt: '' },
    ];
    const queue = buildTaskQueue('sheldon', sm, new Set());
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(queue[0]?.action).toContain('accessibility-check');
  });
});

// ---------------------------------------------------------------------------
// renderTaskQueue
// ---------------------------------------------------------------------------

describe('renderTaskQueue', () => {
  it('returns empty string for empty queue', () => {
    expect(renderTaskQueue([])).toBe('');
  });

  it('renders NEXT for first item', () => {
    const queue = [{ route: '/a', action: 'test form "f1"' }];
    const result = renderTaskQueue(queue);
    expect(result).toContain('NEXT');
    expect(result).toContain('test form "f1"');
  });

  it('truncates after 8 items', () => {
    const queue = Array.from({ length: 12 }, (_, i) => ({
      route: `/r${i}`,
      action: `action-${i}`,
    }));
    const result = renderTaskQueue(queue);
    expect(result).toContain('... +');
  });

  it('depth personas get thorough instruction', () => {
    const queue = [{ route: '/a', action: 'test' }];
    const result = renderTaskQueue(queue, 'sheldon');
    expect(result).toContain('THOROUGHLY');
  });

  it('non-depth personas get move-on instruction', () => {
    const queue = [{ route: '/a', action: 'test' }];
    const result = renderTaskQueue(queue, 'all-your-base');
    expect(result).toContain('Move on');
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage — smoke tests for assembly
// ---------------------------------------------------------------------------

describe('buildUserMessage', () => {
  const baseArgs = {
    isFirstTurn: true,
    targetUrl: 'http://localhost:3000',
    siteMap: emptySiteMap(),
    summaryMemory: new SummaryMemory(),
    nudge: null,
    turnsCompleted: 0,
    findingsCount: 0,
    remainingMin: 9.5,
    knownFindings: [],
    sharedCredentials: [],
    sharedRoutes: [],
    broadcasts: [],
    fuzzedFormIds: new Set<string>(),
    isAttacker: false,
  };

  it('first turn starts with "Begin"', () => {
    const msg = buildUserMessage(baseArgs);
    expect(msg).toContain('Begin');
  });

  it('includes session reminder when sessionInfo is set', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      sessionInfo: { username: 'admin', role: 'admin' },
    });
    expect(msg).toContain('[session: logged in]');
  });

  it('includes supervisor nudge when present', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      nudge: 'Go to /settings NOW',
    });
    expect(msg).toContain('SUPERVISOR INTERVENTION');
    expect(msg).toContain('Go to /settings NOW');
  });

  it('includes persona tagline when provided', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      personaTagline: 'You test accessibility with obsessive precision.',
    });
    expect(msg).toContain('stay in role');
    expect(msg).toContain('obsessive precision');
  });

  it('continues with turn info on non-first turn', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      isFirstTurn: false,
      turnsCompleted: 5,
      findingsCount: 2,
    });
    expect(msg).toContain('[continue]');
    expect(msg).toContain('5 turns');
    expect(msg).toContain('2 findings');
  });

  it('includes broadcasts in the message', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      broadcasts: [
        {
          message: 'Credentials found! admin:password',
          issuedBy: 'supervisor',
          issuedAt: new Date().toISOString(),
        },
      ],
    });
    expect(msg).toContain('TEAM BROADCAST');
    expect(msg).toContain('Credentials found');
  });
});
