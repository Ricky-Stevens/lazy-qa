import type { Browser, BrowserContext, Page } from 'playwright';
import type { AuthConfig } from '../config/types.ts';
import type { Logger } from '../logging/logger.ts';
import { fillAuthForm, performLogin } from './login.ts';

/**
 * Shared browser/context cache. Agents whose credentials hash to the same key
 * share a single browser process — the first agent triggers the login, every
 * subsequent agent in the same group gets a fresh tab on the already-authed
 * context. Saves the 5-8s login on every additional agent.
 *
 * Concurrency: in-flight logins are kept as Promises so two agents spawning
 * simultaneously deduplicate to one performLogin call.
 *
 * Lifecycle: refcount per session. Each agent calls `acquire()` and `release()`
 * exactly once. Browser closes when the last refcount drops to 0.
 *
 * Recovery: when the shared SSO session is killed mid-run (one agent triggers
 * a logout flow, Auth0 server-side session is destroyed, all tabs cascade),
 * `recoverAllSessions()` re-authenticates each active session by opening a
 * recovery tab on its context and running fillAuthForm. Cookies are
 * context-scoped, so the new SSO cookie is visible to all tabs in the context.
 * Per-session in-flight dedup means concurrent recovery calls don't multiply.
 */

interface SharedSession {
  browser: Browser;
  context: BrowserContext;
  primaryPage: Page;
  primaryClaimed: boolean;
  refCount: number;
  /** Captured at first acquire so we can replay the same login on recovery. */
  targetUrl: string;
  auth: AuthConfig;
  credentials: { username: string; password: string } | null;
  /** Last-resort logger to use during recovery (the original agent's logger). */
  logger: Logger;
  /** In-flight recovery promise — concurrent callers piggy-back on this. */
  recoveryInFlight: Promise<RecoveryOutcome> | null;
}

const sessions = new Map<string, Promise<SharedSession>>();
const sessionMutexes = new Map<string, Promise<void>>();

function sessionKey(input: {
  targetUrl: string;
  credentials: { username: string; password: string } | null;
  authType: 'form' | 'none';
}): string {
  const cred = input.credentials
    ? `${input.credentials.username}::${input.credentials.password}`
    : '__none__';
  return `${input.targetUrl}::${input.authType}::${cred}`;
}

export interface AcquireInput {
  targetUrl: string;
  auth: AuthConfig;
  allowedHosts: string[];
  credentials: { username: string; password: string } | null;
  runDir: string;
  agentId: string;
  logger: Logger;
}

export interface AcquireResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Call when the agent is done. Decrements refcount; closes browser at 0. */
  release: () => Promise<void>;
}

export interface RecoveryOutcome {
  ok: boolean;
  /** Number of sessions that re-authenticated successfully. */
  recovered: number;
  /** Number of sessions whose recovery threw. */
  failed: number;
  /** Human-readable detail for logging / agent-facing messages. */
  detail: string;
}

/**
 * Acquire an authenticated tab for an agent. First caller per credential group
 * triggers login; all later callers get a fresh tab on the same context.
 */
