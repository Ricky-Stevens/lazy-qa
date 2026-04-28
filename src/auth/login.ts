import { access, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium as playwrightChromium } from 'playwright';
import type { AuthConfig } from '../config/types.ts';
import type { Logger } from '../logging/logger.ts';
import { createNetworkAllowlistRoute, isHostAllowed } from '../safety/guards.ts';

/**
 * Fill an Auth0-style login form on an already-navigated page and verify the
 * submission. Used by:
 *   - performLogin (initial agent auth)
 *   - session-pool recovery (re-login after a shared session was killed by a
 *     logout flow — opens a recovery tab, reuses the same fill logic)
 *
 * The page MUST already be on the login URL (post-redirect) before this is
 * called — caller is responsible for the navigation. This function only fills
 * fields, submits, and verifies.
 */
export async function fillAuthForm(
  page: Page,
  auth: AuthConfig,
  credentials: { username: string; password: string },
): Promise<void> {
  if (auth.type !== 'form') {
    throw new Error(`fillAuthForm called on auth.type='${auth.type}' — only 'form' is supported.`);
  }
  const userLoc = page.locator(auth.username_selector).first();
  await userLoc.waitFor({ state: 'visible', timeout: 15_000 });
  await userLoc.fill(credentials.username);

  const passLoc = page.locator(auth.password_selector).first();
  await passLoc.waitFor({ state: 'visible', timeout: 10_000 });
  await passLoc.fill(credentials.password);

  const submitLoc = page.locator(auth.submit_selector).first();
  await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });

  // Submit and race a navigation watcher — some SPAs don't trigger a navigation
  // (they just update state), so we swallow navigation-timeout errors and rely
  // on the success-check below instead.
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined),
    submitLoc.click(),
  ]);

  if (auth.success_url_pattern) {
    const re = new RegExp(auth.success_url_pattern);
    if (!re.test(page.url())) {
      throw new Error(
        `Login verification failed: post-submit URL '${page.url()}' did not match /${auth.success_url_pattern}/`,
      );
    }
  }
  if (auth.wait_for_selector) {
    await page
      .locator(auth.wait_for_selector)
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
  }
  if (!auth.success_url_pattern && !auth.wait_for_selector) {
    // Heuristic only — caller should configure verification when possible.
    if (page.url() === (auth.login_url ?? '')) {
      throw new Error(
        `Login verification: post-submit URL is still the login URL. ` +
          `Configure success_url_pattern or wait_for_selector in target.auth.`,
      );
    }
  }
}

export interface LoginInput {
  targetUrl: string;
  auth: AuthConfig;
  /** Allowed network hosts; enforced via Playwright `route()` during pre-login so
   * a redirect to an off-allowlist host cannot trick us into typing credentials there. */
  allowedHosts: string[];
  credentials: { username: string; password: string } | null;
  runDir: string;
  agentId: string;
  logger: Logger;
  stealth: boolean;
}

export interface LoginResult {
  /** Live browser. Caller MUST `browser.close()` when the agent finishes. */
  browser: Browser;
  /** Logged-in browser context. */
  context: BrowserContext;
  /** Page already on the authenticated landing URL — the in-process browser MCP
   * drives this page directly (no MCP subprocess, no CDP marshaling). */
  page: Page;
  /** Forensic-only path; cookies/localStorage/IndexedDB snapshot for post-mortem. */
  storageStatePath: string;
}

/**
 * Launch a browser using either Playwright (default) or CloakBrowser (stealth mode).
 * When stealth is false, uses Playwright's chromium (fast, bundled).
 * When stealth is true, uses CloakBrowser's stealth binary via dynamic import
 * (no dependency burden on install unless opted in).
 */
export async function launchBrowser(
  stealth: boolean,
  options: Parameters<typeof playwrightChromium.launch>[0],
): Promise<Browser> {
  if (!stealth) {
    return playwrightChromium.launch(options);
  }
  // Dynamic import — only loaded when stealth is on, keeps default install lean.
  // Type as unknown to avoid requiring cloakbrowser at compile time (optional peer dep).
  let cloakbrowser: unknown;
  try {
    // Delay module name from TypeScript's static analysis
    const moduleName = 'cloakbrowser';
    cloakbrowser = await import(moduleName);
  } catch {
    throw new Error(
      'target.stealth is true but cloakbrowser is not installed. Run `bun add cloakbrowser` (or npm/yarn equivalent).',
    );
  }
  // CloakBrowser's launch() returns a real Playwright Browser — same shape as chromium.launch().
  const cb = cloakbrowser as { launch: (opts: unknown) => Promise<Browser> };
  return cb.launch({
    headless: options?.headless ?? true,
    // Pass through proxy / launch options if compatible. Fold into the
    // launchOptions field per CloakBrowser's API.
    launchOptions: options,
  });
}

/**
 * Authenticate a Playwright browser context and return live handles.
 *
 * The same browser stays alive through the agent's exploration loop — the
 * thin in-process Playwright MCP drives `page` directly. Earlier versions saved
 * `storageState.json` and let `@playwright/mcp` launch a separate Chrome with
 * `--storage-state`, but SPAs that hold tokens in JS memory (Auth0 default
 * `cacheLocation: memory`) lose their session across the file-based handoff.
 */
