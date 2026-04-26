import { describe, expect, it } from 'vitest';
import { defaultLogoutGuard } from './default.ts';

function meta(overrides: Partial<Parameters<typeof defaultLogoutGuard.isLogout>[0]> = {}) {
  return {
    text: '',
    ariaLabel: '',
    href: '',
    testid: '',
    title: '',
    ...overrides,
  };
}

describe('defaultLogoutGuard.isLogout — positive matches', () => {
  it('matches text "Log out"', () => {
    const r = defaultLogoutGuard.isLogout(meta({ text: 'Log out' }));
    expect(r.matched).toBe(true);
    expect(r.reason).toContain('Log out');
  });

  it('matches text "Sign Out"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ text: 'Sign Out' })).matched).toBe(true);
  });

  it('matches text with hyphen "log-out"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ text: 'log-out' })).matched).toBe(true);
  });

  it('matches text with underscore "sign_out"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ text: 'sign_out' })).matched).toBe(true);
  });

  it('matches aria-label "Sign Out"', () => {
    const r = defaultLogoutGuard.isLogout(meta({ ariaLabel: 'Sign Out' }));
    expect(r.matched).toBe(true);
    expect(r.reason).toContain('aria-label');
  });

  it('matches title "Log out"', () => {
    const r = defaultLogoutGuard.isLogout(meta({ title: 'Log out' }));
    expect(r.matched).toBe(true);
    expect(r.reason).toContain('title');
  });

  it('matches href "/logout"', () => {
    const r = defaultLogoutGuard.isLogout(meta({ href: '/logout' }));
    expect(r.matched).toBe(true);
    expect(r.reason).toContain('href');
  });

  it('matches href "/auth/sign-out?next=/"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ href: '/auth/sign-out?next=/' })).matched).toBe(true);
  });

  it('matches data-testid "logout-button"', () => {
    const r = defaultLogoutGuard.isLogout(meta({ testid: 'logout-button' }));
    expect(r.matched).toBe(true);
    expect(r.reason).toContain('data-testid');
  });

  it('matches data-testid "header_signout"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ testid: 'header_signout' })).matched).toBe(true);
  });
});

describe('defaultLogoutGuard.isLogout — negative matches', () => {
  it('does NOT match "Logout audit log" (text contains but is not the whole string)', () => {
    expect(defaultLogoutGuard.isLogout(meta({ text: 'Logout audit log' })).matched).toBe(false);
  });

  it('does NOT match "Sign out attempts (admin)"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ text: 'Sign out attempts (admin)' })).matched).toBe(
      false,
    );
  });

  it('does NOT match unrelated text "Settings"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ text: 'Settings' })).matched).toBe(false);
  });

  it('does NOT match an empty meta blob', () => {
    expect(defaultLogoutGuard.isLogout(meta()).matched).toBe(false);
  });

  it('does NOT match href "/logout-attempts" (logout is part of a longer slug)', () => {
    expect(defaultLogoutGuard.isLogout(meta({ href: '/logout-attempts' })).matched).toBe(false);
  });

  it('does NOT match testid "logoutaudit"', () => {
    expect(defaultLogoutGuard.isLogout(meta({ testid: 'logoutaudit' })).matched).toBe(false);
  });
});

describe('defaultLogoutGuard metadata', () => {
  it('exposes name "default"', () => {
    expect(defaultLogoutGuard.name).toBe('default');
  });
});
