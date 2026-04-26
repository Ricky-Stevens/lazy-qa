import { describe, expect, it } from 'vitest';
import { isHostAllowed } from './guards.ts';

describe('isHostAllowed', () => {
  it('exact match', () => {
    expect(isHostAllowed('https://staging.example.com/x', ['staging.example.com'])).toBe(true);
  });
  it('subdomain match', () => {
    expect(isHostAllowed('https://cdn.staging.example.com/x', ['staging.example.com'])).toBe(true);
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
  it('multi-host allowlist', () => {
    const list = ['staging.example.com', 'tenant.auth0.com'];
    expect(isHostAllowed('https://staging.example.com/x', list)).toBe(true);
    expect(isHostAllowed('https://tenant.auth0.com/x', list)).toBe(true);
    expect(isHostAllowed('https://attacker.example/x', list)).toBe(false);
  });
});
