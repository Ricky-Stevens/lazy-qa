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
  headerAudit,
  idorProbe,
  resolveOnOrigin,
  sensitivePathAudit,
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
// internal helpers — resolveOnOrigin
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
// internal helpers — auditHeaders
// -----------------------------------------------------------------------------

describe('auditHeaders (internal)', () => {
  it('flags anti-clickjacking when neither X-Frame-Options nor CSP frame-ancestors is set', () => {
    const result = __internal.auditHeaders(
      { 'content-security-policy': "default-src 'self'" },
      false,
    );
    expect(result.missingCritical).toContain('anti-clickjacking');
  });

  it('is satisfied by X-Frame-Options alone', () => {
    const result = __internal.auditHeaders({ 'x-frame-options': 'DENY' }, false);
    expect(result.missingCritical).not.toContain('anti-clickjacking');
  });

  it('is satisfied by CSP frame-ancestors', () => {
    const result = __internal.auditHeaders(
      { 'content-security-policy': "frame-ancestors 'self'" },
      false,
    );
    expect(result.missingCritical).not.toContain('anti-clickjacking');
  });

  it('skips HSTS check on non-HTTPS', () => {
    // No HSTS header but HTTP — should NOT flag hsts.
    const result = __internal.auditHeaders({ 'x-frame-options': 'DENY' }, false);
    expect(result.missingCritical).not.toContain('hsts');
  });

  it('flags HSTS as missing on HTTPS when header absent', () => {
    const result = __internal.auditHeaders({ 'x-frame-options': 'DENY' }, true);
    expect(result.missingCritical).toContain('hsts');
  });

  it('does not flag HSTS when header is present on HTTPS', () => {
    const result = __internal.auditHeaders(
      { 'x-frame-options': 'DENY', 'strict-transport-security': 'max-age=31536000' },
      true,
    );
    expect(result.missingCritical).not.toContain('hsts');
  });

  it('reports missing nice-to-have headers', () => {
    const result = __internal.auditHeaders({ 'x-frame-options': 'DENY' }, false);
    expect(result.missingNiceToHave).toContain('x-content-type-options');
    expect(result.missingNiceToHave).toContain('referrer-policy');
    expect(result.missingNiceToHave).toContain('content-security-policy');
  });

  it('does not include nice-to-have headers that are present', () => {
    const result = __internal.auditHeaders(
      {
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'",
        'permissions-policy': 'camera=()',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      },
      false,
    );
    expect(result.missingNiceToHave).toHaveLength(0);
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

  it('name is idor_probe', () => {
    expect(idorProbe.name).toBe('idor_probe');
  });
});

// -----------------------------------------------------------------------------
// header_audit — playbook integration
// -----------------------------------------------------------------------------
// Note: page.request.get() is Playwright's APIRequestContext which bypasses
// context.route() intercepts. Integration tests therefore test behaviors that
// don't depend on intercepted HTTP: off-allowlist skipping, fetch-failed
// fallback (→ ok), and evidence shape. The detection logic itself is covered
// thoroughly by the auditHeaders unit tests above.

describe('header_audit', () => {
  it('name is header_audit', () => {
    expect(headerAudit.name).toBe('header_audit');
  });

  it('records off-allowlist path as skipped and returns ok', async () => {
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    const outcome = await headerAudit.run({ paths: ['https://evil.example.com/x'] }, ctx);
    // Off-allowlist path has no missingCritical, so status is ok.
    expect(outcome.status).toBe('ok');
    const results = outcome.evidence.results as Array<{ skipped?: string; path: string }>;
    expect(results[0]?.skipped).toBe('off-allowlist');
    expect(results[0]?.path).toBe('https://evil.example.com/x');
  });

  it('records fetch-failed paths as skipped and returns ok', async () => {
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    // /nonexistent on https://app.test will fail to connect (no real server).
    // The probe catches the error and records it as fetch-failed.
    const outcome = await headerAudit.run({ paths: ['/nonexistent-path-for-test'] }, ctx);
    // fetch-failed paths have missingCritical: [] so status is ok.
    expect(outcome.status).toBe('ok');
    const results = outcome.evidence.results as Array<{
      skipped?: string;
      missingCritical: string[];
    }>;
    expect(results[0]?.skipped).toBe('fetch-failed');
    expect(results[0]?.missingCritical).toHaveLength(0);
  });

  it('collects evidence for multiple paths with mixed results', async () => {
    await context.route('**/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Start</h1></body></html>',
      });
    });
    await page.goto(`${APP_ORIGIN}/start`);
    const ctx = makeCtx(page);
    const outcome = await headerAudit.run(
      {
        paths: ['https://evil.example.com/x', '/nonexistent-path-for-test'],
      },
      ctx,
    );
    const results = outcome.evidence.results as Array<{ skipped?: string }>;
    expect(results).toHaveLength(2);
    expect(results[0]?.skipped).toBe('off-allowlist');
    expect(results[1]?.skipped).toBe('fetch-failed');
  });
});

// -----------------------------------------------------------------------------
// sensitive_path_audit (light coverage)
// -----------------------------------------------------------------------------

describe('sensitive_path_audit', () => {
  it('name is sensitive_path_audit', () => {
    expect(sensitivePathAudit.name).toBe('sensitive_path_audit');
  });

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
    const outcome = await sensitivePathAudit.run({ paths: ['/.git/HEAD', '/admin'] }, ctx);
    expect(outcome.status).toBe('suspicious');
    const flagged = outcome.steps.filter((s) => !s.ok);
    expect(flagged.some((s) => s.label.includes('.git'))).toBe(true);
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

  it('subdomain of allowed host is blocked (strict matching)', () => {
    expect(resolveOnOrigin('/x', 'https://api.staging.example.com/y', allowed)).toBeNull();
  });
  it('subdomain passes when explicitly listed', () => {
    expect(
      resolveOnOrigin('/x', 'https://api.staging.example.com/y', [
        ...allowed,
        'api.staging.example.com',
      ]),
    ).toBe('https://api.staging.example.com/x');
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
