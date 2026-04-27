/**
 * Plugin interfaces. Lets users supply their own auth provider without
 * forking the core. Link extraction and logout detection have been inlined
 * as plain functions (see `src/crawler/extract-links.ts`,
 * `src/safety/logout-guard.ts`); add new abstractions here only when a 2nd
 * implementation actually exists.
 */

import type { BrowserContext, Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';

export interface AuthLoginOpts {
  targetUrl: string;
  credentials: { username?: string; password?: string; token?: string } | null;
  allowedHosts: string[];
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

export interface AuthProvider {
  name: string;
  login(page: Page, opts: AuthLoginOpts): Promise<void>;
  detectAuthWall(url: string): boolean;
  recover(context: BrowserContext, opts: AuthRecoveryOpts): Promise<RecoveryOutcome>;
}
