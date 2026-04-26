/**
 * Tests for the browser MCP server.
 *
 * Coverage:
 *   - End-to-end: chromium + a stub SiteMapAccessor + an empty PlaybookRegistry
 *     → snapshot returns a serialized PageModel string.
 *   - Navigation: navigate twice in a row across different routes succeeds.
 *   - Playbook mounting: registering a stub playbook yields an
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
import { type Playbook, type PlaybookContext, PlaybookRegistry } from '../playbooks/framework.ts';
import { ok as okOutcome } from '../playbooks/outcome.ts';
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
      playbookRegistry: new PlaybookRegistry(),
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
      playbookRegistry: new PlaybookRegistry(),
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

  it('mounts registered playbooks as MCP tools and records outcomes', async () => {
    const ctx = await browser.newContext();
    const page: Page = await ctx.newPage();
    await page.setContent('<html><body><h1>Stub</h1></body></html>');

    const registry = new PlaybookRegistry();
    let runCalls = 0;
    let receivedFormId: string | undefined;

    const stub: Playbook<{ formId: string }> = {
      name: 'stub',
      description: 'Stub playbook for tests.',
      categories: ['form'],
      estimatedDurationMs: 10,
      inputShape: { formId: z.string() },
      run: async (input, ctxArg: PlaybookContext) => {
        runCalls += 1;
        receivedFormId = input.formId;
        // Touch ctxArg.pageModel to ensure the cached helper works.
        const model: PageModel = await ctxArg.pageModel();
        return okOutcome('stub', `ran on ${model.route || 'unknown route'}`, {
          formId: input.formId,
        });
      },
    };
    registry.register(stub);

    const { accessor: siteMap, outcomes } = makeFakeSiteMap();
    const { rawTools } = createBrowserMcpServer({
      getPage: () => page,
      logger: makeSilentLogger(),
      runDir,
      siteMap,
      playbookRegistry: registry,
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
      playbookRegistry: new PlaybookRegistry(),
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
      playbookRegistry: new PlaybookRegistry(),
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
      playbookRegistry: new PlaybookRegistry(),
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
