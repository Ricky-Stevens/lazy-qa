import { describe, expect, it } from 'vitest';
import { isHostAllowed } from './guards.ts';

describe('isHostAllowed', () => {
  it('exact match', () => {
    expect(isHostAllowed('https://staging.example.com/x', ['staging.example.com'])).toBe(true);
  });
  it('subdomain blocked (strict matching)', () => {
    expect(isHostAllowed('https://cdn.staging.example.com/x', ['staging.example.com'])).toBe(false);
  });
  it('subdomain must be listed explicitly', () => {
    expect(
      isHostAllowed('https://cdn.staging.example.com/x', [
        'staging.example.com',
        'cdn.staging.example.com',
      ]),
    ).toBe(true);
  });
  it('off-host blocked', () => {
    expect(isHostAllowed('https://attacker.example/x', ['staging.example.com'])).toBe(false);
  });
  it('invalid URL blocked', () => {
    expect(isHostAllowed('not-a-url', ['staging.example.com'])).toBe(false);
  });
  it('different TLD blocked', () => {
    expect(isHostAllowed('https://staging.example.org/x', ['staging.example.com'])).toBe(false);
  });
  it('port-specific entry blocks other ports on same host', () => {
    expect(isHostAllowed('http://localhost:9090/admin', ['localhost:3050'])).toBe(false);
  });
  it('port-specific entry allows exact port', () => {
    expect(isHostAllowed('http://localhost:3050/x', ['localhost:3050'])).toBe(true);
  });
  it('portless entry allows any port on that host', () => {
    expect(isHostAllowed('http://staging.example.com:8443/x', ['staging.example.com'])).toBe(true);
  });
  it('multi-host allowlist', () => {
    const list = ['staging.example.com', 'tenant.auth0.com'];
    expect(isHostAllowed('https://staging.example.com/x', list)).toBe(true);
    expect(isHostAllowed('https://tenant.auth0.com/x', list)).toBe(true);
    expect(isHostAllowed('https://attacker.example/x', list)).toBe(false);
  });
});
