import { describe, expect, it } from 'vitest';
import { deriveRoute } from './route.ts';

describe('deriveRoute', () => {
  it('strips query string', () => {
    expect(deriveRoute('https://example.com/page?q=test&page=2')).toBe(
      'https://example.com/page',
    );
  });

  it('strips non-SPA fragment', () => {
    expect(deriveRoute('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('preserves SPA hash route (#/path)', () => {
    expect(deriveRoute('https://example.com/#/admin')).toBe('https://example.com/#/admin');
  });

  it('preserves SPA hash route (#!/path)', () => {
    expect(deriveRoute('https://example.com/#!/settings')).toBe(
      'https://example.com/#!/settings',
    );
  });

  it('collapses server path for SPA hash routes', () => {
    // When a SPA hash route is present, the server pathname is irrelevant
    const result = deriveRoute('https://example.com/basket#/contact');
    expect(result).toBe('https://example.com/#/contact');
  });

  it('preserves origin + pathname for normal URLs', () => {
    expect(deriveRoute('https://example.com/admin/users')).toBe(
      'https://example.com/admin/users',
    );
  });

  it('handles root URL', () => {
    expect(deriveRoute('https://example.com/')).toBe('https://example.com/');
  });

  it('handles URL with port', () => {
    expect(deriveRoute('http://localhost:3000/api/data')).toBe('http://localhost:3000/api/data');
  });

  it('returns raw string for invalid URL', () => {
    expect(deriveRoute('not-a-url')).toBe('not-a-url');
  });

  it('returns raw string for empty string', () => {
    expect(deriveRoute('')).toBe('');
  });
});
