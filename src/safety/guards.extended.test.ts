/**
 * Extended guards tests: isPathBanned, assertHostsTrusted, assertAllowedTarget,
 * assertNonProdHost, createNetworkAllowlistRoute.
 *
 * The base guards.test.ts covers isHostAllowed. This file covers the remaining
 * exported functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAllHostsNonProd,
  assertAllowedTarget,
  assertHostsTrusted,
  assertNonProdHost,
  createNetworkAllowlistRoute,
  isPathBanned,
} from './guards.ts';

// ---------------------------------------------------------------------------
// isPathBanned
// ---------------------------------------------------------------------------

describe('isPathBanned', () => {
  it('returns false when bannedPrefixes is empty', () => {
    expect(isPathBanned('http://localhost:3000/admin', [])).toBe(false);
  });

  it('bans a URL whose pathname starts with a banned prefix', () => {
    expect(isPathBanned('http://localhost:3000/api/internal/debug', ['/api/internal'])).toBe(true);
  });

  it('does not ban a URL whose pathname does not match', () => {
    expect(isPathBanned('http://localhost:3000/dashboard', ['/api/internal'])).toBe(false);
  });

  it('handles multiple banned prefixes', () => {
    const banned = ['/admin', '/debug', '/metrics'];
    expect(isPathBanned('http://localhost:3000/admin/users', banned)).toBe(true);
    expect(isPathBanned('http://localhost:3000/debug/logs', banned)).toBe(true);
    expect(isPathBanned('http://localhost:3000/login', banned)).toBe(false);
  });

  it('returns true for invalid URLs (fail-closed)', () => {
    expect(isPathBanned('not-a-url', ['/admin'])).toBe(true);
  });

  it('exact prefix match — /admin bans /admin/x but not /administrator', () => {
    // /admin is a prefix of /administrator — this IS banned (startsWith)
    expect(isPathBanned('http://x.com/administrator', ['/admin'])).toBe(true);
    // To ban only /admin/ and its children, the prefix should be /admin/
    expect(isPathBanned('http://x.com/administrator', ['/admin/'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertHostsTrusted (requires REGRESS_TRUSTED_HOSTS env var)
// ---------------------------------------------------------------------------

describe('assertHostsTrusted', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.REGRESS_TRUSTED_HOSTS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.REGRESS_TRUSTED_HOSTS;
    else process.env.REGRESS_TRUSTED_HOSTS = original;
  });

  it('throws when REGRESS_TRUSTED_HOSTS is not set', () => {
    delete process.env.REGRESS_TRUSTED_HOSTS;
    expect(() => assertHostsTrusted(['localhost:3000'])).toThrow(/REGRESS_TRUSTED_HOSTS is not set/);
  });

  it('passes when all hosts are in the trusted list', () => {
    process.env.REGRESS_TRUSTED_HOSTS = 'localhost:3000,staging.example.com';
    expect(() => assertHostsTrusted(['localhost:3000'])).not.toThrow();
  });

  it('throws when a host is not in the trusted list', () => {
    process.env.REGRESS_TRUSTED_HOSTS = 'localhost:3000';
    expect(() => assertHostsTrusted(['localhost:3000', 'evil.example.com'])).toThrow(
      /not in REGRESS_TRUSTED_HOSTS.*evil\.example\.com/,
    );
  });

  it('handles empty allowed_hosts (vacuously true)', () => {
    process.env.REGRESS_TRUSTED_HOSTS = 'localhost:3000';
    expect(() => assertHostsTrusted([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertAllowedTarget
// ---------------------------------------------------------------------------

describe('assertAllowedTarget', () => {
  it('passes when target host is in allowed_hosts', () => {
    expect(() =>
      assertAllowedTarget('http://localhost:3000/api', ['localhost:3000']),
    ).not.toThrow();
  });

  it('throws when target host is not in allowed_hosts', () => {
    expect(() =>
      assertAllowedTarget('http://localhost:3000/api', ['staging.example.com']),
    ).toThrow(/not in target.allowed_hosts/);
  });

  it('throws when allowed_hosts is empty', () => {
    expect(() => assertAllowedTarget('http://localhost:3000', [])).toThrow(
      /allowed_hosts is empty/,
    );
  });

  it('throws for invalid URL', () => {
    expect(() => assertAllowedTarget('not-a-url', ['localhost'])).toThrow(/not a valid URL/);
  });
});

// ---------------------------------------------------------------------------
// assertNonProdHost
// ---------------------------------------------------------------------------

describe('assertNonProdHost', () => {
  let origPatterns: string | undefined;

  beforeEach(() => {
    origPatterns = process.env.REGRESS_NONPROD_HOST_PATTERNS;
  });

  afterEach(() => {
    if (origPatterns === undefined) delete process.env.REGRESS_NONPROD_HOST_PATTERNS;
    else process.env.REGRESS_NONPROD_HOST_PATTERNS = origPatterns;
  });

  it('allows localhost', () => {
    expect(() => assertNonProdHost('http://localhost:3000')).not.toThrow();
  });

  it('allows 127.0.0.1', () => {
    expect(() => assertNonProdHost('http://127.0.0.1:8080')).not.toThrow();
  });

  it('allows staging. prefix', () => {
    expect(() => assertNonProdHost('https://staging.example.com')).not.toThrow();
  });

  it('allows dev. prefix', () => {
    expect(() => assertNonProdHost('https://dev.example.com')).not.toThrow();
  });

  it('allows qa. prefix', () => {
    expect(() => assertNonProdHost('https://qa.example.com')).not.toThrow();
  });

  it('allows test. prefix', () => {
    expect(() => assertNonProdHost('https://test.example.com')).not.toThrow();
  });

  it('rejects production-looking host (no prefix match)', () => {
    delete process.env.REGRESS_NONPROD_HOST_PATTERNS;
    expect(() => assertNonProdHost('https://api.example.com')).toThrow(
      /does not match any default non-prod prefix/,
    );
  });

  it('allows custom host via REGRESS_NONPROD_HOST_PATTERNS', () => {
    process.env.REGRESS_NONPROD_HOST_PATTERNS = 'api.example.com,custom.internal.net';
    expect(() => assertNonProdHost('https://api.example.com')).not.toThrow();
  });

  it('rejects custom host not in REGRESS_NONPROD_HOST_PATTERNS', () => {
    process.env.REGRESS_NONPROD_HOST_PATTERNS = 'custom.example.com';
    expect(() => assertNonProdHost('https://other.example.com')).toThrow(
      /not in REGRESS_NONPROD_HOST_PATTERNS/,
    );
  });

  it('throws for invalid URL', () => {
    expect(() => assertNonProdHost('not-a-url')).toThrow(/not a valid URL/);
  });
});

// ---------------------------------------------------------------------------
// assertAllHostsNonProd
// ---------------------------------------------------------------------------

describe('assertAllHostsNonProd', () => {
  let origPatterns: string | undefined;

  beforeEach(() => {
    origPatterns = process.env.REGRESS_NONPROD_HOST_PATTERNS;
    delete process.env.REGRESS_NONPROD_HOST_PATTERNS;
  });

  afterEach(() => {
    if (origPatterns === undefined) delete process.env.REGRESS_NONPROD_HOST_PATTERNS;
    else process.env.REGRESS_NONPROD_HOST_PATTERNS = origPatterns;
  });

  it('passes when all hosts are non-prod', () => {
    expect(() => assertAllHostsNonProd(['localhost:3000', 'staging.example.com'])).not.toThrow();
  });

  it('throws if any host looks like prod', () => {
    expect(() => assertAllHostsNonProd(['localhost:3000', 'api.example.com'])).toThrow(
      /does not match any default non-prod prefix/,
    );
  });
});

// ---------------------------------------------------------------------------
// createNetworkAllowlistRoute
// ---------------------------------------------------------------------------

describe('createNetworkAllowlistRoute', () => {
  it('continues for allowed hosts', async () => {
    const routeFn = createNetworkAllowlistRoute(['staging.example.com']);
    const continued = vi.fn();
    const aborted = vi.fn();
    await routeFn({
      request: () => ({ url: () => 'https://staging.example.com/api/data' }),
      continue: continued,
      abort: aborted,
    });
    expect(continued).toHaveBeenCalled();
    expect(aborted).not.toHaveBeenCalled();
  });

  it('aborts for disallowed hosts', async () => {
    const routeFn = createNetworkAllowlistRoute(['staging.example.com']);
    const continued = vi.fn();
    const aborted = vi.fn();
    await routeFn({
      request: () => ({ url: () => 'https://evil.example.com/exfil' }),
      continue: continued,
      abort: aborted,
    });
    expect(aborted).toHaveBeenCalled();
    expect(continued).not.toHaveBeenCalled();
  });
});
