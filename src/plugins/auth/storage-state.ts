/**
 * Storage-state AuthProvider. Used when the operator has a pre-built
 * `storageState.json` (cookies + localStorage + IndexedDB) — typical for SSO
 * portals where automation can't drive the login form.
 *
 * IMPORTANT: this provider attaches state at CONTEXT level, not at page
 * level. Playwright's `browser.newContext({ storageState: ... })` is the only
 * supported attachment point; once a context exists, you can't retro-fit
 * storage state. Therefore `login()` here is a no-op verifier — it assumes
 * the caller already created the context with the storage-state file. The
 * orchestrator's pre-login layer reads `authConfig.storage_state_path` and
 * passes it to `browser.newContext`.
 *
 * Recovery is unsupported: if a pre-baked storage-state expires mid-run, we
 * have no credentials to re-auth with. Return a clear error so the supervisor
 * surfaces it instead of silently failing.
 */

import type { BrowserContext, Page } from 'playwright';
import type { AuthLoginOpts, AuthProvider, AuthRecoveryOpts, RecoveryOutcome } from '../types.ts';

export const storageStateProvider: AuthProvider = {
  name: 'storage-state',

  async login(page: Page, opts: AuthLoginOpts): Promise<void> {
    // Best-effort: navigate to the target so the agent doesn't start at
    // about:blank. The context is already authenticated via the pre-baked
    // storageState; if the storage state is stale we'll discover it on the
    // first interaction and the auth-wall detector will catch it.
    try {
      await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      opts.logger.info('plugin.auth.storage-state.login.success', {
        currentUrl: page.url(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn('plugin.auth.storage-state.login.navigate.failed', { error: msg });
      // Don't throw — agent can still retry navigation itself.
    }
  },

  detectAuthWall(_url: string): boolean {
    // No portable signature for storage-state-only flows; the active provider
    // for the *upstream* auth (Auth0 / form) covers detection. Delegate by
    // returning false here.
    return false;
  },

  async recover(_context: BrowserContext, opts: AuthRecoveryOpts): Promise<RecoveryOutcome> {
    opts.logger.warn('plugin.auth.storage-state.recovery.unsupported', {
      targetUrl: opts.targetUrl,
    });
    return {
      ok: false,
      recovered: 0,
      failed: 1,
      detail:
        'storage-state provider cannot recover: no credentials available. Operator must regenerate storageState.json out-of-band.',
    };
  },
};
