import { describe, expect, it } from 'vitest';
import { auth0Provider } from './auth0.ts';

describe('auth0Provider.detectAuthWall', () => {
  it('flags the universal-login URL', () => {
    expect(auth0Provider.detectAuthWall('https://x.auth0.com/u/login/identifier')).toBe(true);
  });

  it('flags the universal-login root', () => {
    expect(auth0Provider.detectAuthWall('https://x.auth0.com/u/login')).toBe(true);
  });

  it('flags v2 logout', () => {
    expect(auth0Provider.detectAuthWall('https://x.auth0.com/v2/logout?client_id=abc')).toBe(true);
  });

  it('flags oidc logout', () => {
    expect(auth0Provider.detectAuthWall('https://x.auth0.com/oidc/logout')).toBe(true);
  });

  it('does NOT flag transient /authorize redirects (silent re-auth)', () => {
    expect(
      auth0Provider.detectAuthWall(
        'https://x.auth0.com/authorize?client_id=abc&redirect_uri=https://app.example.com',
      ),
    ).toBe(false);
  });

  it('does NOT flag non-Auth0 hosts even if path matches', () => {
    expect(auth0Provider.detectAuthWall('https://example.com/u/login/identifier')).toBe(false);
  });

  it('does NOT flag the app domain', () => {
    expect(auth0Provider.detectAuthWall('https://example.com/login')).toBe(false);
  });

  it('does NOT flag a host that contains "auth0.com" as a substring (defense)', () => {
    expect(auth0Provider.detectAuthWall('https://fakeauth0.com/u/login')).toBe(false);
    expect(auth0Provider.detectAuthWall('https://x.auth0.com.evil.com/u/login')).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(auth0Provider.detectAuthWall('not-a-url')).toBe(false);
    expect(auth0Provider.detectAuthWall('')).toBe(false);
  });
});

describe('auth0Provider metadata', () => {
  it('exposes name "auth0"', () => {
    expect(auth0Provider.name).toBe('auth0');
  });

  it('implements the AuthProvider shape', () => {
    expect(typeof auth0Provider.login).toBe('function');
    expect(typeof auth0Provider.detectAuthWall).toBe('function');
    expect(typeof auth0Provider.recover).toBe('function');
  });
});
