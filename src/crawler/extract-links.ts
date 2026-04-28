/**
 * Same-origin link extraction. Walks anchors / role=link / data-href /
 * data-routerlink elements on the current page and returns absolute URL
 * candidates. The crawler is responsible for filtering by allowed-hosts;
 * this function does not pre-filter.
 *
 * SPA-aware: Angular / Vue / React-Router apps frequently route via hash
 * fragments shaped `#/path` or `#!/path`. We treat those as full routes —
 * dropping them silently was the reason the crawler found 2 routes on
 * Juice Shop (everything was hash-routed).
 */

import type { Page } from 'playwright';

const NAV_SELECTORS = [
  'a[href]',
  'area[href]',
  '[role="link"]',
  '[data-href]',
  '[data-routerlink]',
  '[routerLink]',
  '[ng-reflect-router-link]',
];

/** A link href is a SPA hash-route if it looks like `#/foo` or `#!/foo`.
 *  Pure fragment-only links (`#section`, `#`) are anchor jumps, not routes. */
function isSpaHashRoute(href: string): boolean {
  return /^#!?\//.test(href);
}

export async function extractLinks(page: Page): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in Node lib
  type BrowserAny = any;
  return page.evaluate(
    ({ sels, hashRouteRe }: { sels: BrowserAny[]; hashRouteRe: string }) => {
      const out = new Set<string>();
      const doc = (globalThis as BrowserAny).document;
      const re = new RegExp(hashRouteRe);
      for (const sel of sels) {
        for (const el of doc.querySelectorAll(sel)) {
          const href =
            el.getAttribute('href') ??
            el.getAttribute('data-href') ??
            el.getAttribute('data-routerlink') ??
            el.getAttribute('routerLink') ??
            el.getAttribute('ng-reflect-router-link');
          if (!href) continue;
          // Skip non-navigable schemes.
          if (
            href.startsWith('javascript:') ||
            href.startsWith('mailto:') ||
            href.startsWith('tel:')
          ) {
            continue;
          }
          // Skip fragment-only anchors (`#section`, `#`) — but allow SPA
          // hash-routes (`#/path`, `#!/path`). Anything else, let URL()
          // resolve relative to document.location.
          if (href.startsWith('#') && !re.test(href)) continue;
          try {
            const u = new URL(href, doc.location.href);
            out.add(u.toString());
          } catch {}
        }
      }
      return Array.from(out);
    },
    { sels: NAV_SELECTORS, hashRouteRe: '^#!?/' },
  );
}

// Re-exported so other modules (sitemap, crawler) can identify SPA routes
// and avoid normalising the hash off when computing the route key.
export { isSpaHashRoute };
