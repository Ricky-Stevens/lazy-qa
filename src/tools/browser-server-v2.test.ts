/**
 * Tests for the v2 browser MCP server.
 *
 * Coverage:
 *   - End-to-end: chromium + a stub SiteMapAccessor + an empty PlaybookRegistry
 *     → snapshot returns a serialized PageModel string.
 *   - No engagement gate: navigate twice in a row across different routes
 *     succeeds without REFUSED.
 *   - Playbook mounting: registering a stub playbook yields an
 *     `mcp__playbooks__stub` raw tool, and invoking it records into siteMap.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SiteMap, SiteMapAccessor } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import { type PageModel } from '../page-model/types.ts';
import {
  type Playbook,
  type PlaybookContext,
  PlaybookRegistry,
} from '../playbooks/framework.ts';
import { ok as okOutcome } from '../playbooks/outcome.ts';
import { createBrowserMcpServerV2 } from './browser-server-v2.ts';

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

describe('createBrowserMcpServerV2', () => {
  let browser: Browser;
  let runDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(path.join(tmpdir(), 'browser-server-v2-test-'));
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
    const { rawTools } = createBrowserMcpServerV2({
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
    const { rawTools } = createBrowserMcpServerV2({
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
    const { rawTools } = createBrowserMcpServerV2({
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
