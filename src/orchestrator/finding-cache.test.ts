import { describe, expect, it } from 'vitest';
import type { Finding } from '../types/finding.ts';
import { FindingCache, _internal } from './finding-cache.ts';

const { tokeniseTitle, jaccard, normaliseRoute, sameRouteFamily, extractChallengeName } =
  _internal;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

describe('tokeniseTitle', () => {
  it('lowercases, splits on non-alphanumeric, filters stopwords and short tokens', () => {
    const tokens = tokeniseTitle('Missing CSRF token on login form');
    expect(tokens.has('csrf')).toBe(true);
    expect(tokens.has('missing')).toBe(true);
    expect(tokens.has('login')).toBe(true);
    expect(tokens.has('form')).toBe(true);
    // "on" is a stopword, "of" / "the" too
    expect(tokens.has('on')).toBe(false);
  });

  it('drops tokens shorter than 3 chars', () => {
    const tokens = tokeniseTitle('XS is a bug');
    expect(tokens.has('xs')).toBe(false);
    expect(tokens.has('is')).toBe(false);
    expect(tokens.has('bug')).toBe(true);
  });

  it('returns empty set for all-stopword title', () => {
    const tokens = tokeniseTitle('the error in the response');
    // "the", "error", "in", "the", "response" — "error" and "response" are stopwords
    expect(tokens.size).toBe(0);
  });
});

describe('jaccard', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['a', 'b', 'c']);
    expect(jaccard(a, a)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('returns 0 when one set is empty', () => {
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });

  it('computes correct overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4
    expect(jaccard(a, b)).toBe(0.5);
  });
});

describe('normaliseRoute', () => {
  it('strips protocol and host', () => {
    expect(normaliseRoute('http://localhost:3000/ftp')).toBe('/ftp');
  });

  it('strips trailing slash', () => {
    expect(normaliseRoute('/ftp/')).toBe('/ftp');
  });

  it('strips query string', () => {
    expect(normaliseRoute('/search?q=test')).toBe('/search');
  });

  it('preserves SPA hash routes', () => {
    expect(normaliseRoute('http://localhost:3000/#/admin')).toBe('/#/admin');
  });

  it('strips non-SPA fragment anchors', () => {
    expect(normaliseRoute('/page#section')).toBe('/page');
  });

  it('returns empty string for empty input', () => {
    expect(normaliseRoute('')).toBe('');
  });

  it('keeps root "/" as is', () => {
    expect(normaliseRoute('/')).toBe('/');
  });
});

describe('sameRouteFamily', () => {
  it('matches same first path segment', () => {
    expect(sameRouteFamily('/ftp/acquisitions.md', '/ftp/coupons.md.bak')).toBe(true);
  });

  it('matches exact same route', () => {
    expect(sameRouteFamily('/ftp', '/ftp')).toBe(true);
  });

  it('does not match different first segments', () => {
    expect(sameRouteFamily('/ftp', '/api/Orders')).toBe(false);
  });

  it('returns false when either route is empty', () => {
    expect(sameRouteFamily('', '/ftp')).toBe(false);
  });

  it('works with full URLs', () => {
    expect(
      sameRouteFamily('http://localhost:3000/ftp/a.txt', 'http://localhost:3000/ftp/b.txt'),
    ).toBe(true);
  });
});

