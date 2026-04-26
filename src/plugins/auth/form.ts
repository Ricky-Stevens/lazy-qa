/**
 * Generic form-login AuthProvider. Wraps the existing `performLogin` /
 * `fillAuthForm` helpers in `src/auth/login.ts` so the orchestrator
 * can talk to a uniform `AuthProvider` interface.
 *
 * Recovery opens a fresh tab on the existing context, navigates to targetUrl,
 * fills the form again, and reloads sibling tabs — same shape as
 * `recoverOneSession` in `src/auth/session-pool.ts` but without the shared
 * session bookkeeping (the AuthProvider is pure: caller owns lifecycles).
 */

import type { BrowserContext, Page } from 'playwright';
import { fillAuthForm } from '../../auth/login.ts';
import type { AuthConfig } from '../../config/types.ts';
import { createNetworkAllowlistRoute } from '../../safety/guards.ts';
import type { AuthLoginOpts, AuthProvider, AuthRecoveryOpts, RecoveryOutcome } from '../types.ts';

/** Coerce the YAML-shaped `auth` blob into the form-specific AuthConfig the
 * existing `fillAuthForm` helper expects. We don't re-validate here — the
 * config layer (`AuthConfigSchema`) has already done that. */
function asAuthConfig(authConfig: Record<string, unknown>): AuthConfig {
  return authConfig as unknown as AuthConfig;
}

function requireUserPass(credentials: AuthLoginOpts['credentials']): {
  username: string;
  password: string;
} {
  if (!credentials || !credentials.username || !credentials.password) {
    throw new Error(
      'form auth provider requires { username, password } credentials — got null/empty.',
    );
  }
  return { username: credentials.username, password: credentials.password };
}

export const formAuthProvider: AuthProvider = {
  name: 'form',

  async login(page: Page, opts: AuthLoginOpts): Promise<void> {
    const auth = asAuthConfig(opts.authConfig);
    const credentials = requireUserPass(opts.credentials);
    const loginUrl = auth.login_url ?? opts.targetUrl;

    opts.logger.info('plugin.auth.form.login.start', {
      loginUrl,
      allowedHosts: opts.allowedHosts,
    });

    // Allowlist enforced for the credential-fill phase only; defends against a
    // 302 to an off-allowlist host steering us into typing creds elsewhere.
    const context = page.context();
    await context.route('**/*', createNetworkAllowlistRoute(opts.allowedHosts));
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await fillAuthForm(page, auth, credentials);
    } finally {
      await context.unroute('**/*').catch(() => undefined);
    }

    opts.logger.info('plugin.auth.form.login.success', { currentUrl: page.url() });
  },

  detectAuthWall(_url: string): boolean {
    // Generic form auth has no portable URL signature — caller-specific
    // providers (auth0, custom) override. Returning false keeps behavior
    // unchanged for vanilla form portals.
    return false;
  },

  async recover(context: BrowserContext, opts: AuthRecoveryOpts): Promise<RecoveryOutcome> {
    const auth = asAuthConfig(opts.authConfig);
    if (!opts.credentials) {
      return {
        ok: false,
        recovered: 0,
        failed: 1,
        detail: 'Cannot recover form session: no credentials provided.',
      };
    }
    let credentials: { username: string; password: string };
    try {
      credentials = requireUserPass(opts.credentials);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, recovered: 0, failed: 1, detail: msg };
    }

    const startedAt = Date.now();
    let recoveryPage: Page | null = null;
    try {
      opts.logger.info('plugin.auth.form.recovery.start', { targetUrl: opts.targetUrl });
      recoveryPage = await context.newPage();
      await recoveryPage.goto(opts.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      // If the app didn't redirect to a login form, assume the session is
      // still alive (or was healed by a sibling) and skip the fill step.
      const url = recoveryPage.url();
      const looksLikeLogin =
        /\/(login|signin|sign-in|u\/login)/i.test(url) || url === (auth.login_url ?? '');
      if (!looksLikeLogin) {
        opts.logger.info('plugin.auth.form.recovery.skip', { reason: 'no login redirect', url });
        return {
          ok: true,
          recovered: 1,
          failed: 0,
          detail: 'Session was already healthy; no re-auth needed.',
        };
      }

      await fillAuthForm(recoveryPage, auth, credentials);

      const otherPages = context.pages().filter((p) => p !== recoveryPage);
      const reloadResults = await Promise.allSettled(
        otherPages.map((p) => p.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })),
      );
      const reloadFailed = reloadResults.filter((r) => r.status === 'rejected').length;

      const elapsed = Date.now() - startedAt;
      return {
        ok: true,
        recovered: 1,
        failed: 0,
        detail: `Re-authenticated in ${elapsed}ms; reloaded ${otherPages.length - reloadFailed}/${otherPages.length} sibling tabs.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn('plugin.auth.form.recovery.failed', { error: msg });
      return { ok: false, recovered: 0, failed: 1, detail: `Recovery failed: ${msg}` };
    } finally {
      if (recoveryPage) await recoveryPage.close().catch(() => undefined);
    }
  },
};
