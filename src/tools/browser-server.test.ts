/**
 * Tests for the browser MCP server.
 *
 * Coverage:
 *   - End-to-end: chromium + a stub SiteMapAccessor + an empty playbooks array
 *     → snapshot returns a serialized PageModel string.
 *   - Navigation: navigate twice in a row across different routes succeeds.
 *   - Playbook mounting: passing a stub Skill yields an
 *     `mcp__playbooks__stub` raw tool, and invoking it records into siteMap.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SiteMap, SiteMapAccessor } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import type { PageModel } from '../page-model/types.ts';
import type { PlaybookContext } from '../playbooks/framework.ts';
import { ok as okOutcome } from '../playbooks/outcome.ts';
import type { Skill } from '../skills/loader.ts';
import { createBrowserMcpServer } from './browser-server.ts';

/** Silent logger satisfying the Logger interface. */
function makeSilentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

/** In-memory fake SiteMapAccessor — only the methods exercised by the server
 * are functional; the rest return empty results so unrelated calls don't
 * crash the server during construction. */
function makeFakeSiteMap(): {
  accessor: SiteMapAccessor;
  outcomes: Array<{
    route: string;
    playbookName: string;
    targetId: string | null;
    status: 'ok' | 'failed' | 'suspicious';
  }>;
} {
  const outcomes: Array<{
    route: string;
    playbookName: string;
    targetId: string | null;
    status: 'ok' | 'failed' | 'suspicious';
  }> = [];

  const accessor: SiteMapAccessor = {
    getRoute: () => undefined,
    getPageModel: () => undefined,
    listAllRoutes: () => [],
    listUnvisitedRoutes: () => [],
    listFormsUntested: () => [],
    listTablesUntested: () => [],
    listModalsUntested: () => [],
    listWizardsUntested: () => [],
    recordVisit: () => {},
    recordPlaybookOutcome: (route, playbookName, targetId, status) => {
      outcomes.push({ route, playbookName, targetId, status });
    },
    upsertRoute: () => {},
    serialize: (): SiteMap => ({
      startedAt: new Date().toISOString(),
      rootUrl: '',
      routes: {},
      pageModels: {},
    }),
  };
  return { accessor, outcomes };
}