describe('extractChallengeName', () => {
  it('extracts quoted challenge name', () => {
    expect(extractChallengeName('Challenge "View Basket" auto-solved on page load')).toBe(
      'view basket',
    );
  });

  it('extracts unquoted challenge name', () => {
    expect(extractChallengeName('Challenge View Basket auto-solved')).toBe('view basket');
  });

  it('extracts from "Unexpected challenge solved" pattern', () => {
    expect(extractChallengeName('Unexpected challenge solved: "Privacy Policy"')).toBe(
      'privacy policy',
    );
  });

  it('returns null for multi-challenge titles', () => {
    expect(extractChallengeName('Multiple challenges auto-solved during navigation')).toBeNull();
  });

  it('returns null for non-challenge titles', () => {
    expect(extractChallengeName('Form validation missing on login')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FindingCache
// ---------------------------------------------------------------------------

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

describe('FindingCache', () => {
  describe('add and size', () => {
    it('increments size on add', () => {
      const cache = new FindingCache();
      expect(cache.size()).toBe(0);
      cache.add('agent-1', makeFinding());
      expect(cache.size()).toBe(1);
    });

    it('caps at 200 entries', () => {
      const cache = new FindingCache();
      for (let i = 0; i < 210; i++) {
        cache.add('agent-1', makeFinding({ title: `Finding ${i}` }));
      }
      expect(cache.size()).toBe(200);
    });
  });

  describe('forAgent', () => {
    it('returns findings from other agents only', () => {
      const cache = new FindingCache();
      cache.add('agent-1', makeFinding({ title: 'From A' }));
      cache.add('agent-2', makeFinding({ title: 'From B' }));
      cache.add('agent-1', makeFinding({ title: 'From A again' }));

      const forAgent2 = cache.forAgent('agent-2');
      expect(forAgent2).toHaveLength(2);
      expect(forAgent2.every((e) => e.agentId === 'agent-1')).toBe(true);
    });

    it('returns most recent first', () => {
      const cache = new FindingCache();
      cache.add('agent-1', makeFinding({ title: 'First' }));
      cache.add('agent-1', makeFinding({ title: 'Second' }));
      const result = cache.forAgent('agent-2');
      expect(result[0]?.title).toBe('Second');
    });
  });

  describe('findWithinAgentDuplicate', () => {
    it('detects exact title + route duplicate', () => {
      const cache = new FindingCache();
      cache.add('agent-1', makeFinding({ title: 'Bug on login', route: '/login', severity: 'major' }));

      const dup = cache.findWithinAgentDuplicate(
        'agent-1',
        makeFinding({ title: 'Bug on login', route: '/login', severity: 'major' }),
      );
      expect(dup).not.toBeNull();
    });

    it('detects fuzzy title match on same route family', () => {
      const cache = new FindingCache();
      cache.add(
        'agent-1',
        makeFinding({
          title: 'Confidential document publicly accessible',
          route: '/ftp/acquisitions.md',
          severity: 'major',
        }),
      );

      const dup = cache.findWithinAgentDuplicate(
        'agent-1',
        makeFinding({
          title: 'Confidential business document publicly accessible without authentication',
          route: '/ftp/coupons.md.bak',
          severity: 'major',
        }),
      );
      expect(dup).not.toBeNull();
    });

    it('does not match findings from different agents', () => {
      const cache = new FindingCache();
      cache.add('agent-1', makeFinding({ title: 'Bug on login', route: '/login', severity: 'major' }));

      const dup = cache.findWithinAgentDuplicate(
        'agent-2',
        makeFinding({ title: 'Bug on login', route: '/login', severity: 'major' }),
      );
      expect(dup).toBeNull();
    });

    it('does not match different severity', () => {
      const cache = new FindingCache();
      cache.add('agent-1', makeFinding({ title: 'Bug on login', route: '/login', severity: 'major' }));

      const dup = cache.findWithinAgentDuplicate(
        'agent-1',
        makeFinding({ title: 'Bug on login', route: '/login', severity: 'minor' }),
      );
      expect(dup).toBeNull();
    });

    it('does not match different route families', () => {
      const cache = new FindingCache();
      cache.add(
        'agent-1',
        makeFinding({ title: 'Data exposed', route: '/ftp/file.txt', severity: 'major' }),
      );

      const dup = cache.findWithinAgentDuplicate(
        'agent-1',
        makeFinding({ title: 'Data exposed', route: '/api/users', severity: 'major' }),
      );
      expect(dup).toBeNull();
    });

    it('deduplicates gamification challenges by name across routes', () => {
      const cache = new FindingCache();
      cache.add(
        'agent-1',
        makeFinding({
          title: 'Challenge "View Basket" auto-solved on page load',
          route: '/#/search',
          severity: 'minor',
        }),
      );

      const dup = cache.findWithinAgentDuplicate(
        'agent-1',
        makeFinding({
          title: 'Challenge "View Basket" auto-solved on navigation',
          route: '/#/basket',
          severity: 'minor',
        }),
      );
      expect(dup).not.toBeNull();
    });

    it('does not merge different challenge names', () => {
      const cache = new FindingCache();
      cache.add(
        'agent-1',
        makeFinding({
          title: 'Challenge "View Basket" auto-solved',
          route: '/#/search',
          severity: 'minor',
        }),
      );

      const dup = cache.findWithinAgentDuplicate(
        'agent-1',
        makeFinding({
          title: 'Challenge "Privacy Policy" auto-solved',
          route: '/#/search',
          severity: 'minor',
        }),
      );
      expect(dup).toBeNull();
    });
  });

  describe('false positive patterns', () => {
    it('matches when title contains the pattern', () => {
      const cache = new FindingCache();
      cache.seedFalsePositivePatterns([
        { titlePattern: 'cookie consent banner appears', reason: 'Expected behavior' },
      ]);

      const match = cache.matchesFalsePositive({
        title: 'Cookie consent banner appears on every page load',
      });
      expect(match).not.toBeNull();
      expect(match!.reason).toBe('Expected behavior');
    });

    it('returns null when title does not match any pattern', () => {
      const cache = new FindingCache();
      cache.seedFalsePositivePatterns([
        { titlePattern: 'cookie consent banner', reason: 'FP' },
      ]);

      const match = cache.matchesFalsePositive({ title: 'Login form has no CSRF token' });
      expect(match).toBeNull();
    });

    it('respects route filter when provided', () => {
      const cache = new FindingCache();
      cache.seedFalsePositivePatterns([
        { titlePattern: 'error message shown', route: '/login', reason: 'Expected on login' },
      ]);

      expect(
        cache.matchesFalsePositive({ title: 'Error message shown on submit', route: '/login' }),
      ).not.toBeNull();
      expect(
        cache.matchesFalsePositive({ title: 'Error message shown on submit', route: '/register' }),
      ).toBeNull();
    });
  });
});
