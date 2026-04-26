/**
 * Tests for security playbooks. Each test launches a real Chromium browser and
 * uses `page.route()` to mock backend responses against a fixed test origin
 * (`https://app.test/`). Probes are invoked through their `run()` function with
 * a synthetic PlaybookContext.
 */

import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import type { PlaybookContext } from './framework.ts';
import {
  __internal,
  clickjackingProbe,
  csrfProbe,
  idorProbe,
  openRedirectProbe,
  resolveOnOrigin,
  roleEscalationProbe,
  sensitiveUrlAudit,
  sessionInvalidationProbe,
  storageInspect,
} from './security.ts';

const APP_ORIGIN = 'https://app.test';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function makeCtx(page: Page): PlaybookContext {
  return {
    page,
    pageModel: async () => {
      throw new Error('not used in security tests');
    },
    siteMap: {
      getRoute: () => undefined,
      getPageModel: () => undefined,
      listAllRoutes: () => [],
      listUnvisitedRoutes: () => [],
      listFormsUntested: () => [],
      listTablesUntested: () => [],
      listModalsUntested: () => [],
      listWizardsUntested: () => [],
      recordVisit: () => {},
      recordPlaybookOutcome: () => {},
      upsertRoute: () => {},
      serialize: () =>
        ({
          startedAt: '',
          rootUrl: APP_ORIGIN,
          routes: {},
          pageModels: {},
        }) as never,
    },
    agentId: 'test-agent',
    persona: '',
    runDir: '/tmp',
    logger: noopLogger,
    // 'app.test' is the hostname of APP_ORIGIN; all probe tests route to this host.
    allowedHosts: ['app.test'],
  };
}

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  if (context) await context.close();
  context = await browser.newContext();
  page = await context.newPage();
});

// -----------------------------------------------------------------------------
// internal helpers
// -----------------------------------------------------------------------------

