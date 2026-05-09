/**
 * Tests for the heuristic site classifier (classifySite).
 * No LLM backend needed — classification is pure string matching.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SiteMap } from '../crawler/types.ts';
import { classifySite } from './site-playbook.ts';

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeSitemap(
  routes: Array<{ url: string; title?: string; forms?: string[]; tables?: string[] }>,
): SiteMap {
  const sm: SiteMap = {
    rootUrl: 'http://localhost:3050',
    startedAt: new Date().toISOString(),
    routes: {},
    pageModels: {},
  };
  for (const r of routes) {
    const route = new URL(r.url).pathname;
    sm.routes[route] = {
      url: r.url,
      route,
      title: r.title ?? '',
      status: 200,
      formIds: r.forms ?? [],
      tableIds: r.tables ?? [],
      modalIds: [],
      wizardIds: [],
      source: 'crawler' as const,
      discoveredAt: new Date().toISOString(),
      visited: false,
    };
    sm.pageModels[route] = {
      url: r.url,
      route,
      title: r.title ?? '',
      primaryHeading: '',
      forms: (r.forms ?? []).map((id) => ({
        id,
        name: id,
        fields: [],
        submitTarget: null,
      })) as never,
      tables: (r.tables ?? []).map((id) => ({ id, name: id, columns: [], rowCount: 0 })) as never,
      modals: [],
      wizards: [],
      toolbars: [],
      navLinks: [],
      bareFields: [],
      bareInteractives: [],
      network: [],
      console: [],
      textHash: 'abc',
      looksBroken: false,
      interactiveCount: 0,
      capturedAt: new Date().toISOString(),
    };
  }
  return sm;
}

describe('classifySite', () => {
  it('classifies an e-commerce site', () => {
    const result = classifySite({
      rootUrl: 'http://localhost:3050',
      sitemap: makeSitemap([
        { url: 'http://localhost:3050/', title: 'Shop' },
        { url: 'http://localhost:3050/products', title: 'Products' },
        { url: 'http://localhost:3050/basket', title: 'Shopping Basket' },
        { url: 'http://localhost:3050/checkout', title: 'Checkout' },
        { url: 'http://localhost:3050/order-history', title: 'Order History' },
      ]),
      logger: makeLogger(),
    });
    expect(result.ok).toBe(true);
    expect(result.siteShape).toBe('ecommerce');
    expect(result.siteSummary).toContain('e-commerce');
    expect(result.costUsd).toBe(0);
  });

  it('classifies an admin/CRUD site', () => {
    const result = classifySite({
      rootUrl: 'http://localhost:3050',
      sitemap: makeSitemap([
        { url: 'http://localhost:3050/admin', title: 'Admin Dashboard' },
        { url: 'http://localhost:3050/admin/users', title: 'Manage Users' },
        { url: 'http://localhost:3050/admin/settings', title: 'Settings' },
        { url: 'http://localhost:3050/admin/roles', title: 'Roles & Permissions' },
      ]),
      logger: makeLogger(),
    });
    expect(result.ok).toBe(true);
    expect(result.siteShape).toBe('admin-crud');
  });

  it('returns unknown for empty sitemap', () => {
    const result = classifySite({
      rootUrl: 'http://localhost:3050',
      sitemap: { rootUrl: 'http://localhost:3050', startedAt: '', routes: {}, pageModels: {} },
      logger: makeLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.siteShape).toBe('unknown');
  });

  it('returns mixed when multiple categories score high', () => {
    const result = classifySite({
      rootUrl: 'http://localhost:3050',
      sitemap: makeSitemap([
        { url: 'http://localhost:3050/shop', title: 'Shop Products' },
        { url: 'http://localhost:3050/cart', title: 'Shopping Cart' },
        { url: 'http://localhost:3050/checkout', title: 'Checkout Payment' },
        { url: 'http://localhost:3050/admin', title: 'Admin Dashboard' },
        { url: 'http://localhost:3050/admin/users', title: 'Manage Users' },
        { url: 'http://localhost:3050/admin/settings', title: 'Admin Settings' },
      ]),
      logger: makeLogger(),
    });
    expect(result.ok).toBe(true);
    expect(result.siteShape).toBe('mixed');
  });

  it('includes interactive counts in summary', () => {
    const result = classifySite({
      rootUrl: 'http://localhost:3050',
      sitemap: makeSitemap([
        {
          url: 'http://localhost:3050/',
          title: 'Home',
          forms: ['login-form', 'search-form'],
          tables: ['products'],
        },
      ]),
      logger: makeLogger(),
    });
    expect(result.siteSummary).toContain('2 forms');
    expect(result.siteSummary).toContain('1 table');
  });

  it('costs zero dollars', () => {
    const result = classifySite({
      rootUrl: 'http://localhost:3050',
      sitemap: makeSitemap([{ url: 'http://localhost:3050/', title: 'Home' }]),
      logger: makeLogger(),
    });
    expect(result.costUsd).toBe(0);
  });
});
