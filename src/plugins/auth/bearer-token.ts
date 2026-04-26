/**
 * Bearer-token AuthProvider. Attaches an `Authorization: Bearer <token>`
 * header to every request the context makes. Useful for API-driven SPAs
 * where the agent's traffic is API calls and the page itself is unauthed
 * static HTML, or for portals that accept token auth alongside cookies.
 *
 * Recovery is unsupported by default: token rotation is target-specific
 * (refresh-token endpoints, OAuth flows, etc.) and we don't ship a generic
 * refresh path. Operators with custom refresh logic should subclass /
 * register a custom provider via `regress.config.ts`.
 */

import type { BrowserContext, Page } from 'playwright';
import type { AuthLoginOpts, AuthProvider, AuthRecoveryOpts, RecoveryOutcome } from '../types.ts';

export const bearerTokenProvider: AuthProvider = {
  name: 'bearer',

  async login(page: Page, opts: AuthLoginOpts): Promise<void> {
    const token = opts.credentials?.token;
    if (!token) {
      throw new Error('bearer auth provider requires { token } in credentials — got null/empty.');
    }
    await page.context().setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });

    // Navigate to the target so the agent has somewhere to start.
    try {
      await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      opts.logger.info('plugin.auth.bearer.login.success', { currentUrl: page.url() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn('plugin.auth.bearer.login.navigate.failed', { error: msg });
    }
  },

  detectAuthWall(_url: string): boolean {
    // 401 responses for bearer auth surface as JSON error bodies, not URL
    // changes — there's no portable URL signature. Custom providers can
    // override.
    return false;
  },

  async recover(context: BrowserContext, opts: AuthRecoveryOpts): Promise<RecoveryOutcome> {
    const token = opts.credentials?.token;
    if (!token) {
      return {
        ok: false,
        recovered: 0,
        failed: 1,
        detail: 'bearer recovery: no token available; cannot re-attach Authorization header.',
      };
    }
    // Re-apply the header on the off-chance it was cleared, then reload
    // every page so any in-memory 401 state gets cleared.
    try {
      await context.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
      const pages = context.pages();
      const reloadResults = await Promise.allSettled(
        pages.map((p) => p.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })),
      );
      const reloadFailed = reloadResults.filter((r) => r.status === 'rejected').length;
      return {
        ok: true,
        recovered: 1,
        failed: 0,
        detail: `Re-attached bearer token; reloaded ${pages.length - reloadFailed}/${pages.length} tabs.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn('plugin.auth.bearer.recovery.failed', { error: msg });
      return { ok: false, recovered: 0, failed: 1, detail: `Recovery failed: ${msg}` };
    }
  },
};