export async function performLogin(input: LoginInput): Promise<LoginResult> {
  const { targetUrl, auth, allowedHosts, credentials, runDir, agentId, logger, stealth } = input;

  const authDir = path.join(runDir, 'auth', agentId);
  await mkdir(authDir, { recursive: true });
  await chmod(authDir, 0o700).catch(() => undefined);
  const storageStatePath = path.join(authDir, 'storage-state.json');

  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

  // Match Playwright MCP's default — Google Chrome stable. Falls back to bundled
  // Chromium for users without Chrome installed; storageState handoff is
  // unreliable across browser binaries for some SSO flows. When stealth is
  // enabled, launchBrowser routes to CloakBrowser's stealth binary instead.
  async function launchChrome(): Promise<Browser> {
    return launchBrowser(stealth, { headless, channel: 'chrome' }).catch(async (err) => {
      logger.warn('login.chrome.fallback', {
        agentId,
        reason: err instanceof Error ? err.message : String(err),
        hint: stealth
          ? 'Run `bun add cloakbrowser` and check that CloakBrowser is properly installed'
          : 'Run `bunx playwright install chrome` for best Auth0/SSO compatibility',
      });
      return launchBrowser(stealth, { headless });
    });
  }

  // ── auth.type === 'none' ──────────────────────────────────────────────────
  if (auth.type === 'none') {
    const browser = await launchChrome();
    const context = auth.storage_state_path
      ? await browser.newContext({
          storageState: path.isAbsolute(auth.storage_state_path)
            ? auth.storage_state_path
            : path.resolve(process.cwd(), auth.storage_state_path),
        })
      : await browser.newContext();
    const page = await context.newPage();
    // Always land on the target — the crawler reads page.url() to derive
    // rootUrl, and the agent's first browser tool would otherwise have to
    // burn a turn on the initial navigate. Best-effort: a goto failure is
    // logged but does not block; the agent can retry.
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((err) => {
      logger.warn('login.goto.failed', {
        agentId,
        targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Best-effort dismiss of persistent banners (cookie consent, welcome
    // splash, EU/GDPR cookie modals). Without this, agents on Juice Shop /
    // any GDPR-banner-wearing app waste 4-9 turns dismissing modals before
    // the snapshot shows non-blocked interactives. Each pattern is tried
    // once with a short timeout — silent on miss.
    await dismissPersistentBanners(page, logger.child({ agentId, phase: 'auto-dismiss' }));
    logger.info('login.skip', { agentId, reason: 'auth.type=none' });
    return { browser, context, page, storageStatePath };
  }

  // ── auth.type === 'form' ──────────────────────────────────────────────────
  if (!credentials) {
    throw new Error(
      `Agent '${agentId}': target.auth.type is 'form' but no credentials were resolved. ` +
        `Populate username_env + password_env in .env.`,
    );
  }

  // Auth-agent path: when a `<runDir>/auth-state.json` file exists, the
  // pre-run AI auth-agent has already logged in and persisted the session.
  // Skip the selector form-fill entirely — load the stored state instead.
  // This is the new default; the form-fill below is a fallback for runs
  // where the auth-agent failed or was never invoked.
  const authStatePath = path.join(runDir, 'auth-state.json');
  const authStateExists = await access(authStatePath)
    .then(() => true)
    .catch(() => false);

  if (authStateExists) {
    logger.info('login.storageState.use', { agentId, authStatePath });
    const browser = await launchChrome();
    try {
      const context = await browser.newContext({ storageState: authStatePath });
      // Match the post-login allowlist behaviour the form-fill path sets up.
      await context.route('**/*', async (route) => {
        const req = route.request();
        const type = req.resourceType();
        if (type !== 'document' && type !== 'xhr' && type !== 'fetch') {
          return route.continue();
        }
        if (isHostAllowed(req.url(), allowedHosts)) return route.continue();
        logger.warn('browser.route.blocked', { url: req.url(), type });
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      await page
        .goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        .catch((err) => {
          logger.warn('login.storageState.goto.failed', {
            agentId,
            targetUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      // Persist a forensic snapshot of the LIVE state (post-storageState load
      // + initial nav) for post-mortem debugging.
      await context
        .storageState({ path: storageStatePath, indexedDB: true })
        .catch(() => undefined);
      await chmod(storageStatePath, 0o600).catch(() => undefined);
      logger.info('login.success', { agentId, currentUrl: page.url(), via: 'storageState' });
      return { browser, context, page, storageStatePath };
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
  }

  // ── Fallback: selector form-fill path (used when no auth-state.json) ──
  const loginUrl = auth.login_url ?? targetUrl;

  logger.info('login.start', { agentId, loginUrl, via: 'form-fill-fallback' });

  const browser = await launchChrome();
  try {
    const context = await browser.newContext();
    // Network allowlist enforced for the credential-fill phase only — without
    // it, a 302 redirect from loginUrl to an attacker-controlled host could
    // steer the browser off-allowlist while page.goto is in flight.
    await context.route('**/*', createNetworkAllowlistRoute(allowedHosts));
    const page = await context.newPage();

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Dismiss cookie / welcome banners BEFORE filling the form. Without this,
    // GDPR-banner-wearing apps (Juice Shop's cookie+welcome stack) leave a
    // modal overlay that intercepts the submit button click and the login
    // times out.
    await dismissPersistentBanners(page, logger.child({ agentId, phase: 'auto-dismiss' }));

    await fillAuthForm(page, auth, credentials);

    // Replace the login-phase allowlist handler with a post-login handler that
    // continues to block off-allowlist document/xhr/fetch requests but allows
    // all subresource types (css, font, image, media, etc.) so staging portals
    // that pull assets from third-party CDNs continue to function correctly.
    await context.unroute('**/*');
    await context.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      // Allow all subresources — blocking these breaks staging portals that
      // use third-party CDNs for fonts, images, stylesheets, etc.
      if (type !== 'document' && type !== 'xhr' && type !== 'fetch') {
        return route.continue();
      }
      if (isHostAllowed(req.url(), allowedHosts)) {
        return route.continue();
      }
      logger.warn('browser.route.blocked', { url: req.url(), type });
      return route.abort('blockedbyclient');
    });

    // Persist a forensic snapshot for post-mortem only.
    await context.storageState({ path: storageStatePath, indexedDB: true }).catch(() => undefined);
    await chmod(storageStatePath, 0o600).catch(() => undefined);

    logger.info('login.success', { agentId, currentUrl: page.url() });
    return { browser, context, page, storageStatePath };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Best-effort dismissal of common persistent banners (GDPR cookie consent,
 * welcome splash, "we use cookies" bars). Tries each pattern with a 1-second
 * timeout; silent on miss. Safe to call against any page — patterns are
 * narrow enough not to fire on real app affordances.
 *
 * Without this, an agent landing on (e.g.) Juice Shop wastes 4-9 turns
 * dismissing the cookie + welcome modal stack before the snapshot reveals
 * the actual product surface — the bareInteractives walker tags everything
 * blocked-by-modal until both modals close.
 */
const PERSISTENT_BANNER_PATTERNS: Array<{ name: string; locator: string }> = [
  // cookieconsent library — Juice Shop uses this. The dismiss target is an
  // <a class="cc-btn cc-dismiss"> with text "Me want it!" (or app-specific).
  // Matched by class because the role is link, not button, and the visible
  // text varies per deployment.
  { name: 'cookieconsent-dismiss', locator: 'a.cc-btn.cc-dismiss, a.cc-dismiss' },
  { name: 'cookieconsent-allow', locator: 'a.cc-btn.cc-allow' },
  // GDPR / cookie banners — broadest match patterns, all dismiss intents.
  { name: 'cookie-dismiss', locator: 'role=button[name=/dismiss cookie|dismiss/i]' },
  { name: 'cookie-accept', locator: 'role=button[name=/accept cookies|accept all|accept/i]' },
  { name: 'cookie-got-it', locator: 'role=button[name=/got it|i agree|^ok$|me want/i]' },
  // Welcome / splash overlays.
  { name: 'welcome-close', locator: 'role=button[name=/close welcome|close banner|got it!/i]' },
  // Angular Material snackbar dismiss — Juice Shop's welcome banner.
  {
    name: 'mat-snackbar-dismiss',
    locator: 'button.mat-mdc-snack-bar-action, button[mat-button]:has-text("Dismiss")',
  },
  // Material / Bootstrap dialog close buttons (last-ditch).
  { name: 'mat-dialog-close', locator: 'button[mat-dialog-close]' },
  { name: 'aria-close-dialog', locator: 'role=dialog >> role=button[name=/^close$/i]' },
];

export async function dismissPersistentBanners(page: Page, logger: Logger): Promise<void> {
  let dismissed = 0;
  for (const pat of PERSISTENT_BANNER_PATTERNS) {
    try {
      const loc = page.locator(pat.locator).first();
      const count = await loc.count();
      if (count === 0) continue;
      // Visibility check — invisible matches mean the dialog isn't open.
      const visible = await loc.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;
      await loc.click({ timeout: 1500 });
      dismissed += 1;
      logger.debug('banner.dismissed', { pattern: pat.name });
      // Small settle pause so subsequent patterns see the post-dismissal DOM.
      await page.waitForTimeout(150);
    } catch (err) {
      // Banner pattern miss is normal — silent unless debug-logging.
      logger.debug('banner.dismiss.skip', {
        pattern: pat.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Demoted to debug — the auto-dismiss runs once per session (crawler +
  // each agent + verifier), so on a 4-agent run with banners that's 6 info
  // lines that say "we did the predictable thing". The operator gets no
  // signal from it. The dismiss event is still recorded at debug level and
  // visible in events.jsonl for any operator who wants to verify wiring.
  if (dismissed > 0) logger.debug('banners.dismissed', { count: dismissed });
}
