import { describe, expect, it } from 'vitest';
import type { Finding } from '../types/finding.ts';
import { dedupeFindings } from './evaluate.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
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

describe('dedupeFindings', () => {
  it('removes exact title+route duplicates', () => {
    const a = makeFinding({ title: 'Form accepts empty input', route: '/login' });
    const b = makeFinding({ title: 'Form accepts empty input', route: '/login' });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(a.id);
  });

  it('keeps findings on different routes', () => {
    const a = makeFinding({ title: 'Form accepts empty input', route: '/login' });
    const b = makeFinding({ title: 'Form accepts empty input', route: '/register' });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(2);
  });

  it('dedupes regardless of severity', () => {
    const a = makeFinding({ title: 'XSS in search', route: '/search', severity: 'critical' });
    const b = makeFinding({ title: 'XSS in search', route: '/search', severity: 'minor' });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(1);
  });

  it('fuzzy dedupes similar titles on the same route (Jaccard >= 0.6)', () => {
    const a = makeFinding({
      title: 'Missing CSRF token on login form',
      route: '/login',
      stepsToReproduce: ['Step 1'],
    });
    const b = makeFinding({
      title: 'Login form missing CSRF token protection',
      route: '/login',
      stepsToReproduce: ['Step 1', 'Step 2', 'Step 3'],
    });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(1);
    // Should keep the one with more repro steps
    expect(result[0]!.stepsToReproduce).toHaveLength(3);
  });

  it('keeps dissimilar titles on the same route', () => {
    const a = makeFinding({ title: 'Missing CSRF token', route: '/login' });
    const b = makeFinding({ title: 'SQL injection in password field', route: '/login' });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(dedupeFindings([])).toHaveLength(0);
  });

  it('handles single finding', () => {
    const f = makeFinding();
    expect(dedupeFindings([f])).toHaveLength(1);
  });

  it('normalises route trailing slashes', () => {
    const a = makeFinding({ title: 'Bug found', route: '/api/users/' });
    const b = makeFinding({ title: 'Bug found', route: '/api/users' });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(1);
  });

  it('normalises route query strings for dedup key', () => {
    const a = makeFinding({ title: 'Bug found', route: '/search?q=test' });
    const b = makeFinding({ title: 'Bug found', route: '/search?q=other' });
    const result = dedupeFindings([a, b]);
    expect(result).toHaveLength(1);
  });
});
