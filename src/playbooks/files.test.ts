/**
 * files.ts integration tests.
 */

// Ambient `document` for browser-side evaluate callbacks (lib.dom not in tsconfig).
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  getElementById(id: string): { addEventListener(t: string, h: (e: Event) => void): void; files?: { length: number; [n: number]: { name: string } } | null } | null;
};

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { fileDownload, fileUploadValid, registerFilePlaybooks } from './files.ts';
import { PlaybookRegistry, type PlaybookContext } from './framework.ts';
import type { NetworkAnomaly, PageModel } from '../page-model/types.ts';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';

let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

function noopSiteMap(): SiteMapAccessor {
  return {
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
    serialize: () => ({
      startedAt: new Date().toISOString(),
      rootUrl: 'about:blank',
      routes: {},
      pageModels: {},
    }),
  };
}

function makeContext(page: Page, network: NetworkAnomaly[] = []): PlaybookContext {
  const pageModel = async (): Promise<PageModel> => ({
    url: page.url(),
    route: page.url(),
    title: await page.title().catch(() => ''),
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network,
    console: [],
    textHash: '',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  });
  return {
    page,
    pageModel,
    siteMap: noopSiteMap(),
    agentId: 'test-agent',
    persona: '',
    runDir: '/tmp/test',
    logger: createLogger({ level: 'error' }),
    allowedHosts: [],
  };
}

async function fresh(html: string): Promise<Page> {
  const p = await context.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  return p;
}

// ─── file_upload_valid ───────────────────────────────────────────────────────

describe('file_upload_valid', () => {
  it('attaches the fixture and clicks submit on a small text fixture', async () => {
    const html = `
      <!doctype html><html><body>
        <form id="f">
          <input type="file" id="upload" />
          <button type="submit" id="submit">Upload</button>
        </form>
        <script>
          document.getElementById('submit').addEventListener('click', (e) => {
            e.preventDefault();
            const input = document.getElementById('upload');
            const f = input.files && input.files[0];
            if (f) document.body.dataset.uploaded = f.name;
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await fileUploadValid.run(
        {
          formId: 'f',
          fileFixture: { content: 'hello world', name: 'hello.txt', mime: 'text/plain' },
        },
        ctx,
      );
      expect(out.status).toBe('ok');
      expect(out.steps.find((s) => s.label.startsWith('attach file'))?.ok).toBe(true);
      expect(out.steps.find((s) => s.label === 'click submit')?.ok).toBe(true);
      // The uploaded filename was visible to the JS handler.
      expect(await page.evaluate(() => document.body.dataset.uploaded)).toBe('hello.txt');
    } finally {
      await page.close();
    }
  });

  it('returns failed when no input[type=file] exists', async () => {
    const html = `<!doctype html><html><body><form id="f"><input /></form></body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await fileUploadValid.run(
        {
          formId: 'f',
          fileFixture: { content: 'x', name: 'x.txt', mime: 'text/plain' },
        },
        ctx,
      );
      expect(out.status).toBe('failed');
      const step = out.steps.find((s) => s.label === 'locate file input');
      expect(step?.ok).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ─── file_download ───────────────────────────────────────────────────────────

describe('file_download', () => {
  it(
    'returns suspicious when the download action does not produce a download',
    async () => {
      const html = `<!doctype html><html><body>
        <button id="dl">Download</button>
      </body></html>`;
      const page = await fresh(html);
      try {
        const ctx = makeContext(page);
        const out = await fileDownload.run({ actionLocator: '#dl' }, ctx);
        expect(out.status).toBe('suspicious');
        expect((out.evidence as { downloadObserved: boolean }).downloadObserved).toBe(false);
      } finally {
        await page.close();
      }
    },
    15_000,
  );
});

// ─── registry ────────────────────────────────────────────────────────────────

describe('registerFilePlaybooks', () => {
  it('registers all 3 file playbooks', () => {
    const r = new PlaybookRegistry();
    registerFilePlaybooks(r);
    expect(r.size()).toBe(3);
    const names = r.list().map((p) => p.name).sort();
    expect(names).toEqual(['file_download', 'file_upload_invalid', 'file_upload_valid']);
  });
});
