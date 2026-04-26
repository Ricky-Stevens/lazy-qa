/**
 * Async playbooks — async_action_polling, notification_lifecycle,
 * live_updates_audit. These exercise the harder-to-test behaviours: long
 * actions, toast lifecycle, and SSE/WebSocket activity.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { NetworkAnomaly } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const ACTION_TIMEOUT_MS = 5_000;

interface AttemptResult {
  ok: boolean;
  detail?: string;
}

async function attempt(fn: () => Promise<void>): Promise<AttemptResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function record(steps: PlaybookStep[], label: string, result: AttemptResult): boolean {
  steps.push({ label, ok: result.ok, detail: result.detail });
  return result.ok;
}

async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

function isAnomalous(a: NetworkAnomaly): boolean {
  return a.status >= 400 && a.status < 600;
}

async function freshAnomalies(
  ctx: PlaybookContext,
  sinceMs: number,
): Promise<NetworkAnomaly[]> {
  try {
    const model = await ctx.pageModel();
    return model.network.filter((a) => a.ts >= sinceMs && isAnomalous(a));
  } catch {
    return [];
  }
}

function decide(
  playbookName: string,
  summary: string,
  steps: PlaybookStep[],
  evidence: Record<string, unknown>,
  anomalies: NetworkAnomaly[],
): PlaybookOutcome {
  const anyFail = steps.some((s) => !s.ok);
  if (anyFail) {
    const out = fail(playbookName, summary, evidence, steps);
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  if (anomalies.length > 0) {
    const out = suspicious(
      playbookName,
      `${summary} — ${anomalies.length} HTTP error(s) fired during the run`,
      { ...evidence, anomalies },
      steps,
    );
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  return ok(playbookName, summary, evidence, steps);
}

async function captureSnapshot(page: Page): Promise<{ url: string; bodyLen: number }> {
  try {
    return await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
      type BrowserGlobals = { window: any; document: any };
      const g = globalThis as unknown as BrowserGlobals;
      return {
        url: g.window.location.href,
        bodyLen: (g.document.body?.innerText ?? '').length,
      };
    });
  } catch {
    return { url: '', bodyLen: 0 };
  }
}

// ─── async_action_polling ────────────────────────────────────────────────────

export interface AsyncActionPollingInput {
  actionLocator: string;
  maxWaitMs?: number;
}

const asyncActionPollingShape = {
  actionLocator: z.string(),
  maxWaitMs: z.number().int().positive().optional(),
} satisfies z.ZodRawShape;

export const asyncActionPolling: Playbook<AsyncActionPollingInput> = {
  name: 'async_action_polling',
  description:
    'Click an async-triggering action and poll (500ms cadence) for a state change (URL change or body-text change) up to maxWaitMs (default 30s). Inputs: actionLocator, maxWaitMs.',
  categories: ['async'],
  estimatedDurationMs: 30_000,
  inputShape: asyncActionPollingShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const maxWaitMs = input.maxWaitMs ?? 30_000;
    const evidence: Record<string, unknown> = {
      actionLocator: input.actionLocator,
      maxWaitMs,
    };

    const target = ctx.page.locator(input.actionLocator).first();
    if ((await safeCount(target)) === 0) {
      record(steps, 'locate action', {
        ok: false,
        detail: 'action locator did not resolve',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        asyncActionPolling.name,
        `Action ${input.actionLocator} did not resolve`,
        steps,
        evidence,
        anomalies,
      );
    }
    record(steps, 'locate action', { ok: true });

    const before = await captureSnapshot(ctx.page);
    evidence.before = before;

    const clickResult = await attempt(async () => {
      await target.click({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'click action', clickResult);

    let changed = false;
    let after = before;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await ctx.page.waitForTimeout(500).catch(() => {});
      const snap = await captureSnapshot(ctx.page);
      if (snap.url !== before.url || snap.bodyLen !== before.bodyLen) {
        changed = true;
        after = snap;
        break;
      }
    }
    evidence.after = after;
    evidence.stateChanged = changed;
    evidence.elapsedMs = Date.now() - startedAt;

    const anomalies = await freshAnomalies(ctx, startedAt);
    if (!changed) {
      const out = suspicious(
        asyncActionPolling.name,
        `Action ${input.actionLocator}: no state change observed within ${maxWaitMs}ms`,
        evidence,
        steps,
      );
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(
      asyncActionPolling.name,
      `Action ${input.actionLocator}: state change observed in ${evidence.elapsedMs}ms`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── notification_lifecycle ──────────────────────────────────────────────────

export interface NotificationLifecycleInput {
  triggerLocator: string;
}

const notificationLifecycleShape = {
  triggerLocator: z.string(),
} satisfies z.ZodRawShape;

export const notificationLifecycle: Playbook<NotificationLifecycleInput> = {
  name: 'notification_lifecycle',
  description:
    'Click a trigger, wait up to 5s for a toast/[role=alert] to appear, click its dismiss affordance (or wait for auto-dismiss), and verify it disappears. Inputs: triggerLocator.',
  categories: ['async'],
  estimatedDurationMs: 8_000,
  inputShape: notificationLifecycleShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { triggerLocator: input.triggerLocator };

    const trigger = ctx.page.locator(input.triggerLocator).first();
    if ((await safeCount(trigger)) === 0) {
      record(steps, 'locate trigger', {
        ok: false,
        detail: 'trigger locator did not resolve',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        notificationLifecycle.name,
        `Trigger ${input.triggerLocator} did not resolve`,
        steps,
        evidence,
        anomalies,
      );
    }
    record(steps, 'locate trigger', { ok: true });

    const clickResult = await attempt(async () => {
      await trigger.click({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'click trigger', clickResult);

    const TOAST_SELECTORS = [
      '[role=alert]',
      '.toast',
      '[data-testid*=toast]',
      '[class*=Toast]',
      '[class*=Snackbar]',
    ];
    const toastSelector = TOAST_SELECTORS.join(', ');
    let appeared = false;
    const appearDeadline = Date.now() + 5_000;
    while (Date.now() < appearDeadline) {
      if ((await safeCount(ctx.page.locator(toastSelector))) > 0) {
        appeared = true;
        break;
      }
      await ctx.page.waitForTimeout(100).catch(() => {});
    }
    evidence.toastAppeared = appeared;
    record(
      steps,
      'wait for toast',
      appeared ? { ok: true } : { ok: false, detail: 'no toast/alert observed within 5s' },
    );

    if (!appeared) {
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        notificationLifecycle.name,
        `Trigger ${input.triggerLocator}: no toast observed`,
        steps,
        evidence,
        anomalies,
      );
    }

    // Try to dismiss explicitly. Build a single CSS selector string that
    // joins each toast-shape with each dismiss-shape (CSS commas separate
    // whole selectors, so we have to expand the cartesian product).
    const dismissShapes = ['[aria-label="Close"]', 'button'];
    const dismissSelector = TOAST_SELECTORS.flatMap((t) =>
      dismissShapes.map((d) => `${t} ${d}`),
    ).join(', ');
    const dismiss = ctx.page.locator(dismissSelector).first();
    if ((await safeCount(dismiss)) > 0) {
      const r = await attempt(async () => {
        await dismiss.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'click dismiss', r);
    } else {
      record(steps, 'click dismiss', { ok: true, detail: 'no dismiss control; awaiting auto-dismiss' });
    }

    // Verify gone (best-effort, give up to 5s for auto-dismiss).
    let gone = false;
    const goneDeadline = Date.now() + 5_000;
    while (Date.now() < goneDeadline) {
      if ((await safeCount(ctx.page.locator(toastSelector))) === 0) {
        gone = true;
        break;
      }
      await ctx.page.waitForTimeout(100).catch(() => {});
    }
    evidence.toastDismissed = gone;

    const anomalies = await freshAnomalies(ctx, startedAt);
    if (!gone) {
      const out = suspicious(
        notificationLifecycle.name,
        `Trigger ${input.triggerLocator}: toast appeared but never dismissed`,
        evidence,
        steps,
      );
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(
      notificationLifecycle.name,
      `Trigger ${input.triggerLocator}: toast lifecycle ok (appeared and dismissed)`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── live_updates_audit ──────────────────────────────────────────────────────

export interface LiveUpdatesAuditInput {
  route: string;
  observeMs?: number;
}

const liveUpdatesAuditShape = {
  route: z.string(),
  observeMs: z.number().int().positive().optional(),
} satisfies z.ZodRawShape;

export const liveUpdatesAudit: Playbook<LiveUpdatesAuditInput> = {
  name: 'live_updates_audit',
  description:
    'Sit on the given route for observeMs and record any SSE/WebSocket/long-polling activity (event-stream content-type, websocket protocol, or response chunks). Inputs: route, observeMs (default 15000).',
  categories: ['async'],
  estimatedDurationMs: 15_000,
  inputShape: liveUpdatesAuditShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const observeMs = input.observeMs ?? 15_000;
    const evidence: Record<string, unknown> = {
      route: input.route,
      observeMs,
      activity: [] as Array<{ kind: string; url: string; ts: number }>,
    };
    const activity = evidence.activity as Array<{ kind: string; url: string; ts: number }>;

    const responseHandler = (
      res: { headers(): Record<string, string>; url(): string },
    ) => {
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      if (ct.includes('text/event-stream')) {
        activity.push({ kind: 'sse', url: res.url(), ts: Date.now() });
      } else if (ct.includes('application/x-ndjson') || ct.includes('application/stream')) {
        activity.push({ kind: 'stream', url: res.url(), ts: Date.now() });
      }
    };
    // biome-ignore lint/suspicious/noExplicitAny: page WS event arg is loosely typed
    const wsHandler = (ws: any) => {
      activity.push({
        kind: 'websocket',
        url: typeof ws?.url === 'function' ? ws.url() : '<unknown>',
        ts: Date.now(),
      });
    };
    ctx.page.on('response', responseHandler);
    ctx.page.on('websocket', wsHandler);

    try {
      record(steps, 'attach listeners', { ok: true });

      const navResult = await attempt(async () => {
        if (input.route && ctx.page.url() !== input.route) {
          await ctx.page.goto(input.route, { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
        }
      });
      record(steps, 'navigate to route', navResult);

      // Sit and observe.
      await ctx.page.waitForTimeout(observeMs).catch(() => {});

      record(steps, `observe for ${observeMs}ms`, { ok: true });
      evidence.observedCount = activity.length;

      const anomalies = await freshAnomalies(ctx, startedAt);
      const summary = `Live updates on ${input.route}: ${activity.length} live event(s) observed in ${observeMs}ms`;
      return decide(liveUpdatesAudit.name, summary, steps, evidence, anomalies);
    } finally {
      ctx.page.off('response', responseHandler);
      ctx.page.off('websocket', wsHandler);
    }
  },
};

// ─── Registration ───────────────────────────────────────────────────────────

export function registerAsyncPlaybooks(r: PlaybookRegistry): void {
  r.register(asyncActionPolling);
  r.register(notificationLifecycle);
  r.register(liveUpdatesAudit);
}
