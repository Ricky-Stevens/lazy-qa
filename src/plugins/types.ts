/**
 * Plugin interfaces. Lets users supply their own auth provider, link
 * extractor, or logout guard without forking the core.
 */

import type { BrowserContext, Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';

export interface AuthLoginOpts {
  /** Where the agent will start after login. */
  targetUrl: string;
  /** Username / password / token bundle, depending on provider. */
  credentials: { username?: string; password?: string; token?: string } | null;
  /** Allowed-host filter — providers MUST refuse to fill credentials on
   * any host outside this list (defense in depth). */
  allowedHosts: string[];
  /** Selectors / patterns from `target.auth` in the YAML config. Provider
   * may consult these (form auth) or ignore them (token auth). */
  authConfig: Record<string, unknown>;
  logger: Logger;
}

export interface AuthRecoveryOpts {
  targetUrl: string;
  credentials: { username?: string; password?: string; token?: string } | null;
  authConfig: Record<string, unknown>;
  logger: Logger;
}

export interface RecoveryOutcome {
  ok: boolean;
  recovered: number;
  failed: number;
  detail: string;
}

/** Pluggable authentication. Default providers: form, auth0, storage-state, bearer-token. */
export interface AuthProvider {
  /** Identifier referenced in YAML as `auth.type`. */
  name: string;
  /** Perform initial login on a fresh page. Throws on failure. */
  login(page: Page, opts: AuthLoginOpts): Promise<void>;
  /** Detect auth-wall state from a URL — used by the supervisor and the
   * browser server to flag stuck agents. */
  detectAuthWall(url: string): boolean;
  /** Recover a session that has been auth-walled. Called by the supervisor's
   * `relogin_session` tool. */
  recover(context: BrowserContext, opts: AuthRecoveryOpts): Promise<RecoveryOutcome>;
}

/** Pluggable link extractor used by the crawler. Default extracts anchors,
 * `[role=link]`, `[data-href]`, `[data-routerlink]`. */
export interface LinkExtractor {
  name: string;
  /** Return same-origin candidate URLs from the current page. The crawler
   * itself filters by allowed-hosts; extractors should NOT pre-filter. */
  extract(page: Page): Promise<string[]>;
}

/** Pluggable logout guard. Default catches text/href/testid patterns. */
export interface LogoutGuard {
  name: string;
  isLogout(meta: {
    text: string;
    ariaLabel: string;
    href: string;
    testid: string;
    title: string;
  }): { matched: boolean; reason?: string };
}
