/**
 * Same-origin link extraction. Walks anchors / role=link / data-href /
 * data-routerlink elements on the current page and returns absolute URL
 * candidates. The crawler is responsible for filtering by allowed-hosts;
 * this function does not pre-filter.
 */

import type { Page } from 'playwright';

const NAV_SELECTORS = [
  'a[href]',
  'area[href]',
  '[role="link"]',
  '[data-href]',
  '[data-routerlink]',
];

export async function extractLinks(page: Page): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in Node lib
  type BrowserAny = any;
  return page.evaluate((sels: BrowserAny[]) => {
    const out = new Set<string>();
    const doc = (globalThis as BrowserAny).document;
    for (const sel of sels) {
      for (const el of doc.querySelectorAll(sel)) {
        const href =
          el.getAttribute('href') ??
          el.getAttribute('data-href') ??
          el.getAttribute('data-routerlink');
        if (!href) continue;
        // Filter out non-navigable special-scheme URLs.
        if (
          href.startsWith('#') ||
          href.startsWith('javascript:') ||
          href.startsWith('mailto:') ||
          href.startsWith('tel:')
        ) {
          continue;
        }
        try {
          const u = new URL(href, doc.location.href);
          out.add(u.toString());
        } catch {}
      }
    }
    return Array.from(out);
  }, NAV_SELECTORS);
}
