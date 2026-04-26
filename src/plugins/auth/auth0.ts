/**
 * Auth0 AuthProvider. Delegates initial login to the form provider (Auth0's
 * Universal Login is itself a form), but provides Auth0-specific URL
 * detection and recovery. Lifted from:
 *   - `src/tools/browser-server.ts` `isAuthWallUrl` (URL detection)
 *   - `src/auth/session-pool.ts` `recoverOneSession` (recovery flow)
 *
 * Recovery distinguishes Auth0 from vanilla form auth: the redirect chain on
 * Auth0 always parks the user at `*.auth0.com/u/login/...`, so we re-fill on
 * THAT page (post-redirect) rather than at the configured `login_url` (which
 * is typically the app's domain).
 */

import type { BrowserContext, Page } from 'playwright';
import { fillAuthForm } from '../../auth/login.ts';
import type { AuthConfig } from '../../config/types.ts';
import type { AuthLoginOpts, AuthProvider, AuthRecoveryOpts, RecoveryOutcome } from '../types.ts';
import { formAuthProvider } from './form.ts';

const AUTH0_HOST_RE = /\.auth0\.com$/i;
const AUTH0_PATH_RE = /^\/(u\/login|u\/logout|v2\/logout|oidc\/logout)(\/|$|\?)/;

function asAuthConfig(authConfig: Record<string, unknown>): AuthConfig {
  return authConfig as unknown as AuthConfig;
}

export const auth0Provider: AuthProvider = {
  name: 'auth0',

  async login(page: Page, opts: AuthLoginOpts): Promise<void> {
    // Auth0 Universal Login is a form — same fill semantics as `form`.
    await formAuthProvider.login(page, opts);
  },

  /**
   * Conservative — only flags Auth0 visible-form pages (where the user is
   * stuck on login or logout-confirm). Transient redirects through
   * `/authorize` are NOT flagged because they are part of normal silent
   * re-auth and would create false positives.
   */
  detectAuthWall(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl);
      if (!AUTH0_HOST_RE.test(u.hostname)) return false;
      return AUTH0_PATH_RE.test(u.pathname);
    } catch {
      return false;
    }
  },

  async recover(context: BrowserContext, opts: AuthRecoveryOpts): Promise<RecoveryOutcome> {
    const auth = asAuthConfig(opts.authConfig);
    if (!opts.credentials || !opts.credentials.username || !opts.credentials.password) {
      return {
        ok: false,
        recovered: 0,
        failed: 1,
        detail: 'Cannot recover Auth0 session: missing username/password credentials.',
      };
    }
    const credentials = {
      username: opts.credentials.username,
      password: opts.credentials.password,
    };

    const startedAt = Date.now();
    let recoveryPage: Page | null = null;
    try {
      opts.logger.info('plugin.auth.auth0.recovery.start', { targetUrl: opts.targetUrl });
      recoveryPage = await context.newPage();
      await recoveryPage.goto(opts.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      const url = recoveryPage.url();
      // If we didn't end up at Auth0 (or a /u/login mirror), the session was
      // still alive — bail out as a no-op success.
      if (!/auth0\.com|\/u\/login/i.test(url)) {
        opts.logger.info('plugin.auth.auth0.recovery.skip', {
          reason: 'no auth0 redirect',
          url,
        });
        return {
          ok: true,
          recovered: 1,
          failed: 0,
          detail: 'Session was already healthy; no re-auth needed.',
        };
      }

      await fillAuthForm(recoveryPage, auth, credentials);

      // Force-reload sibling tabs. Auth0 SDK default cacheLocation='memory'
      // means each tab holds its OWN access token in JS memory; the cookie
      // refresh alone won't make those tabs notice. Reload kicks the SDK to
      // re-acquire fresh tokens via the new session cookie.
      const otherPages = context.pages().filter((p) => p !== recoveryPage);
      const reloadResults = await Promise.allSettled(
        otherPages.map((p) => p.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })),
      );
      const reloadFailed = reloadResults.filter((r) => r.status === 'rejected').length;
      if (reloadFailed > 0) {
        opts.logger.warn('plugin.auth.auth0.recovery.reload.partial', {
          total: otherPages.length,
          failed: reloadFailed,
        });
      }

      const elapsed = Date.now() - startedAt;
      opts.logger.info('plugin.auth.auth0.recovery.success', {
        elapsedMs: elapsed,
        currentUrl: recoveryPage.url(),
        pagesReloaded: otherPages.length - reloadFailed,
      });
      return {
        ok: true,
        recovered: 1,
        failed: 0,
        detail: `Re-authenticated in ${elapsed}ms; reloaded ${otherPages.length - reloadFailed}/${otherPages.length} sibling tabs.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn('plugin.auth.auth0.recovery.failed', { error: msg });
      return { ok: false, recovered: 0, failed: 1, detail: `Recovery failed: ${msg}` };
    } finally {
      if (recoveryPage) await recoveryPage.close().catch(() => undefined);
    }
  },
};
