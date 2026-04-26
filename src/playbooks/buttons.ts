/**
 * Button playbooks (spec §6.5).
 *
 * Four playbooks audit the page's buttons by intent:
 *  - `button_navigation_audit` — every navigate-intent button is clicked,
 *    URL change recorded, then we go back.
 *  - `button_action_audit` — every action-intent button is clicked; network
 *    activity for ~2s post-click is captured. 4xx/5xx without UI feedback is
 *    `suspicious`.
 *  - `button_disabled_state_audit` — every disabled element gets a force-click;
 *    URL change or network call is `suspicious`.
 *  - `button_double_click_audit` — primary action buttons are double-clicked
 *    rapidly; duplicate POSTs are `suspicious`.
 *
 * Scope: `'page'` includes `bareInteractives + toolbars + navLinks`; `'nav'`
 * uses only `navLinks`.
 */

import type { Page, Request } from 'playwright';
import { z } from 'zod';
import type { ActionRef, NetworkAnomaly, PageModel } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import type { PlaybookOutcome, PlaybookStep } from './outcome.ts';
import { ok, suspicious } from './outcome.ts';

const POST_CLICK_WINDOW_MS = 2_000;
const PRIMARY_ACTION_RE = /save|submit|create|add|send|update/i;

type Scope = 'page' | 'nav';

interface NetEvent {
  ts: number;
  method: string;
  url: string;
  status?: number;
  resourceType: string;
}

/** Subscribes to page request/response events and returns a stop() that
 * resolves with the captured events. */
function startNetCapture(page: Page) {
  const events: NetEvent[] = [];
  const onRequest = (req: Request) => {
    events.push({
      ts: Date.now(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
    });
  };
  const onResponse = (res: Awaited<ReturnType<Request['response']>>) => {
    if (!res) return;
    const req = res.request();
    const url = req.url();
    const method = req.method();
    const status = res.status();
    // Update the existing event if we recorded its request, else append.
    const existing = events.find(
      (e) => e.method === method && e.url === url && e.status === undefined,
    );
    if (existing) existing.status = status;
    else
      events.push({
        ts: Date.now(),
        method,
        url,
        status,
        resourceType: req.resourceType(),
      });
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    stop: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      return events;
    },
  };
}

/** Filter events to those with status >= 400 (anomalies). */
function anomalies(events: NetEvent[]): NetworkAnomaly[] {
  return events
    .filter((e) => e.status !== undefined && e.status >= 400)
    .map((e) => ({
      ts: e.ts,
      status: e.status as number,
      method: e.method,
      url: e.url,
      resourceType: e.resourceType,
    }));
}

/** XHR/fetch events only — used for double-click duplicate detection. */
function isApiCall(e: NetEvent): boolean {
  return e.resourceType === 'xhr' || e.resourceType === 'fetch';
}

/** Pick the right action set out of the PageModel for `scope`. */
function elementsForScope(model: PageModel, scope: Scope): ActionRef[] {
  if (scope === 'nav') return model.navLinks;
  // 'page' = navLinks + toolbars + bareInteractives
  return [...model.navLinks, ...model.toolbars, ...model.bareInteractives];
}

