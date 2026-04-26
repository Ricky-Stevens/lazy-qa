import { describe, expect, it } from 'vitest';
import {
  auth0Provider,
  bearerTokenProvider,
  formAuthProvider,
  listAuthProviderNames,
  resolveAuthProvider,
  storageStateProvider,
} from './index.ts';

describe('resolveAuthProvider', () => {
  it("returns the form provider for 'form'", () => {
    expect(resolveAuthProvider('form')).toBe(formAuthProvider);
  });

  it("returns the auth0 provider for 'auth0'", () => {
    expect(resolveAuthProvider('auth0')).toBe(auth0Provider);
  });

  it("returns the storage-state provider for 'storage-state'", () => {
    expect(resolveAuthProvider('storage-state')).toBe(storageStateProvider);
  });

  it("returns the bearer provider for 'bearer'", () => {
    expect(resolveAuthProvider('bearer')).toBe(bearerTokenProvider);
  });

  it("aliases 'none' to storage-state for v1 back-compat", () => {
    expect(resolveAuthProvider('none')).toBe(storageStateProvider);
  });

  it('throws on an unknown name and includes the catalog in the error', () => {
    expect(() => resolveAuthProvider('garbage')).toThrowError(/Unknown auth provider: garbage/);
    expect(() => resolveAuthProvider('garbage')).toThrowError(/form/);
    expect(() => resolveAuthProvider('garbage')).toThrowError(/auth0/);
  });

  it('throws on the empty string', () => {
    expect(() => resolveAuthProvider('')).toThrowError(/Unknown auth provider/);
  });
});

describe('listAuthProviderNames', () => {
  it('lists every shipped provider', () => {
    const names = listAuthProviderNames();
    expect(names).toContain('form');
    expect(names).toContain('auth0');
    expect(names).toContain('storage-state');
    expect(names).toContain('bearer');
    expect(names).toContain('none');
  });
});