describe('internal helpers', () => {
  it('resolveOnOrigin returns null for off-allowlist candidates', () => {
    const cur = 'https://app.test/clients/1';
    const hosts = ['app.test'];
    expect(__internal.resolveOnOrigin('https://evil.example.com/x', cur, hosts)).toBeNull();
    expect(__internal.resolveOnOrigin('/clients/2', cur, hosts)).toBe('https://app.test/clients/2');
    expect(__internal.resolveOnOrigin('https://app.test/x', cur, hosts)).toBe('https://app.test/x');
  });

  it('replaceIdSegment swaps numeric id', () => {
    expect(__internal.replaceIdSegment('/clients/1', '99999')).toBe('/clients/99999');
    expect(__internal.replaceIdSegment('/clients/1/edit', '0')).toBe('/clients/0/edit');
  });

  it('replaceIdSegment swaps UUID', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(__internal.replaceIdSegment(`/clients/${uuid}`, 'admin')).toBe('/clients/admin');
  });

  it('replaceIdSegment returns null when no id segment present', () => {
    expect(__internal.replaceIdSegment('/dashboard', '1')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// idor_probe
// -----------------------------------------------------------------------------

describe('idor_probe', () => {
  it('flags suspicious when guessed ids return 200 with content', async () => {
    // Mock /clients/1 → 200 (the user's own client). Other ids → 200 except 99999 and -1 → 404.
    await context.route('**/clients/**', async (route) => {
      const url = new URL(route.request().url());
      const last = url.pathname.split('/').pop() ?? '';
      if (last === '99999' || last === '-1') {
        await route.fulfill({
          status: 404,
          body: '<html><body><h1>Not Found</h1></body></html>',
          contentType: 'text/html',
        });
        return;
      }
      // Treat ANY other id (including '1', '0', 'abc', 'admin', uuid) as 200 with leaked content.
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body><h1>Client ${last}</h1><p>Sensitive data for client ${last}</p></body></html>`,
      });
    });

    await page.goto(`${APP_ORIGIN}/clients/1`);
    const ctx = makeCtx(page);
    const outcome = await idorProbe.run({ routeWithId: '/clients/1' }, ctx);

    // We expect at least one suspicious step (the 200 on a guessed id like 'admin').
    expect(outcome.status).toBe('suspicious');
    const failingSteps = outcome.steps.filter((s) => !s.ok);
    expect(failingSteps.length).toBeGreaterThan(0);
    // 99999 and -1 should NOT be flagged (they 404).
    const flaggedLabels = failingSteps.map((s) => s.label);
    expect(flaggedLabels.some((l) => l.includes('99999'))).toBe(false);
    expect(flaggedLabels.some((l) => l.includes('-1'))).toBe(false);
  });

  it('returns ok if route has no id segment', async () => {
    await page.goto(`data:text/html,<html><body><h1>Dash</h1></body></html>`);
    const ctx = makeCtx(page);
    // page.url() will be data: — resolveOnOrigin won't apply but we short-circuit before.
    const outcome = await idorProbe.run({ routeWithId: '/dashboard' }, ctx);
    expect(outcome.status).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
// storage_inspect
// -----------------------------------------------------------------------------

describe('storage_inspect', () => {
  it('flags JWT-like value in localStorage as suspicious', async () => {
    await context.route('**/storage-test', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Storage</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/storage-test`);
    await page.evaluate(() => {
      // Realistic JWT shape: header.payload.signature (base64-ish).
      // biome-ignore lint/suspicious/noExplicitAny: DOM globals
      const w = globalThis as any;
      w.localStorage.setItem(
        'auth_token',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
      );
      w.sessionStorage.setItem('benign', 'just-a-flag');
    });
    const ctx = makeCtx(page);
    const outcome = await storageInspect.run({}, ctx);
    expect(outcome.status).toBe('suspicious');
    const findings = outcome.evidence.findings as Array<{ kind: string; key: string }>;
    expect(findings.some((f) => f.kind === 'jwt' && f.key === 'auth_token')).toBe(true);
  });

  it('returns ok when storage has no sensitive values', async () => {
    await context.route('**/storage-test', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Storage</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/storage-test`);
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM globals
      const w = globalThis as any;
      w.localStorage.setItem('theme', 'dark');
      w.localStorage.setItem('lang', 'en');
    });
    const ctx = makeCtx(page);
    const outcome = await storageInspect.run({}, ctx);
    expect(outcome.status).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
// clickjacking_probe
// -----------------------------------------------------------------------------

describe('clickjacking_probe', () => {
  // TODO(WP2): wire up; spec'd but never implemented — page.request.fetch() bypasses
  // context.route() intercepts (APIRequestContext is separate from browser routing).
  it.skip('flags suspicious when neither X-Frame-Options nor frame-ancestors is set', async () => {
    await context.route('**/page', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        // Note: no X-Frame-Options, no Content-Security-Policy frame-ancestors.
        headers: { 'content-security-policy': "default-src 'self'" },
        body: '<html><body><h1>Page</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/page`);
    const ctx = makeCtx(page);
    const outcome = await clickjackingProbe.run({ url: '/page' }, ctx);
    expect(outcome.status).toBe('suspicious');
  });

  it('returns ok when X-Frame-Options is set', async () => {
    await context.route('**/safe', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'x-frame-options': 'DENY' },
        body: '<html><body><h1>Safe</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/safe`);
    const ctx = makeCtx(page);
    const outcome = await clickjackingProbe.run({ url: '/safe' }, ctx);
    expect(outcome.status).toBe('ok');
  });

  it('returns ok when CSP frame-ancestors is set', async () => {
    await context.route('**/csp-safe', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'content-security-policy': "frame-ancestors 'self'" },
        body: '<html><body><h1>Safe</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/csp-safe`);
    const ctx = makeCtx(page);
    const outcome = await clickjackingProbe.run({ url: '/csp-safe' }, ctx);
    expect(outcome.status).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
// csrf_probe
// -----------------------------------------------------------------------------

describe('csrf_probe', () => {
  // TODO(WP2): wire up; spec'd but never implemented — page.request.post() bypasses
  // context.route() intercepts (APIRequestContext is separate from browser routing).
  it.skip('returns ok when backend rejects with 403', async () => {
    await context.route('**/api/transfer', async (route) => {
      // Properly-protected: rejects POSTs with attacker referer.
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: '{"error":"forbidden"}',
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`data:text/html,<html><body><h1>Origin</h1></body></html>`);
    // Need a real origin for resolveOnOrigin — navigate to the app first.
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    const outcome = await csrfProbe.run({ actionUrl: '/api/transfer' }, ctx);
    expect(outcome.status).toBe('ok');
    expect(outcome.evidence.status).toBe(403);
  });

  // TODO(WP2): wire up; spec'd but never implemented — page.request.post() bypasses
  // context.route() intercepts (APIRequestContext is separate from browser routing).
  it.skip('flags suspicious when backend accepts 200', async () => {
    await context.route('**/api/transfer', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      await route.continue();
    });
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    const outcome = await csrfProbe.run({ actionUrl: '/api/transfer' }, ctx);
    expect(outcome.status).toBe('suspicious');
    expect(outcome.evidence.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// role_escalation_probe (light coverage)
// -----------------------------------------------------------------------------

describe('role_escalation_probe', () => {
  it('flags suspicious when /admin returns 200 with real content', async () => {
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await context.route('**/admin', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Admin Console</h1><p>Users list</p></body></html>',
      });
    });
    // Other paths → 404
    await context.route('**/internal', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'text/html',
        body: '<html><body><h1>Not Found</h1></body></html>',
      });
    });
    await context.route('**/debug', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'text/html',
        body: '<html><body><h1>Not Found</h1></body></html>',
      });
    });
    await context.route('**/api/users', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"error":"unauthorized"}',
      });
    });
    await context.route('**/api/swagger', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'text/html',
        body: '<html><body><h1>Not Found</h1></body></html>',
      });
    });
    await context.route('**/.git/HEAD', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'text/html',
        body: '<html><body><h1>Not Found</h1></body></html>',
      });
    });
    await context.route('**/api/admin', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'text/html',
        body: '<html><body><h1>Not Found</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    const outcome = await roleEscalationProbe.run({}, ctx);
    expect(outcome.status).toBe('suspicious');
    const flagged = outcome.steps.filter((s) => !s.ok);
    expect(flagged.some((s) => s.label.includes('/admin'))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// sensitive_url_audit (light coverage)
// -----------------------------------------------------------------------------

describe('sensitive_url_audit', () => {
  it('flags 200 on /.git/HEAD even without heading content', async () => {
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await context.route('**/.git/HEAD', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: 'ref: refs/heads/main\n',
      });
    });
    // Everything else 404
    for (const p of [
      '/admin',
      '/internal',
      '/debug',
      '/api/users',
      '/api/swagger',
      '/robots.txt',
      '/sitemap.xml',
      '/api/admin',
      '/.env',
      '/backup',
    ]) {
      await context.route(`**${p}`, async (route) => {
        await route.fulfill({
          status: 404,
          contentType: 'text/html',
          body: '<html><body><h1>Not Found</h1></body></html>',
        });
      });
    }
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    const outcome = await sensitiveUrlAudit.run({ paths: ['/.git/HEAD', '/admin'] }, ctx);
    expect(outcome.status).toBe('suspicious');
    const flagged = outcome.steps.filter((s) => !s.ok);
    expect(flagged.some((s) => s.label.includes('.git'))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// session_invalidation_probe (smoke — verifies redirect-to-login = ok)
// -----------------------------------------------------------------------------

describe('session_invalidation_probe', () => {
  it('returns ok when revisit redirects to login', async () => {
    let loggedOut = false;
    await context.route('**/dashboard', async (route) => {
      if (loggedOut) {
        // Redirect to login.
        await route.fulfill({
          status: 302,
          headers: { location: `${APP_ORIGIN}/login` },
          body: '',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Dashboard</h1></body></html>',
      });
    });
    await context.route('**/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Login</h1></body></html>',
      });
    });
    await context.route('**/logout', async (route) => {
      loggedOut = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`${APP_ORIGIN}/dashboard`);
    const ctx = makeCtx(page);
    const outcome = await sessionInvalidationProbe.run({}, ctx);
    expect(outcome.status).toBe('ok');
  });

  // TODO(WP2): wire up; spec'd but never implemented — page.request.post() bypasses
  // context.route() intercepts, so the logout POST side-effect never fires and
  // the probe exits early on error rather than reaching the revisit step.
  it.skip('flags suspicious when revisit still returns 200 outside /login', async () => {
    await context.route('**/dashboard', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Dashboard</h1></body></html>',
      });
    });
    await context.route('**/logout', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${APP_ORIGIN}/dashboard`);
    const ctx = makeCtx(page);
    const outcome = await sessionInvalidationProbe.run({}, ctx);
    expect(outcome.status).toBe('suspicious');
  });
});

// -----------------------------------------------------------------------------
// open_redirect_probe (smoke)
// -----------------------------------------------------------------------------

describe('open_redirect_probe', () => {
  it('returns ok when app strips evil redirect and stays on origin', async () => {
    await context.route('**/login**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Login</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/login`);
    const ctx = makeCtx(page);
    const outcome = await openRedirectProbe.run({ routeWithRedirect: '/login' }, ctx);
    expect(outcome.status).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
// resolveOnOrigin — focused unit tests (F4 fix)
// -----------------------------------------------------------------------------

describe('resolveOnOrigin', () => {
  const allowed = ['staging.example.com'];

  it('on-host absolute URL passes', () => {
    expect(resolveOnOrigin('/admin', 'https://staging.example.com/x', allowed)).toBe(
      'https://staging.example.com/admin',
    );
  });

  it('off-host absolute URL blocked', () => {
    expect(
      resolveOnOrigin('https://attacker.example/admin', 'https://staging.example.com/x', allowed),
    ).toBeNull();
  });

  it('open-redirect drift blocked even when current URL is off-host', () => {
    // currentUrl is off-host (we drifted); candidate resolves on-host of the drift
    // — but allowedHosts says the drift wasn't authorised, so block.
    expect(resolveOnOrigin('/admin', 'https://attacker.example/x', allowed)).toBeNull();
  });

  it('subdomain of allowed host passes', () => {
    expect(resolveOnOrigin('/x', 'https://api.staging.example.com/y', allowed)).toBe(
      'https://api.staging.example.com/x',
    );
  });

  it('invalid base URL returns null', () => {
    // new URL(candidate, base) throws when base is not a valid absolute URL.
    expect(resolveOnOrigin('/admin', 'not-a-valid-base', allowed)).toBeNull();
  });

  it('empty allowedHosts blocks everything (different semantic from browser-server)', () => {
    // Note: unlike BrowserServerInput where empty=allow-all, security playbooks
    // are stricter — empty allowedHosts means no probing is authorised.
    expect(resolveOnOrigin('/admin', 'https://staging.example.com/', [])).toBeNull();
  });
});