/** Wait briefly for any user-visible feedback after a click — alert/toast/aria-live update. */
async function detectUiFeedback(page: Page, timeoutMs = 500): Promise<boolean> {
  try {
    const sel =
      '[role=alert], [role=status], [aria-live="polite"], [aria-live="assertive"], .toast, .notification, .error, [data-testid*="error"], [data-testid*="toast"]';
    const el = page.locator(sel).first();
    return await el.isVisible({ timeout: timeoutMs }).catch(() => false);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// button_navigation_audit
// --------------------------------------------------------------------------

interface NavigationAuditInputs {
  scope: Scope;
}

const navigationAudit: Playbook<NavigationAuditInputs> = {
  name: 'button_navigation_audit',
  description:
    'Click every navigate-intent button in scope, record fromRoute → toRoute, then navigate back. Status `ok` if all clicks navigated as expected; `suspicious` if any click did not change the URL.',
  categories: ['button'],
  estimatedDurationMs: 12_000,
  inputShape: { scope: z.enum(['page', 'nav']) },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const candidates = elementsForScope(model, input.scope).filter((e) => e.intent === 'navigate');

    const results: Array<{
      label: string;
      fromRoute: string;
      toRoute: string;
      status: 'ok' | 'failed' | 'suspicious';
      detail?: string;
    }> = [];
    let suspiciousCount = 0;

    for (const ref of candidates) {
      const fromUrl = ctx.page.url();
      const fromRoute = new URL(fromUrl).pathname || fromUrl;
      try {
        const loc = ctx.page.locator(ref.locator).first();
        if (!(await loc.isVisible({ timeout: 200 }).catch(() => false))) {
          results.push({
            label: ref.label,
            fromRoute,
            toRoute: fromRoute,
            status: 'failed',
            detail: 'locator not visible',
          });
          continue;
        }
        await loc.click({ timeout: 1_500 });
        await ctx.page
          .waitForLoadState('domcontentloaded', { timeout: 1_500 })
          .catch(() => undefined);
        const toUrl = ctx.page.url();
        const toRoute = new URL(toUrl).pathname || toUrl;
        const navigated = toUrl !== fromUrl;
        if (!navigated) {
          suspiciousCount += 1;
          results.push({
            label: ref.label,
            fromRoute,
            toRoute,
            status: 'suspicious',
            detail: 'URL did not change',
          });
        } else {
          results.push({ label: ref.label, fromRoute, toRoute, status: 'ok' });
          // Best-effort: navigate back so downstream playbooks see the original page.
          await ctx.page.goBack({ timeout: 2_000 }).catch(() => undefined);
        }
      } catch (err) {
        results.push({
          label: ref.label,
          fromRoute,
          toRoute: fromRoute,
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    steps.push({
      label: 'enumerate navigate-intent elements',
      ok: true,
      detail: `count=${candidates.length}`,
    });
    steps.push({
      label: 'click each element',
      ok: results.every((r) => r.status !== 'failed'),
      detail: `ok=${results.filter((r) => r.status === 'ok').length} suspicious=${suspiciousCount} failed=${results.filter((r) => r.status === 'failed').length}`,
    });

    const evidence = { scope: input.scope, count: candidates.length, results };
    if (suspiciousCount > 0) {
      return suspicious(
        'button_navigation_audit',
        `${suspiciousCount} of ${candidates.length} navigate-intent clicks did not change the URL.`,
        evidence,
        steps,
      );
    }
    if (candidates.length === 0) {
      return ok(
        'button_navigation_audit',
        `No navigate-intent elements in scope=${input.scope}.`,
        evidence,
        steps,
      );
    }
    return ok(
      'button_navigation_audit',
      `All ${candidates.length} navigate-intent clicks behaved.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// button_action_audit
// --------------------------------------------------------------------------

interface ActionAuditInputs {
  scope: Scope;
}

const actionAudit: Playbook<ActionAuditInputs> = {
  name: 'button_action_audit',
  description:
    'Click every action-intent button in scope; capture network calls during the 2s post-click window. Status `suspicious` if any click triggers a 4xx/5xx without visible UI feedback (silent failure).',
  categories: ['button'],
  estimatedDurationMs: 15_000,
  inputShape: { scope: z.enum(['page', 'nav']) },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const candidates = elementsForScope(model, input.scope).filter((e) => e.intent === 'action');

    const perClick: Array<{
      label: string;
      anomalies: NetworkAnomaly[];
      uiFeedback: boolean;
      status: 'ok' | 'failed' | 'suspicious';
      detail?: string;
    }> = [];
    let suspiciousCount = 0;

    for (const ref of candidates) {
      const cap = startNetCapture(ctx.page);
      try {
        const loc = ctx.page.locator(ref.locator).first();
        if (!(await loc.isVisible({ timeout: 200 }).catch(() => false))) {
          cap.stop();
          perClick.push({
            label: ref.label,
            anomalies: [],
            uiFeedback: false,
            status: 'failed',
            detail: 'locator not visible',
          });
          continue;
        }
        await loc.click({ timeout: 1_500 });
        // Wait for the post-click window. Run UI feedback detection in
        // parallel — feedback usually fires sub-500ms, but anomalies need
        // the full window.
        const feedbackPromise = detectUiFeedback(ctx.page, POST_CLICK_WINDOW_MS);
        await ctx.page.waitForTimeout(POST_CLICK_WINDOW_MS);
        const events = cap.stop();
        const anos = anomalies(events);
        const uiFeedback = await feedbackPromise;
        const silentError = anos.length > 0 && !uiFeedback;
        if (silentError) suspiciousCount += 1;
        perClick.push({
          label: ref.label,
          anomalies: anos,
          uiFeedback,
          status: silentError ? 'suspicious' : 'ok',
          detail: silentError
            ? `${anos.length} 4xx/5xx without UI feedback`
            : anos.length
              ? `${anos.length} anomalies but UI feedback shown`
              : undefined,
        });
      } catch (err) {
        cap.stop();
        perClick.push({
          label: ref.label,
          anomalies: [],
          uiFeedback: false,
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    steps.push({
      label: 'enumerate action-intent elements',
      ok: true,
      detail: `count=${candidates.length}`,
    });
    steps.push({
      label: 'click + observe network',
      ok: perClick.every((r) => r.status !== 'failed'),
      detail: `suspicious=${suspiciousCount} failed=${perClick.filter((r) => r.status === 'failed').length}`,
    });

    const evidence = { scope: input.scope, count: candidates.length, results: perClick };
    if (suspiciousCount > 0) {
      return suspicious(
        'button_action_audit',
        `${suspiciousCount} action click(s) returned 4xx/5xx without UI feedback.`,
        evidence,
        steps,
      );
    }
    if (candidates.length === 0) {
      return ok(
        'button_action_audit',
        `No action-intent elements in scope=${input.scope}.`,
        evidence,
        steps,
      );
    }
    return ok(
      'button_action_audit',
      `All ${candidates.length} action clicks completed without silent failures.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// button_disabled_state_audit
// --------------------------------------------------------------------------

interface DisabledStateInputs {
  scope: Scope;
}

const disabledStateAudit: Playbook<DisabledStateInputs> = {
  name: 'button_disabled_state_audit',
  description:
    'For every disabled-flagged element in scope, force-click it (bypass disabled guard) and verify nothing happens — no URL change, no network call. Status `suspicious` if any disabled click changed state.',
  categories: ['button'],
  estimatedDurationMs: 10_000,
  inputShape: { scope: z.enum(['page', 'nav']) },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const candidates = elementsForScope(model, input.scope).filter((e) => e.disabled);

    const results: Array<{
      label: string;
      urlChanged: boolean;
      networkCalls: number;
      status: 'ok' | 'failed' | 'suspicious';
      detail?: string;
    }> = [];
    let suspiciousCount = 0;

    for (const ref of candidates) {
      const beforeUrl = ctx.page.url();
      const cap = startNetCapture(ctx.page);
      try {
        const loc = ctx.page.locator(ref.locator).first();
        // Force-click bypasses Playwright's actionability checks.
        await loc.click({ force: true, timeout: 1_500 });
        await ctx.page.waitForTimeout(500);
        const events = cap.stop();
        const apiCalls = events.filter(isApiCall);
        const afterUrl = ctx.page.url();
        const urlChanged = afterUrl !== beforeUrl;
        const bad = urlChanged || apiCalls.length > 0;
        if (bad) suspiciousCount += 1;
        results.push({
          label: ref.label,
          urlChanged,
          networkCalls: apiCalls.length,
          status: bad ? 'suspicious' : 'ok',
          detail: urlChanged
            ? `URL changed: ${beforeUrl} → ${afterUrl}`
            : apiCalls.length
              ? `${apiCalls.length} API call(s) fired`
              : undefined,
        });
        // If we did navigate, go back so the rest of the audit stays on-page.
        if (urlChanged) await ctx.page.goBack({ timeout: 2_000 }).catch(() => undefined);
      } catch (err) {
        cap.stop();
        results.push({
          label: ref.label,
          urlChanged: false,
          networkCalls: 0,
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    steps.push({
      label: 'enumerate disabled elements',
      ok: true,
      detail: `count=${candidates.length}`,
    });
    steps.push({
      label: 'force-click each disabled element',
      ok: results.every((r) => r.status !== 'failed'),
      detail: `suspicious=${suspiciousCount} failed=${results.filter((r) => r.status === 'failed').length}`,
    });

    const evidence = { scope: input.scope, count: candidates.length, results };
    if (suspiciousCount > 0) {
      return suspicious(
        'button_disabled_state_audit',
        `${suspiciousCount} disabled element(s) responded to force-click.`,
        evidence,
        steps,
      );
    }
    if (candidates.length === 0) {
      return ok(
        'button_disabled_state_audit',
        `No disabled elements in scope=${input.scope}.`,
        evidence,
        steps,
      );
    }
    return ok(
      'button_disabled_state_audit',
      `All ${candidates.length} disabled elements ignored force-click.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// button_double_click_audit
// --------------------------------------------------------------------------

interface DoubleClickInputs {
  scope: Scope;
  primaryOnly?: boolean;
}

const doubleClickAudit: Playbook<DoubleClickInputs> = {
  name: 'button_double_click_audit',
  description:
    'Double-click each primary action button (action-intent matching /save|submit|create|add|send/i). Capture network for 2s. Status `suspicious` if a duplicate POST/PUT to the same URL is observed.',
  categories: ['button'],
  estimatedDurationMs: 12_000,
  inputShape: {
    scope: z.enum(['page', 'nav']),
    primaryOnly: z.boolean().optional(),
  },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const primaryOnly = input.primaryOnly ?? true;
    const model = await ctx.pageModel();

    let candidates = elementsForScope(model, input.scope).filter((e) => e.intent === 'action');
    if (primaryOnly) {
      candidates = candidates.filter((e) => PRIMARY_ACTION_RE.test(e.label));
    }

    const results: Array<{
      label: string;
      clickCount: number;
      duplicateMutations: Array<{ method: string; url: string; count: number }>;
      status: 'ok' | 'failed' | 'suspicious';
      detail?: string;
    }> = [];
    let suspiciousCount = 0;

    for (const ref of candidates) {
      const cap = startNetCapture(ctx.page);
      try {
        const loc = ctx.page.locator(ref.locator).first();
        if (!(await loc.isVisible({ timeout: 200 }).catch(() => false))) {
          cap.stop();
          results.push({
            label: ref.label,
            clickCount: 0,
            duplicateMutations: [],
            status: 'failed',
            detail: 'locator not visible',
          });
          continue;
        }
        // Native double-click with delay 0 between presses.
        await loc.dblclick({ delay: 0, timeout: 1_500 });
        await ctx.page.waitForTimeout(POST_CLICK_WINDOW_MS);
        const events = cap.stop();
        // Count mutating API calls grouped by (method, url).
        const counts = new Map<string, number>();
        for (const e of events) {
          if (!isApiCall(e)) continue;
          if (!/^(POST|PUT|PATCH|DELETE)$/i.test(e.method)) continue;
          const key = `${e.method.toUpperCase()} ${e.url}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const dups: Array<{ method: string; url: string; count: number }> = [];
        for (const [key, count] of counts.entries()) {
          if (count > 1) {
            const [method, url] = key.split(' ');
            dups.push({ method, url, count });
          }
        }
        // Best-effort click-count read: dblclick fires two `click` events on
        // the element, plus a `dblclick`. Most apps count clicks via the
        // `click` listener, so two is the relevant number.
        const clickCount = await loc
          .evaluate((el) => {
            const ds = (el as unknown as { dataset?: Record<string, string> }).dataset;
            return Number(ds?.clicks ?? '0');
          })
          .catch(() => 0);
        const flagged = dups.length > 0;
        if (flagged) suspiciousCount += 1;
        results.push({
          label: ref.label,
          clickCount,
          duplicateMutations: dups,
          status: flagged ? 'suspicious' : 'ok',
          detail: flagged ? `${dups.length} duplicate mutation(s) detected` : undefined,
        });
      } catch (err) {
        cap.stop();
        results.push({
          label: ref.label,
          clickCount: 0,
          duplicateMutations: [],
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    steps.push({
      label: 'enumerate primary action elements',
      ok: true,
      detail: `count=${candidates.length}`,
    });
    steps.push({
      label: 'double-click each primary action',
      ok: results.every((r) => r.status !== 'failed'),
      detail: `suspicious=${suspiciousCount} failed=${results.filter((r) => r.status === 'failed').length}`,
    });

    const evidence = {
      scope: input.scope,
      primaryOnly,
      count: candidates.length,
      results,
    };
    if (suspiciousCount > 0) {
      return suspicious(
        'button_double_click_audit',
        `${suspiciousCount} double-click(s) produced duplicate mutations.`,
        evidence,
        steps,
      );
    }
    if (candidates.length === 0) {
      return ok(
        'button_double_click_audit',
        `No primary action elements in scope=${input.scope}.`,
        evidence,
        steps,
      );
    }
    return ok(
      'button_double_click_audit',
      `Double-click on ${candidates.length} primary action(s) produced no duplicate mutations.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

export function registerButtonPlaybooks(r: PlaybookRegistry): void {
  r.register(navigationAudit);
  r.register(actionAudit);
  r.register(disabledStateAudit);
  r.register(doubleClickAudit);
}

// Internal exports for tests.
export const __buttonPlaybooks = {
  navigationAudit,
  actionAudit,
  disabledStateAudit,
  doubleClickAudit,
};

export type { ActionAuditInputs, DisabledStateInputs, DoubleClickInputs, NavigationAuditInputs };
export type ButtonPlaybookCtx = PlaybookContext;
export type ButtonPlaybookOutcome = PlaybookOutcome;
