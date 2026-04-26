/**
 * Default link extractor. Pulls candidate URLs out of the live DOM by
 * walking:
 *   - <a href> / <area href>
 *   - [role="link"] (custom-component nav)
 *   - [data-href] / [data-routerlink] (Angular / framework conventions)
 *   - <link rel="prefetch"|"preload"> with a navigable href (Next.js drops
 *     these for every known route — free routes).
 *
 * Same-origin / allowed-host filtering is the CRAWLER's responsibility; this
 * extractor returns every absolute URL it can resolve from the page so the
 * crawler can apply its own policy.
 */

import type { Page } from 'playwright';
import type { LinkExtractor } from '../types.ts';

export const defaultLinkExtractor: LinkExtractor = {
  name: 'default',

  async extract(page: Page): Promise<string[]> {
    // The callback runs in the browser context — `document` and `location`
    // are globals there. tsconfig.lib doesn't include 'dom', so we cast
    // through a minimal local shim rather than polluting the project lib.
    // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
    type BrowserGlobals = { document: any; location: { href: string } };
    return page.evaluate(() => {
      const g = globalThis as unknown as BrowserGlobals;
      const out = new Set<string>();
      const navSels = ['a[href]', 'area[href]', '[role="link"]', '[data-href]', '[data-routerlink]'];
      for (const sel of navSels) {
        for (const el of g.document.querySelectorAll(sel)) {
          const href =
            el.getAttribute('href') ??
            el.getAttribute('data-href') ??
            el.getAttribute('data-routerlink');
          if (!href) continue;
          if (
            href.startsWith('#') ||
            href.startsWith('javascript:') ||
            href.startsWith('mailto:') ||
            href.startsWith('tel:')
          ) {
            continue;
          }
          try {
            out.add(new URL(href, g.location.href).toString());
          } catch {
            // skip malformed
          }
        }
      }
      // Next.js / Remix prefetch hints — `<link rel="prefetch"|"preload">`
      // with a same-origin HTML href reveals routes the SSR shell knows
      // about even before the user clicks anything. Skip non-document
      // resources (CSS, JS chunks, fonts).
      for (const el of g.document.querySelectorAll('link[rel="prefetch"], link[rel="preload"]')) {
        const href = el.getAttribute('href');
        const asAttr = (el.getAttribute('as') ?? '').toLowerCase();
        if (!href) continue;
        if (asAttr && asAttr !== 'document' && asAttr !== 'fetch') continue;
        // Filter obvious non-route static asset paths.
        if (/\.(css|js|mjs|png|jpe?g|gif|svg|webp|woff2?|ico|map|json)(\?|$)/i.test(href)) {
          continue;
        }
        try {
          out.add(new URL(href, g.location.href).toString());
        } catch {
          // skip malformed
        }
      }
      return Array.from(out);
    });
  },
};
