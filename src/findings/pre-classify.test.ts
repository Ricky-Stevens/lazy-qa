import { describe, expect, it } from 'vitest';
import type { Finding } from '../types/finding.ts';
import { preClassifyFinding } from './pre-classify.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    ts: new Date().toISOString(),
    severity: 'major',
    category: 'broken-feature',
    title: 'Test finding',
    description: 'A test finding',
    stepsToReproduce: ['Step 1'],
    expected: 'Expected',
    actual: 'Actual',
    confidence: 'likely',
    source: 'agent',
    ...overrides,
  };
}

describe('preClassifyFinding', () => {
  it('classifies HTTP 500 as confirmed_bug', () => {
    const f = makeFinding({ httpStatus: 500 });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('confirmed_bug');
  });

  it('classifies HTTP 502 as confirmed_bug', () => {
    const f = makeFinding({ httpStatus: 502 });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('confirmed_bug');
  });

  it('classifies uncaught JS exception as confirmed_bug', () => {
    const f = makeFinding({
      consoleErrors: ['Uncaught TypeError: Cannot read properties of null'],
    });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('confirmed_bug');
  });

  it('classifies /.env returning 200 as confirmed_bug', () => {
    const f = makeFinding({ httpStatus: 200, route: 'http://localhost:3000/.env' });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('confirmed_bug');
  });

  it('classifies /.git/HEAD returning 200 as confirmed_bug', () => {
    const f = makeFinding({ httpStatus: 200, route: 'http://localhost:3000/.git/HEAD' });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('confirmed_bug');
  });

  it('classifies /swagger.json returning 200 as confirmed_bug', () => {
    const f = makeFinding({ httpStatus: 200, route: 'http://localhost:3000/swagger.json' });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('confirmed_bug');
  });

  it('classifies auth provider 400 as not_a_bug', () => {
    const f = makeFinding({
      httpStatus: 400,
      route: 'https://tenant.auth0.com/authorize',
    });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('not_a_bug');
  });

  it('sends error-handling + HTTP 200 to critic (no longer auto-dismisses)', () => {
    const f = makeFinding({
      category: 'error-handling',
      httpStatus: 200,
    });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('needs_review');
  });

  it('sends normal findings to critic', () => {
    const f = makeFinding({ httpStatus: 200 });
    const result = preClassifyFinding(f);
    expect(result.classification).toBe('needs_review');
  });

  it('classifies server-side sort as not_a_bug when app model says so', () => {
    const f = makeFinding({
      title: 'Sort indicator appears but rows not reordered',
    });
    const result = preClassifyFinding(f, {
      appType: 'admin portal',
      errorPatterns: [],
      successPatterns: [],
      emptyStates: [],
      sortBehavior: 'server-side (column header updates but rows may not visually reorder)',
      authProvider: 'none',
      navigationStructure: 'sidebar',
      knownPatterns: [],
    });
    expect(result.classification).toBe('not_a_bug');
  });
});