describe('createBrowserMcpServer', () => {
  let browser: Browser;
  let runDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(path.join(tmpdir(), 'browser-server-test-'));
  });

  afterAll(async () => {
    await browser.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it('snapshot returns a serialized PageModel string', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html>
      <html>
        <head><title>Hello</title></head>
        <body>
          <h1>Heading One</h1>
          <form id="myform">
            <label for="email">Email</label>
            <input id="email" type="email" required />
            <button type="submit">Submit</button>
          </form>
        </body>
      </html>`,
    );

    const { accessor: siteMap } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
      agentId: 'test-agent',
    });

    const snapshot = rawTools.find((t) => t.name === 'snapshot');
    if (!snapshot) throw new Error('snapshot tool not registered');
    const result = await snapshot.handler({});
    const text = result.content[0]?.text ?? '';

    expect(text.startsWith('URL:')).toBe(true);
    expect(text).toContain('Forms (');
    expect(text).toContain('Email');

    await ctx.close();
  });

  it('ax_snapshot returns the page.ariaSnapshot YAML outline', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Mock page.ariaSnapshot — Playwright 1.42+ replacement for the removed
    // page.accessibility.snapshot(). Returns the accessibility tree as YAML.
    const mockYaml = `- document "Test Page":
  - heading "Heading One" [level=1]
  - button "Click Me"
  - form "Test Form":
    - textbox "Email"
    - button "Submit"`;
    // biome-ignore lint/suspicious/noExplicitAny: Test mock
    (page as any).ariaSnapshot = vi.fn().mockResolvedValue(mockYaml);

    const { accessor: siteMap } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
      agentId: 'test-agent',
    });

    const axSnapshot = rawTools.find((t) => t.name === 'ax_snapshot');
    if (!axSnapshot) throw new Error('ax_snapshot tool not registered');

    // Call with default max_depth — full YAML output passes through
    const result = await axSnapshot.handler({});
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('document');
    expect(text).toContain('heading');
    expect(text).toContain('button');
    expect(text).toContain('Heading One');
    expect(text).toContain('Click Me');
    // YAML indentation: nested form children indented under their parent.
    expect(text).toMatch(/\n {2}- /);

    // Lower max_depth truncates the output by line cap (rough proxy).
    const resultWithDepth = await axSnapshot.handler({ max_depth: 1 });
    const textWithDepth = resultWithDepth.content[0]?.text ?? '';
    expect(textWithDepth.length).toBeLessThanOrEqual(text.length);

    await ctx.close();
  });

  it('navigate works without engagement gate (two routes back-to-back)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // data: URLs are valid http-ish for our purposes; navigate takes
    // z.string().url() which accepts data:.  Use a tiny http-ish blank page
    // via about:blank-style data URL to avoid network.
    const urlA = 'data:text/html,<html><body><h1>A</h1></body></html>';
    const urlB = 'data:text/html,<html><body><h1>B</h1></body></html>';

    const { accessor: siteMap } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
    });

    const navigate = rawTools.find((t) => t.name === 'navigate');
    if (!navigate) throw new Error('navigate tool not registered');

    const r1 = await navigate.handler({ url: urlA });
    const t1 = r1.content[0]?.text ?? '';
    expect(t1).not.toContain('REFUSED');
    expect(t1.startsWith('OK navigate(')).toBe(true);

    const r2 = await navigate.handler({ url: urlB });
    const t2 = r2.content[0]?.text ?? '';
    expect(t2).not.toContain('REFUSED');
    expect(t2.startsWith('OK navigate(')).toBe(true);

    await ctx.close();
  });

  it('mounts playbook Skills as MCP tools and records outcomes', async () => {
    const ctx = await browser.newContext();
    const page: Page = await ctx.newPage();
    await page.setContent('<html><body><h1>Stub</h1></body></html>');

    let runCalls = 0;
    let receivedFormId: string | undefined;

    // Build a stub Skill in the Skills format (handler + inputShape).
    const stubSkill: Skill = {
      name: 'stub',
      type: 'playbook',
      description: 'Stub playbook for tests.',
      body: '',
      categories: ['form'],
      estimatedDurationMs: 10,
      inputShape: { formId: z.string() },
      handler: async (input: { formId: string }, ctxArg: PlaybookContext) => {
        runCalls += 1;
        receivedFormId = input.formId;
        // Touch ctxArg.pageModel to ensure the cached helper works.
        const model: PageModel = await ctxArg.pageModel();
        return okOutcome('stub', `ran on ${model.route || 'unknown route'}`, {
          formId: input.formId,
        });
      },
    };

    const { accessor: siteMap, outcomes } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [stubSkill],
    });

    const playbookTool = rawTools.find((t) => t.name === 'mcp__playbooks__stub');
    expect(playbookTool, 'expected mcp__playbooks__stub to be registered').toBeDefined();
    if (!playbookTool) {
      await ctx.close();
      return;
    }

    const result = await playbookTool.handler({ formId: 'form_abc' });
    const text = result.content[0]?.text ?? '';

    expect(runCalls).toBe(1);
    expect(receivedFormId).toBe('form_abc');
    expect(text).toContain('playbook: stub');
    expect(text).toContain('status: ok');

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.playbookName).toBe('stub');
    expect(outcomes[0]?.targetId).toBe('form_abc');
    expect(outcomes[0]?.status).toBe('ok');

    await ctx.close();
  });
});

describe('evaluate handler — redaction', () => {
  let browser: Browser;
  let runDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(path.join(tmpdir(), 'browser-server-evaluate-test-'));
  });

  afterAll(async () => {
    await browser.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it('evaluate handler redacts secret-shaped values in result', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(
      '<html><body><script>window.__sec = {apiKey: "sk-leaked-XYZ"};</script></body></html>',
    );

    const { accessor: siteMap } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
    });

    const evaluate = rawTools.find((t) => t.name === 'evaluate');
    if (!evaluate) throw new Error('evaluate tool not registered');

    const result = await evaluate.handler({ expression: 'window.__sec' });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('sk-leaked-XYZ');
    expect(text).toMatch(/evaluate result/);

    await ctx.close();
  });
});

describe('storage_inspect handler — redaction', () => {
  let browser: Browser;
  let runDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(path.join(tmpdir(), 'browser-server-storage-test-'));
  });

  afterAll(async () => {
    await browser.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it('storage_inspect redacts secret-shaped values', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Navigate to a routed URL so localStorage is accessible (data:/about: contexts block it).
    await ctx.route('**/storage-test', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Storage</h1></body></html>',
      });
    });
    await page.goto('https://app.test/storage-test');

    await page.evaluate(() => {
      localStorage.setItem('auth_token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y');
      localStorage.setItem('theme', 'dark');
    });

    const { accessor: siteMap } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
    });

    const tool = rawTools.find((t) => t.name === 'storage_inspect');
    expect(tool, 'storage_inspect tool not registered').toBeDefined();
    if (!tool) {
      await ctx.close();
      return;
    }

    const result = await tool.handler({});
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('localStorage:');
    // theme is a non-secret key — value passes through unmodified
    expect(text).toContain('theme: dark');
    // auth_token matches SECRET_KEY_RE — value is fingerprinted (not the raw JWT)
    // Fingerprint format: first4…last4
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y');
    // Fingerprint starts with "eyJh" (first 4 chars of the JWT header)
    expect(text).toMatch(/auth_token: eyJh…/);

    await ctx.close();
  });
});

describe('navigate handler — host allowlist', () => {
  let browser: Browser;
  let runDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(path.join(tmpdir(), 'browser-server-allowlist-test-'));
  });

  afterAll(async () => {
    await browser.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it('returns refusal when target host is not in allowedHosts', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const { accessor: siteMap } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
      allowedHosts: ['staging.example.com'],
    });

    const navigate = rawTools.find((t) => t.name === 'navigate');
    if (!navigate) throw new Error('navigate tool not registered');

    const result = await navigate.handler({ url: 'https://attacker.example/path' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/navigate refused.*not in allowed_hosts/);

    await ctx.close();
  });

  it('allows on-host navigation when host is in allowedHosts', async () => {
    const { accessor: siteMap } = makeFakeSiteMap();

    // Stub page — avoids real Chromium network while still exercising the
    // allowlist guard pass-through. parseFresh/speculate failures are
    // caught and logged at debug level by the server, so they don't break
    // the test.
    // biome-ignore lint/suspicious/noExplicitAny: stub Page only implements the subset used by navigate
    const stubPage: any = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://staging.example.com/admin'),
      on: vi.fn(),
    };

    const { rawTools } = createBrowserMcpServer({
      getPage: () => stubPage as Page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
      allowedHosts: ['staging.example.com'],
    });

    const navigate = rawTools.find((t) => t.name === 'navigate');
    if (!navigate) throw new Error('navigate tool not registered');

    const result = await navigate.handler({ url: 'https://staging.example.com/admin' });
    const text = result.content[0]?.text ?? '';

    // Guard passed — must NOT be a refusal
    expect(text).not.toContain('REFUSED');
    expect(text).not.toContain('not in allowed_hosts');
    // page.goto must have been called with the in-allowlist URL
    expect(stubPage.goto).toHaveBeenCalledWith(
      'https://staging.example.com/admin',
      expect.anything(),
    );
  });
});

describe('find_and_click — selector cache integration', () => {
  let runDir: string;
  beforeAll(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), 'browser-server-test-'));
  });
  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function makeStubLocator(opts: { count: number; clickFails?: boolean }) {
    const click = vi.fn(
      opts.clickFails ? () => Promise.reject(new Error('stale')) : () => Promise.resolve(),
    );
    const count = vi.fn().mockResolvedValue(opts.count);
    const first = vi.fn().mockReturnThis();
    return { click, count, first };
  }

  it('cache hit skips multi-strategy probe; miss falls through and writes back; invalidateRoute forces re-probe', async () => {
    const { accessor: siteMap } = makeFakeSiteMap();

    // Build a SelectorCache mock that exercises the three branches.
    const cacheGet = vi.fn();
    const cacheSet = vi.fn();
    const cacheInvalidate = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: minimal SelectorCache stub
    const stubCache: any = {
      get: cacheGet,
      set: cacheSet,
      invalidateRoute: cacheInvalidate,
    };

    // Page that returns a fresh locator stub on each call so we can count
    // .count() invocations (= probe attempts).
    const probeLocator = makeStubLocator({ count: 1 });
    const cachedLocator = makeStubLocator({ count: 1 });
    const pageLocator = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: stub Page subset
    const stubPage: any = {
      url: vi.fn().mockReturnValue('https://staging.example.com/dashboard'),
      locator: pageLocator,
      on: vi.fn(),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const { rawTools } = createBrowserMcpServer({
      getPage: () => stubPage as Page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbooks: [],
      allowedHosts: ['staging.example.com'],
      selectorCache: stubCache,
    });

    const findAndClick = rawTools.find((t) => t.name === 'find_and_click');
    if (!findAndClick) throw new Error('find_and_click tool not registered');

    // 1. COLD CACHE: get returns null → multi-strategy probe runs → set called.
    cacheGet.mockReturnValueOnce(null);
    pageLocator.mockReturnValue(probeLocator);
    const cold = await findAndClick.handler({ hint: 'Save', role: 'button' });
    expect(cold.content[0]?.text ?? '').toContain('via');
    expect(cacheGet).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledWith('/dashboard', 'Save', 'button', expect.any(String));
    // Probe ran: at least one .count() call
    expect(probeLocator.count).toHaveBeenCalled();

    // 2. WARM CACHE: get returns a locator → cached path clicks it → no probe.
    cacheGet.mockReturnValueOnce('role=button[name="Save"]');
    pageLocator.mockReturnValue(cachedLocator);
    const probeCallsBefore = probeLocator.count.mock.calls.length;
    const warm = await findAndClick.handler({ hint: 'Save', role: 'button' });
    expect(warm.content[0]?.text ?? '').toContain('via cache');
    expect(cachedLocator.click).toHaveBeenCalled();
    // Probe locator's count() must NOT have been called again
    expect(probeLocator.count.mock.calls.length).toBe(probeCallsBefore);

    // 3. STALE CACHE: get returns a locator but click fails → invalidateRoute called → probe runs.
    const staleLocator = makeStubLocator({ count: 0, clickFails: true });
    const reprobeLocator = makeStubLocator({ count: 1 });
    cacheGet.mockReturnValueOnce('role=button[name="Save"]');
    // First .locator() call = stale cache attempt; subsequent = re-probe candidates
    pageLocator.mockImplementationOnce(() => staleLocator).mockReturnValue(reprobeLocator);
    const stale = await findAndClick.handler({ hint: 'Save', role: 'button' });
    expect(stale.content[0]?.text ?? '').toContain('via');
    expect(stale.content[0]?.text ?? '').not.toContain('via cache');
    expect(cacheInvalidate).toHaveBeenCalledWith('/dashboard');
    // Re-probe ran
    expect(reprobeLocator.count).toHaveBeenCalled();
  });
});
