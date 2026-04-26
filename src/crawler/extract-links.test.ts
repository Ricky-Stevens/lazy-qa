import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultLinkExtractor } from './extract-links.ts';

let browser: Browser;
let page: Page;

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  // Establish a deterministic origin for relative-URL resolution.
  await page.goto('about:blank');
});

afterEach(async () => {
  await browser?.close();
});

describe('defaultLinkExtractor', () => {
  it('extracts plain anchors, role=link with data-href, and resolves relative URLs', async () => {
    // Use a real-origin route() handler so location.href is meaningful.
    await page.route('https://example.test/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <a href="/a">A</a>
          <a href="https://other.com/x">External</a>
          <span role="link" data-href="/b">B</span>
          <a href="#hash">Hash</a>
          <a href="javascript:void(0)">JS</a>
          <a href="mailto:foo@bar.com">Mail</a>
          <div data-routerlink="/c">C</div>
        </body></html>`,
      });
    });
    await page.goto('https://example.test/');

    const links = await defaultLinkExtractor.extract(page);
    expect(links).toContain('https://example.test/a');
    expect(links).toContain('https://example.test/b');
    expect(links).toContain('https://example.test/c');
    // Off-origin URLs are returned (filtering happens in the crawler).
    expect(links).toContain('https://other.com/x');
    // Hash / javascript: / mailto: are excluded.
    expect(links.some((l) => l.startsWith('javascript:'))).toBe(false);
    expect(links.some((l) => l.startsWith('mailto:'))).toBe(false);
    // The "#hash" anchor resolves to the page URL, not a fragment-only URL —
    // and we explicitly exclude `#`-leading hrefs anyway, so it's absent.
    const fragmentish = links.filter((l) => l.endsWith('#hash'));
    expect(fragmentish).toHaveLength(0);
  });

  it('returns an empty array for a page with no link affordances', async () => {
    await page.setContent('<!doctype html><html><body><p>No links here.</p></body></html>');
    const links = await defaultLinkExtractor.extract(page);
    expect(links).toEqual([]);
  });

  it('deduplicates repeated URLs', async () => {
    await page.route('https://example.test/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <a href="/dup">1</a>
          <a href="/dup">2</a>
          <span role="link" data-href="/dup">3</span>
        </body></html>`,
      });
    });
    await page.goto('https://example.test/');

    const links = await defaultLinkExtractor.extract(page);
    const dupCount = links.filter((l) => l === 'https://example.test/dup').length;
    expect(dupCount).toBe(1);
  });
});
