/**
 * Tests for auth-agent-shared.ts — JWT decoding, claim extraction, and
 * session-info capture helpers used by both API and SDK auth agents.
 */

import { describe, expect, it, vi } from 'vitest';
import { captureSessionInfo, decodeJwtClaim, findString } from './auth-agent-shared.ts';

// ---------------------------------------------------------------------------
// decodeJwtClaim
// ---------------------------------------------------------------------------

describe('decodeJwtClaim', () => {
  it('decodes a standard JWT payload', () => {
    // Build a valid JWT: header.payload.signature
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: '1234', email: 'admin@example.com', role: 'admin' }),
    ).toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    const claim = decodeJwtClaim(token);
    expect(claim).not.toBeNull();
    expect(claim!.sub).toBe('1234');
    expect(claim!.email).toBe('admin@example.com');
    expect(claim!.role).toBe('admin');
  });

  it('handles base64 padding correctly', () => {
    // Use a payload that requires padding
    const payload = Buffer.from(JSON.stringify({ user: 'x' })).toString('base64url');
    const token = `header.${payload}.sig`;
    const claim = decodeJwtClaim(token);
    expect(claim).not.toBeNull();
    expect(claim!.user).toBe('x');
  });

  it('handles base64url encoding (with - and _)', () => {
    const payload = Buffer.from(JSON.stringify({ data: 'test+test/test' })).toString('base64url');
    const token = `h.${payload}.s`;
    const claim = decodeJwtClaim(token);
    expect(claim).not.toBeNull();
    expect(claim!.data).toBe('test+test/test');
  });

  it('returns null for non-JWT strings', () => {
    expect(decodeJwtClaim('not-a-jwt')).toBeNull();
    expect(decodeJwtClaim('')).toBeNull();
    expect(decodeJwtClaim('only.one')).toBeNull();
  });

  it('returns null for invalid base64 in payload', () => {
    expect(decodeJwtClaim('header.!!!invalid!!!.sig')).toBeNull();
  });

  it('returns null when payload is not valid JSON', () => {
    const notJson = Buffer.from('not json at all').toString('base64url');
    expect(decodeJwtClaim(`h.${notJson}.s`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findString
// ---------------------------------------------------------------------------

describe('findString', () => {
  it('finds a top-level string matching the key regex', () => {
    expect(findString({ email: 'a@b.com', name: 'Bob' }, /^email$/)).toBe('a@b.com');
  });

  it('finds a nested string (Juice Shop data.email pattern)', () => {
    expect(findString({ data: { email: 'nested@test.com' } }, /^email$/)).toBe('nested@test.com');
  });

  it('finds role field', () => {
    expect(findString({ role: 'admin' }, /^role$/)).toBe('admin');
  });

  it('returns undefined when no match', () => {
    expect(findString({ foo: 'bar' }, /^email$/)).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(findString(null, /^email$/)).toBeUndefined();
    expect(findString('string', /^email$/)).toBeUndefined();
    expect(findString(42, /^email$/)).toBeUndefined();
  });

  it('skips empty string values', () => {
    expect(findString({ email: '' }, /^email$/)).toBeUndefined();
  });

  it('returns first match in case of multiple nested matches', () => {
    const obj = {
      email: 'top@test.com',
      data: { email: 'nested@test.com' },
    };
    const result = findString(obj, /^email$/);
    expect(result).toBe('top@test.com');
  });
});

// ---------------------------------------------------------------------------
// captureSessionInfo
// ---------------------------------------------------------------------------

describe('captureSessionInfo', () => {
  it('returns fallback username when no JWT in storage', async () => {
    const context = {
      storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    } as never;
    const result = await captureSessionInfo(context, 'fallback-user');
    expect(result.username).toBe('fallback-user');
  });

  it('extracts username from JWT cookie', async () => {
    const payload = Buffer.from(
      JSON.stringify({ email: 'jwt-user@test.com' }),
    ).toString('base64url');
    const jwt = `header.${payload}.sig`;
    const context = {
      storageState: vi.fn().mockResolvedValue({
        cookies: [{ name: 'auth_token', value: jwt }],
        origins: [],
      }),
    } as never;
    const result = await captureSessionInfo(context, 'fallback');
    expect(result.username).toBe('jwt-user@test.com');
  });

  it('extracts role from JWT payload', async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'admin', role: 'superadmin' }),
    ).toString('base64url');
    const jwt = `h.${payload}.s`;
    const context = {
      storageState: vi.fn().mockResolvedValue({
        cookies: [{ name: 'session_token', value: jwt }],
        origins: [],
      }),
    } as never;
    const result = await captureSessionInfo(context, 'fallback');
    expect(result.role).toBe('superadmin');
  });

  it('extracts from localStorage when cookie has no JWT', async () => {
    const payload = Buffer.from(
      JSON.stringify({ email: 'local@test.com' }),
    ).toString('base64url');
    const jwt = `h.${payload}.s`;
    const context = {
      storageState: vi.fn().mockResolvedValue({
        cookies: [],
        origins: [
          {
            origin: 'http://localhost',
            localStorage: [{ name: 'jwt', value: jwt }],
          },
        ],
      }),
    } as never;
    const result = await captureSessionInfo(context, 'fallback');
    expect(result.username).toBe('local@test.com');
  });

  it('falls back gracefully when storageState throws', async () => {
    const context = {
      storageState: vi.fn().mockRejectedValue(new Error('browser closed')),
    } as never;
    const result = await captureSessionInfo(context, 'safe-fallback');
    expect(result.username).toBe('safe-fallback');
  });

  it('skips short cookie values (< 16 chars)', async () => {
    const context = {
      storageState: vi.fn().mockResolvedValue({
        cookies: [{ name: 'token', value: 'short' }],
        origins: [],
      }),
    } as never;
    const result = await captureSessionInfo(context, 'fallback');
    expect(result.username).toBe('fallback');
  });
});
