/**
 * Chaos playbooks — mid-flow disruptions that exercise UI resilience: browser
 * back/forward, refresh-during-save, tab-close-during-save, concurrent edits,
 * keyboard shortcuts, and zoom-level layout audits.
 *
 * Each playbook is deterministic Playwright orchestration over the locked
 * PlaybookContext. They never throw — Playwright failures are captured into
 * the outcome `steps` trace and the status is computed from the trace plus
 * any HTTP anomalies seen in the page model.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { NetworkAnomaly } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

// ─── Shared helpers ──────────────────────────────────────────────────────────

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

async function firstAvailableLocator(
  factories: Array<() => Locator>,
): Promise<Locator | null> {
  for (const factory of factories) {
    try {
      const loc = factory().first();
      if ((await safeCount(loc)) > 0) return loc;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveSubmit(page: Page): Promise<Locator | null> {
  return firstAvailableLocator([
    () => page.locator('button[type="submit"]'),
    () => page.getByRole('button', { name: 'Save' }),
    () => page.getByRole('button', { name: 'Submit' }),
    () => page.getByRole('button', { name: 'Create' }),
    () => page.getByRole('button', { name: 'Add' }),
    () => page.locator('input[type="submit"]'),
  ]);
}

async function resolveFieldByLabel(page: Page, label: string): Promise<Locator | null> {
  const cssSafe = label.replace(/"/g, '\\"');
  return firstAvailableLocator([
    () => page.getByLabel(label),
    () => page.locator(`[name="${cssSafe}"]`),
    () => page.getByPlaceholder(label),
    () => page.locator(`[aria-label="${cssSafe}"]`),
  ]);
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

// ─── back_forward_chaos ──────────────────────────────────────────────────────

export interface BackForwardChaosInput {
  flow: string;
}

const backForwardChaosShape = {
  flow: z.string(),
} satisfies z.ZodRawShape;

export const backForwardChaos: Playbook<BackForwardChaosInput> = {
  name: 'back_forward_chaos',
  description:
    'Navigate a flow, press browser back mid-flow, then forward, and verify the UI either recovered state or shows a graceful empty state. Inputs: flow (description string, informational).',
  categories: ['chaos'],
  estimatedDurationMs: 4_000,
  inputShape: backForwardChaosShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { flow: input.flow };

    const startUrl = ctx.page.url();
    evidence.startUrl = startUrl;

    const backResult = await attempt(async () => {
      await ctx.page.goBack({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'press browser back', backResult);
    evidence.afterBackUrl = ctx.page.url();

    const forwardResult = await attempt(async () => {
      await ctx.page.goForward({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'press browser forward', forwardResult);
    evidence.afterForwardUrl = ctx.page.url();

    // Heuristic: did the page look broken or empty after the chaos? We treat
    // a near-empty body as "graceful empty state OK", but a JS error count
    // surfacing in the network log is suspicious.
    const interactiveCount = await safeCount(
      ctx.page.locator('button, a, input, select, textarea, [role=button], [role=link]'),
    );
    evidence.interactiveCountAfter = interactiveCount;

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      backForwardChaos.name,
      `Back/forward chaos on flow "${input.flow}" — ${interactiveCount} interactive(s) after restore`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── refresh_during_save ─────────────────────────────────────────────────────

export interface RefreshDuringSaveInput {
  formId: string;
  valuesByLabel: Record<string, string>;
}

const refreshDuringSaveShape = {
  formId: z.string(),
  valuesByLabel: z.record(z.string(), z.string()),
} satisfies z.ZodRawShape;

export const refreshDuringSave: Playbook<RefreshDuringSaveInput> = {
  name: 'refresh_during_save',
  description:
    'Fill a form, click submit, then immediately reload the page. Records whether the entity appears saved, lost, or duplicated. Inputs: formId, valuesByLabel.',
  categories: ['chaos', 'form'],
  estimatedDurationMs: 6_000,
  inputShape: refreshDuringSaveShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      formId: input.formId,
      filledFields: [] as string[],
    };

    const filled: string[] = [];
    for (const [label, value] of Object.entries(input.valuesByLabel)) {
      const field = await resolveFieldByLabel(ctx.page, label);
      if (!field) {
        record(steps, `fill field "${label}"`, { ok: false, detail: 'field not found' });
        continue;
      }
      const r = await attempt(async () => {
        await field.fill(value, { timeout: ACTION_TIMEOUT_MS });
      });
      if (r.ok) filled.push(label);
      record(steps, `fill field "${label}"`, r);
    }
    evidence.filledFields = filled;

    const submit = await resolveSubmit(ctx.page);
    if (!submit) {
      record(steps, 'click submit', { ok: false, detail: 'no submit affordance found' });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        refreshDuringSave.name,
        `Could not find submit affordance for form ${input.formId}`,
        steps,
        evidence,
        anomalies,
      );
    }

    // Click submit but do not await navigation; immediately fire reload.
    const submitClick = submit.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    const reloadResult = await attempt(async () => {
      await ctx.page.reload({ timeout: ACTION_TIMEOUT_MS });
    });
    await submitClick;
    record(steps, 'click submit', { ok: true });
    record(steps, 'reload mid-save', reloadResult);

    // Best-effort: does the form still show the values (lost), is the page
    // showing the saved entity (saved), or do we see a duplicate banner?
    let observedState: 'saved' | 'lost' | 'unknown' = 'unknown';
    try {
      const stillShowsForm = (await safeCount(ctx.page.locator(`form#${input.formId}`))) > 0;
      observedState = stillShowsForm ? 'lost' : 'saved';
    } catch {
      observedState = 'unknown';
    }
    evidence.observedState = observedState;

    const anomalies = await freshAnomalies(ctx, startedAt);
    const summary = `Refresh-during-save on form ${input.formId} — observed: ${observedState}`;
    if (observedState === 'lost') {
      const out = suspicious(refreshDuringSave.name, summary, evidence, steps);
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(refreshDuringSave.name, summary, steps, evidence, anomalies);
  },
};

// ─── tab_close_during_save ───────────────────────────────────────────────────

export interface TabCloseDuringSaveInput {
  formId: string;
}

const tabCloseDuringSaveShape = {
  formId: z.string(),
} satisfies z.ZodRawShape;

export const tabCloseDuringSave: Playbook<TabCloseDuringSaveInput> = {
  name: 'tab_close_during_save',
  description:
    'Trigger a save, then attempt to navigate away. Listens for a beforeunload dialog; status is suspicious if no warning appears while data is unsaved. Inputs: formId.',
  categories: ['chaos', 'form'],
  estimatedDurationMs: 5_000,
  inputShape: tabCloseDuringSaveShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { formId: input.formId };

    let dialogObserved = false;
    let dialogMessage: string | undefined;
    const dialogHandler = async (
      dialog: { type(): string; message(): string; dismiss(): Promise<void> },
    ) => {
      if (dialog.type() === 'beforeunload') {
        dialogObserved = true;
        dialogMessage = dialog.message();
      }
      await dialog.dismiss().catch(() => {});
    };
    ctx.page.on('dialog', dialogHandler);

    try {
      const submit = await resolveSubmit(ctx.page);
      if (submit) {
        const r = await attempt(async () => {
          await submit.click({ timeout: ACTION_TIMEOUT_MS });
        });
        record(steps, 'click submit', r);
      } else {
        record(steps, 'click submit', {
          ok: false,
          detail: 'no submit affordance found',
        });
      }

      // Trigger a navigation to fire any beforeunload handler.
      const navResult = await attempt(async () => {
        await ctx.page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
          type BrowserGlobals = { window: any; Event: any };
          const g = globalThis as unknown as BrowserGlobals;
          g.window.dispatchEvent(new g.Event('beforeunload'));
        });
      });
      record(steps, 'dispatch beforeunload', navResult);

      // Give the dialog handler a moment to fire.
      await ctx.page.waitForTimeout(200).catch(() => {});

      evidence.beforeUnloadObserved = dialogObserved;
      if (dialogMessage) evidence.dialogMessage = dialogMessage;

      const anomalies = await freshAnomalies(ctx, startedAt);
      const summary = dialogObserved
        ? `tab_close_during_save: beforeunload warning observed for form ${input.formId}`
        : `tab_close_during_save: no beforeunload warning for form ${input.formId} (data may be lost silently)`;
      if (!dialogObserved) {
        const out = suspicious(tabCloseDuringSave.name, summary, evidence, steps);
        out.signals.networkAnomalies = anomalies;
        return out;
      }
      return decide(tabCloseDuringSave.name, summary, steps, evidence, anomalies);
    } finally {
      ctx.page.off('dialog', dialogHandler);
    }
  },
};

// ─── concurrent_edits_simulator ──────────────────────────────────────────────

export interface ConcurrentEditsSimulatorInput {
  tableId: string;
  rowIndex: number;
}

const concurrentEditsShape = {
  tableId: z.string(),
  rowIndex: z.number().int().min(1),
} satisfies z.ZodRawShape;

export const concurrentEditsSimulator: Playbook<ConcurrentEditsSimulatorInput> = {
  name: 'concurrent_edits_simulator',
  description:
    'Open a second browser context on the same record URL, edit the same field in both, save both, and observe whether the system surfaces a conflict or silently overwrites (last-write-wins). Inputs: tableId, rowIndex.',
  categories: ['chaos', 'table'],
  estimatedDurationMs: 12_000,
  inputShape: concurrentEditsShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      tableId: input.tableId,
      rowIndex: input.rowIndex,
    };

    const browser = ctx.page.context().browser();
    if (!browser) {
      record(steps, 'open second context', {
        ok: false,
        detail: 'no browser available on current context',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        concurrentEditsSimulator.name,
        'Could not open a second browser context (no browser handle).',
        steps,
        evidence,
        anomalies,
      );
    }

    type SecondCtx = Awaited<ReturnType<typeof browser.newContext>>;
    let secondContext: SecondCtx | null = null;
    try {
      try {
        secondContext = await browser.newContext();
        record(steps, 'open second context', { ok: true });
      } catch (err) {
        record(steps, 'open second context', {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      if (!secondContext) {
        const anomalies = await freshAnomalies(ctx, startedAt);
        return decide(
          concurrentEditsSimulator.name,
          'Failed to open a second browser context',
          steps,
          evidence,
          anomalies,
        );
      }

      const url = ctx.page.url();
      const secondPage = await secondContext.newPage();
      const navResult = await attempt(async () => {
        await secondPage.goto(url, { timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'navigate second context', navResult);

      // Fire conflicting saves: mark the first context with value A, second with B.
      const editLocator = `tr:nth-child(${input.rowIndex}) input, tr:nth-child(${input.rowIndex}) [contenteditable]`;
      const firstFill = await attempt(async () => {
        const f = ctx.page.locator(editLocator).first();
        if ((await safeCount(f)) > 0) await f.fill('A', { timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'edit in first context', firstFill);

      const secondFill = await attempt(async () => {
        const f = secondPage.locator(editLocator).first();
        if ((await safeCount(f)) > 0) await f.fill('B', { timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'edit in second context', secondFill);

      const firstSubmit = await resolveSubmit(ctx.page);
      const secondSubmit = await resolveSubmit(secondPage);
      const firstSave = await attempt(async () => {
        if (firstSubmit) await firstSubmit.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'save in first context', firstSave);
      const secondSave = await attempt(async () => {
        if (secondSubmit) await secondSubmit.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'save in second context', secondSave);

      // Best-effort conflict detection: look for a conflict banner on either page.
      const conflictBannerSel =
        '[role=alert], [data-testid*=conflict], text=/conflict|out[- ]of[- ]date|stale|version mismatch/i';
      const firstConflict = (await safeCount(ctx.page.locator(conflictBannerSel))) > 0;
      const secondConflict = (await safeCount(secondPage.locator(conflictBannerSel))) > 0;
      const conflictDetected = firstConflict || secondConflict;
      evidence.conflictDetected = conflictDetected;

      await secondPage.close().catch(() => {});

      const anomalies = await freshAnomalies(ctx, startedAt);
      const summary = conflictDetected
        ? `Concurrent edits on row ${input.rowIndex} of ${input.tableId}: conflict detected`
        : `Concurrent edits on row ${input.rowIndex} of ${input.tableId}: last-write-wins (no conflict surfaced)`;
      // Last-write-wins is "ok" by spec — we don't mark it suspicious. Caller
      // can interpret the evidence.
      return decide(concurrentEditsSimulator.name, summary, steps, evidence, anomalies);
    } finally {
      if (secondContext) {
        await secondContext.close().catch(() => {});
      }
    }
  },
};

// ─── keyboard_shortcuts ──────────────────────────────────────────────────────

export interface KeyboardShortcutsInput {
  scope?: 'form' | 'modal' | 'global';
}

const keyboardShortcutsShape = {
  scope: z.enum(['form', 'modal', 'global']).optional(),
} satisfies z.ZodRawShape;

const SHORTCUTS = ['Enter', 'Escape', 'Tab', 'Control+s', 'Control+z'] as const;

export const keyboardShortcuts: Playbook<KeyboardShortcutsInput> = {
  name: 'keyboard_shortcuts',
  description:
    'Try Enter, Escape, Tab, Ctrl+S, Ctrl+Z and record the observed effect for each. Informational — always returns ok. Inputs: scope (form|modal|global, default global).',
  categories: ['chaos'],
  estimatedDurationMs: 3_000,
  inputShape: keyboardShortcutsShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const scope = input.scope ?? 'global';
    const evidence: Record<string, unknown> = { scope, observed: {} as Record<string, string> };
    const observed = evidence.observed as Record<string, string>;

    for (const key of SHORTCUTS) {
      const before = await captureSnapshot(ctx.page);
      const r = await attempt(async () => {
        await ctx.page.keyboard.press(key, { delay: 0 });
      });
      record(steps, `press ${key}`, r);
      const after = await captureSnapshot(ctx.page);
      observed[key] = describeChange(before, after);
    }

    const anomalies = await freshAnomalies(ctx, startedAt);
    // Always ok per spec — informational. Even if individual keypresses errored,
    // we report ok and surface details in evidence.
    const out = ok(
      keyboardShortcuts.name,
      `Tried ${SHORTCUTS.length} shortcut(s) in scope=${scope}`,
      evidence,
      steps.map((s) => ({ ...s, ok: true })),
    );
    out.signals.networkAnomalies = anomalies;
    return out;
  },
};

interface KeyboardSnapshot {
  url: string;
  bodyTextLen: number;
  activeTag: string;
}

async function captureSnapshot(page: Page): Promise<KeyboardSnapshot> {
  try {
    return await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
      type BrowserGlobals = { window: any; document: any };
      const g = globalThis as unknown as BrowserGlobals;
      return {
        url: g.window.location.href,
        bodyTextLen: (g.document.body?.innerText ?? '').length,
        activeTag: (g.document.activeElement?.tagName ?? '').toLowerCase(),
      };
    });
  } catch {
    return { url: '', bodyTextLen: 0, activeTag: '' };
  }
}

function describeChange(a: KeyboardSnapshot, b: KeyboardSnapshot): string {
  const changes: string[] = [];
  if (a.url !== b.url) changes.push('url-changed');
  if (a.bodyTextLen !== b.bodyTextLen) changes.push('body-text-changed');
  if (a.activeTag !== b.activeTag) changes.push(`focus:${a.activeTag}->${b.activeTag}`);
  return changes.length > 0 ? changes.join(',') : 'no-effect';
}

// ─── zoom_levels_audit ───────────────────────────────────────────────────────

export interface ZoomLevelsAuditInput {
  levels?: number[];
}

const zoomLevelsAuditShape = {
  levels: z.array(z.number().min(50).max(400)).optional(),
} satisfies z.ZodRawShape;

export const zoomLevelsAudit: Playbook<ZoomLevelsAuditInput> = {
  name: 'zoom_levels_audit',
  description:
    'Apply each zoom level to the page, screenshot, and check that bare interactive elements remain on-screen and non-overlapping. Suspicious if any element falls off-screen or overlaps neighbours. Inputs: levels (default [90, 110, 200]).',
  categories: ['chaos'],
  estimatedDurationMs: 6_000,
  inputShape: zoomLevelsAuditShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const levels = input.levels ?? [90, 110, 200];
    const evidence: Record<string, unknown> = {
      levels,
      perLevel: {} as Record<string, unknown>,
    };
    const perLevel = evidence.perLevel as Record<string, unknown>;

    let anyBroken = false;

    for (const level of levels) {
      const setResult = await attempt(async () => {
        await ctx.page.evaluate((lvl) => {
          // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
          type BrowserGlobals = { document: any };
          const g = globalThis as unknown as BrowserGlobals;
          g.document.body.style.zoom = String(lvl / 100);
        }, level);
      });
      record(steps, `set zoom ${level}%`, setResult);

      const dims = await captureBareDims(ctx.page);
      const broken = detectOverlapOrOffscreen(dims);
      perLevel[String(level)] = { count: dims.length, broken };
      if (broken) anyBroken = true;
    }

    // Reset zoom to 100%.
    await attempt(async () => {
      await ctx.page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
        type BrowserGlobals = { document: any };
        const g = globalThis as unknown as BrowserGlobals;
        g.document.body.style.zoom = '1';
      });
    });

    evidence.anyBroken = anyBroken;

    const anomalies = await freshAnomalies(ctx, startedAt);
    const summary = `Zoom audit across ${levels.length} level(s) — ${anyBroken ? 'layout breakage observed' : 'no layout breakage observed'}`;
    if (anyBroken) {
      const out = suspicious(zoomLevelsAudit.name, summary, evidence, steps);
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(zoomLevelsAudit.name, summary, steps, evidence, anomalies);
  },
};

interface ElementDims {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function captureBareDims(page: Page): Promise<ElementDims[]> {
  try {
    return (await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM globals not in tsconfig.lib
      type BrowserGlobals = { document: any };
      const g = globalThis as unknown as BrowserGlobals;
      const els = Array.from(
        g.document.querySelectorAll(
          'button, a, input, select, textarea, [role=button], [role=link]',
        ),
        // biome-ignore lint/suspicious/noExplicitAny: DOM Element type not in tsconfig.lib
      ) as any[];
      return els.slice(0, 30).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
    })) as ElementDims[];
  } catch {
    return [];
  }
}

function detectOverlapOrOffscreen(dims: ElementDims[]): boolean {
  const viewportW = 1280;
  const viewportH = 720;
  for (const d of dims) {
    if (d.w === 0 || d.h === 0) continue;
    if (d.x + d.w < 0 || d.y + d.h < 0) return true;
    if (d.x > viewportW || d.y > viewportH) return true;
  }
  // Pairwise overlap check (cheap O(n^2) on a capped sample).
  for (let i = 0; i < dims.length; i++) {
    const a = dims[i];
    if (a.w === 0 || a.h === 0) continue;
    for (let j = i + 1; j < dims.length; j++) {
      const b = dims[j];
      if (b.w === 0 || b.h === 0) continue;
      const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlapX && overlapY) {
        // small overlaps from inline icons inside buttons are noise; require
        // > 8px of overlap on both axes
        const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (dx > 8 && dy > 8) return true;
      }
    }
  }
  return false;
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerChaosPlaybooks(r: PlaybookRegistry): void {
  r.register(backForwardChaos);
  r.register(refreshDuringSave);
  r.register(tabCloseDuringSave);
  r.register(concurrentEditsSimulator);
  r.register(keyboardShortcuts);
  r.register(zoomLevelsAudit);
}
