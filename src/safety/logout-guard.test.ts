import { describe, expect, it } from 'vitest';
import { isLogoutLink } from './logout-guard.ts';

describe('isLogoutLink', () => {
  const empty = { text: '', ariaLabel: '', href: '', testid: '', title: '' };

  it('matches "Log out" text', () => {
    expect(isLogoutLink({ ...empty, text: 'Log out' }).matched).toBe(true);
  });
  it('matches "Sign Out" text (case-insensitive)', () => {
    expect(isLogoutLink({ ...empty, text: 'Sign Out' }).matched).toBe(true);
  });
  it('matches "/logout" href', () => {
    expect(isLogoutLink({ ...empty, href: '/logout' }).matched).toBe(true);
  });
  it('matches "/auth/sign-out?next=/" href', () => {
    expect(isLogoutLink({ ...empty, href: '/auth/sign-out?next=/' }).matched).toBe(true);
  });
  it('does not match plain navigation', () => {
    expect(isLogoutLink({ ...empty, text: 'Dashboard', href: '/dashboard' }).matched).toBe(false);
  });
  it('matches "logout-warning" testid (intentional false-positive risk: testid contains the literal word)', () => {
    expect(isLogoutLink({ ...empty, testid: 'logout-warning' }).matched).toBe(true);
  });
});