export async function acquireSession(input: AcquireInput): Promise<AcquireResult> {
  const key = sessionKey({
    targetUrl: input.targetUrl,
    credentials: input.credentials,
    authType: input.auth.type,
  });

  const prevMutex = sessionMutexes.get(key) ?? Promise.resolve();
  let releaseMutex!: () => void;
  const newMutex = new Promise<void>((r) => {
    releaseMutex = r;
  });
  sessionMutexes.set(
    key,
    prevMutex.then(() => newMutex),
  );
  await prevMutex;

  let session: SharedSession;
  try {
    let pending = sessions.get(key);
    if (!pending) {
      pending = (async (): Promise<SharedSession> => {
        const result = await performLogin({
          targetUrl: input.targetUrl,
          auth: input.auth,
          allowedHosts: input.allowedHosts,
          credentials: input.credentials,
          runDir: input.runDir,
          agentId: input.agentId,
          logger: input.logger,
        });
        return {
          browser: result.browser,
          context: result.context,
          primaryPage: result.page,
          primaryClaimed: false,
          refCount: 0,
          targetUrl: input.targetUrl,
          auth: input.auth,
          credentials: input.credentials,
          logger: input.logger,
          recoveryInFlight: null,
        };
      })();
      sessions.set(key, pending);
    }
    session = await pending;
    session.refCount += 1;
  } finally {
    releaseMutex();
  }

  let page: Page;
  if (!session.primaryClaimed) {
    session.primaryClaimed = true;
    page = session.primaryPage;
    input.logger.info('session.tab.primary', { agentId: input.agentId });
  } else {
    page = await session.context.newPage();
    try {
      await page.goto(input.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (err) {
      input.logger.warn('session.tab.navigate.failed', {
        agentId: input.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    input.logger.info('session.tab.spawned', { agentId: input.agentId });
  }

  let released = false;
  return {
    browser: session.browser,
    context: session.context,
    page,
    release: async () => {
      if (released) return;
      released = true;
      session.refCount -= 1;
      if (session.refCount <= 0) {
        sessions.delete(key);
        await session.browser.close().catch(() => undefined);
        input.logger.info('session.closed', { key });
      }
    },
  };
}

/**
 * Re-authenticate a single shared session by opening a recovery tab on its
 * existing context, navigating to the target URL (which redirects to Auth0),
 * filling the form, and closing the recovery tab. Cookies are context-scoped
 * so all sibling tabs in the context see the new SSO cookie immediately.
 *
 * Per-session dedup: concurrent calls share one in-flight promise.
 */
async function recoverOneSession(session: SharedSession): Promise<RecoveryOutcome> {
  if (session.recoveryInFlight) return session.recoveryInFlight;

  if (session.auth.type !== 'form' || !session.credentials) {
    return {
      ok: false,
      recovered: 0,
      failed: 1,
      detail: 'Cannot recover: session was started without form credentials.',
    };
  }
  const auth = session.auth;
  const credentials = session.credentials;

  const promise = (async (): Promise<RecoveryOutcome> => {
    const startedAt = Date.now();
    let recoveryPage: Page | null = null;
    try {
      session.logger.info('session.recovery.start', { targetUrl: session.targetUrl });
      recoveryPage = await session.context.newPage();
      // Navigate to the app — this should redirect to Auth0 if the SSO session
      // is dead. If it doesn't redirect (session still alive), we're done.
      await recoveryPage.goto(session.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      const url = recoveryPage.url();
      if (!/auth0\.com|\/u\/login/i.test(url)) {
        // App didn't redirect — session still alive (or was already healed).
        session.logger.info('session.recovery.skip', {
          reason: 'no auth-wall redirect',
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

      // Force-reload every other page in the context. Without this, the SPA on
      // those tabs keeps using its in-memory access token (Auth0 SDK default
      // cacheLocation: 'memory') which Auth0 invalidated when we re-logged in.
      // Reloading kicks the SDK to re-acquire fresh tokens via the new cookie.
      // The recovery tab itself is excluded — caller closes it in finally.
      const otherPages = session.context.pages().filter((p) => p !== recoveryPage);
      const reloadResults = await Promise.allSettled(
        otherPages.map((p) => p.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })),
      );
      const reloadFailed = reloadResults.filter((r) => r.status === 'rejected').length;
      if (reloadFailed > 0) {
        session.logger.warn('session.recovery.reload.partial', {
          total: otherPages.length,
          failed: reloadFailed,
        });
      }

      const elapsed = Date.now() - startedAt;
      session.logger.info('session.recovery.success', {
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
      session.logger.warn('session.recovery.failed', { error: msg });
      return { ok: false, recovered: 0, failed: 1, detail: `Recovery failed: ${msg}` };
    } finally {
      if (recoveryPage) {
        await recoveryPage.close().catch(() => undefined);
      }
      session.recoveryInFlight = null;
    }
  })();

  session.recoveryInFlight = promise;
  return promise;
}

/**
 * Recover every active shared session. The supervisor calls this when it
 * detects an agent is auth-walled. Aggregates per-session outcomes.
 */
export async function recoverAllSessions(): Promise<RecoveryOutcome> {
  const active: SharedSession[] = [];
  for (const pending of sessions.values()) {
    try {
      active.push(await pending);
    } catch {
      // session is still resolving or failed — skip
    }
  }

  if (active.length === 0) {
    return {
      ok: false,
      recovered: 0,
      failed: 0,
      detail: 'No active sessions to recover.',
    };
  }

  const outcomes = await Promise.all(active.map(recoverOneSession));
  const recovered = outcomes.reduce((n, o) => n + o.recovered, 0);
  const failed = outcomes.reduce((n, o) => n + o.failed, 0);
  return {
    ok: failed === 0 && recovered > 0,
    recovered,
    failed,
    detail: outcomes.map((o) => o.detail).join(' | '),
  };
}
