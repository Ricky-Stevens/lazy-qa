/**
 * Non-destructive affordance probe.
 *
 * The crawler can only walk the link graph — modals, kebab menus, "Add"
 * buttons that open dialogs, multi-step wizards reached through buttons,
 * and other in-page interactions are invisible to it. This probe fills the
 * gap by *clicking* a curated, non-destructive subset of an already-parsed
 * PageModel's interactive elements and observing what each one opens.
 *
 * Each click is followed by a dismiss attempt (Escape, then any visible
 * Close/X/Cancel). If the URL changed, we navigate back. The intent is to
 * surface "this button opens an Edit modal" / "this kebab menu has Edit,
 * Disable, Duplicate" without actually mutating any application state.
 *
 * Output: an array of `DiscoveredAffordance`s suitable for
 * `PageModel.discovered`. Agents read this in their per-turn snapshot and
 * use it to decide where to deepen their exploration.
 */

import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';
import type {
  ActionRef,
  AffordanceOutcome,
  DiscoveredAffordance,
  PageModel,
} from '../page-model/types.ts';
import { isHostAllowed } from '../safety/guards.ts';

export interface AffordanceProbeOptions {
  /** Per-click timeout (ms). Default 600ms. */
  perClickTimeoutMs: number;
  /** Time to wait for state to settle after a click. Default 350ms. */
  postClickSettleMs: number;
  /** Hard cap on total wall-clock for the probe. Default 10_000ms. */
  totalBudgetMs: number;
  /** Cap on toolbar/header/page-button candidates. Default 12. */
  maxToolbarProbes: number;
  /** Cap on row-action probes (one per table). Default 5. */
  maxRowActionProbes: number;
  /** Logger. */
  logger?: Logger;
  /** Hosts the probe is allowed to navigate to. If set and non-empty, any
   * restore-navigation to an off-allowlist URL is skipped rather than executed.
   * This guards against a prior navigation having landed on an off-allowlist URL
   * that we should not revisit. */
  allowedHosts?: string[];
}

const DEFAULT_OPTIONS: AffordanceProbeOptions = {
  perClickTimeoutMs: 600,
  postClickSettleMs: 350,
  totalBudgetMs: 10_000,
  maxToolbarProbes: 12,
  maxRowActionProbes: 5,
};

/** Labels that indicate the affordance is safe to open and close. The probe
 * will only click toolbar/header/page-level buttons whose label matches one
 * of these prefixes. Row kebabs bypass this allowlist (they're naturally
 * read-only) but still apply the destructive blocklist below. */
const SAFE_PREFIX_RE =
  /^(add|new|create|open|view|edit|import|export|settings|more|filter|sort|configure|manage|help|about|preferences|customize|columns|options|actions|browse|search|expand|details|info|continue|next|get\s*started|begin)\b|\.\.\.$/i;

/** Labels that we MUST NOT click — irreversibly mutates state, signs the
 * user out, or fires off a destructive action. Applied to every candidate
 * regardless of context. */
const DESTRUCTIVE_RE =
  /\b(save|submit|delete|remove|discard|confirm|apply|publish|send|pay|buy|purchase|reset|restart|shutdown|sign\s*out|log\s*out|logout|deactivate|archive|trash|approve|reject|merge|deploy|upgrade|downgrade|cancel\s*subscription|unsubscribe|disable|enable|activate|promote|demote|suspend|ban|lock|unlock|refund|charge|issue|resend|sync|run|execute|trigger|notify|invite|verify|authorize|grant|revoke|email|fire|kick|expire)\b/i;

/** Labels that indicate this click WILL navigate (so we'd burn a probe slot
 * just to see "navigation"). The crawler already handles links — skip. */
const NAV_LIKE_RE = /^(back|home|return|go to|previous|next page|forward)\b/i;

/** Heuristic: does this trigger look like a kebab/menu opener? Used both
 * for picking row-action probes and for accepting kebabs in toolbars even
 * if their label doesn't match SAFE_PREFIX_RE. */
function looksLikeKebab(ref: ActionRef): boolean {
  const label = ref.label.trim();
  return (
    label === '⋮' ||
    label === '⋯' ||
    label === '...' ||
    label.endsWith('...') ||
    /^(more|options|actions|menu|kebab|overflow)\b/i.test(label)
  );
}

/** Filter toolbar/header/page-level candidates to those we're allowed to
 * probe. Order is preserved. */
function pickToolbarCandidates(
  refs: ActionRef[],
  cap: number,
): Array<{ ref: ActionRef; context: 'toolbar' }> {
  const out: Array<{ ref: ActionRef; context: 'toolbar' }> = [];
  for (const ref of refs) {
    if (ref.disabled) continue;
    if (ref.intent === 'navigate' || NAV_LIKE_RE.test(ref.label)) continue;
    if (DESTRUCTIVE_RE.test(ref.label)) continue;
    if (!SAFE_PREFIX_RE.test(ref.label) && !looksLikeKebab(ref)) continue;
    out.push({ ref, context: 'toolbar' });
    if (out.length >= cap) break;
  }
  return out;
}

/** Pick row-action candidates from each table's first-row sample. We ONLY
 * probe explicit kebab/menu-opener triggers (per-row "..." or "More" buttons)
 * — not arbitrary inline icon-buttons. An icon-only "Resend invite" button
 * has empty/short label text, would slip through a label-only blocklist,
 * and is destructive. Kebabs are categorically different: they open a menu
 * (read-only) instead of firing an action, so they're safe to probe. */
function pickRowActionCandidates(
  model: PageModel,
  cap: number,
): Array<{ ref: ActionRef; context: 'row' }> {
  const out: Array<{ ref: ActionRef; context: 'row' }> = [];
  for (const table of model.tables) {
    if (out.length >= cap) break;
    const kebab = table.rowActions.find((a) => looksLikeKebab(a) && !a.disabled);
    if (!kebab) continue;
    out.push({ ref: kebab, context: 'row' });
  }
  return out;
}

/** Read the DOM for "what changed since the click". Single round trip. */
async function classifyChange(
  page: Page,
  baselineUrl: string,
  preClickDialogCount: number,
): Promise<AffordanceOutcome> {
  const result = await page.evaluate(
    (args) => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM types not in tsconfig.lib
      const g = globalThis as any;
      const { baselineUrl, preClickDialogCount } = args as {
        baselineUrl: string;
        preClickDialogCount: number;
      };
      const currentUrl: string = g.location.href;
      if (currentUrl !== baselineUrl) {
        return { kind: 'navigation', toRoute: currentUrl };
      }

      // Look for a newly-opened modal / wizard. Only count VISIBLE ones —
      // apps commonly keep dialogs mounted with display:none and toggle
      // visibility, so a node-count diff would miss the open event.
      const allDialogs = g.document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], dialog[open]',
      );
      const dialogs = [];
      for (const el of allDialogs) {
        const rect = el.getBoundingClientRect?.();
        const cs = g.getComputedStyle ? g.getComputedStyle(el) : null;
        const isVisible =
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          (!cs || (cs.display !== 'none' && cs.visibility !== 'hidden'));
        if (isVisible) dialogs.push(el);
      }
      if (dialogs.length > preClickDialogCount) {
        const dlg = dialogs[dialogs.length - 1];
        // Resolve dialog name in priority: aria-label, aria-labelledby
        // target's text, then any heading inside the dialog.
        let name: string = dlg.getAttribute('aria-label') || '';
        if (!name) {
          const labelledById = dlg.getAttribute('aria-labelledby');
          if (labelledById) {
            // aria-labelledby can be a space-separated list of ids.
            const parts: string[] = [];
            for (const id of labelledById.split(/\s+/)) {
              if (!id) continue;
              const el = g.document.getElementById(id);
              const text = el?.textContent?.trim();
              if (text) parts.push(text);
            }
            name = parts.join(' ');
          }
        }
        if (!name) {
          name =
            dlg.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim() || 'Modal';
        }
        const stepIndicators = dlg.querySelectorAll(
          '[role="progressbar"], [role="tablist"] [role="tab"], .step, [data-step], [aria-current="step"]',
        );
        const looksLikeWizard = stepIndicators.length >= 2;
        if (looksLikeWizard) {
          const labels: string[] = Array.from(stepIndicators)
            // biome-ignore lint/suspicious/noExplicitAny: DOM elements
            .map((el: any) => (el.textContent || '').trim())
            .filter((s: string) => s.length > 0)
            .slice(0, 8);
          return {
            kind: 'wizard',
            wizardName: name,
            stepCount: labels.length || stepIndicators.length,
          };
        }
        const hasForm =
          dlg.querySelector('form, input, textarea, select') !== null;
        return { kind: 'modal', modalName: name, hasForm };
      }

      // Look for a newly-opened menu/listbox/popover.
      const menus = g.document.querySelectorAll(
        '[role="menu"], [role="listbox"], [data-state="open"][role], [aria-expanded="true"] + *',
      );
      for (const m of menus) {
        // biome-ignore lint/suspicious/noExplicitAny: DOM elements
        const rect = (m as any).getBoundingClientRect?.();
        if (!rect || rect.width === 0 || rect.height === 0) continue;
        const items = Array.from(
          m.querySelectorAll('[role="menuitem"], [role="option"], li, button, a'),
        )
          // biome-ignore lint/suspicious/noExplicitAny: DOM elements
          .map((el: any) => (el.textContent || '').trim())
          .filter((s: string) => s.length > 0 && s.length < 80)
          .slice(0, 12);
        if (items.length > 0) return { kind: 'menu', items };
      }

      // Look for an inline form/panel that wasn't there before. Cheap
      // heuristic: a `<form>` with a visible heading we can read.
      const newPanels = g.document.querySelectorAll(
        '[data-state="open"]:not([role]), [aria-expanded="true"]',
      );
      for (const p of newPanels) {
        // biome-ignore lint/suspicious/noExplicitAny: DOM elements
        const f = (p as any).querySelector?.('form');
        if (!f) continue;
        const name =
          f.getAttribute('aria-label') ||
          f.querySelector('h1,h2,h3,legend')?.textContent?.trim() ||
          'Inline form';
        return { kind: 'inline-form', formName: name };
      }

      // Toast / live region.
      const toasts = g.document.querySelectorAll(
        '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], .toast, .Toastify__toast',
      );
      for (const t of toasts) {
        const text = (t.textContent || '').trim();
        if (text.length > 0 && text.length < 200) return { kind: 'toast', text };
      }

      return { kind: 'inert' };
    },
    { baselineUrl, preClickDialogCount },
  );
  return result as AffordanceOutcome;
}

/** Best-effort dismiss: Escape, then click any visible Close/X/Cancel,
 * then click an empty point on body (click-outside dismiss for popovers/
 * menus that don't respond to Escape). Cap each attempt aggressively — a
 * stuck dismiss would derail subsequent probes. */
async function dismissOpened(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Escape', { delay: 30 });
  } catch {
    // ignore
  }
  // Brief pause for any dismiss animation.
  await page.waitForTimeout(80).catch(() => undefined);

  // Partial-match labels — apps use "Close window", "Close dialog", etc.
  const closeSelectors = [
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    'button[title*="close" i]',
    '[role="dialog"] button:has-text("Close")',
    '[role="dialog"] button:has-text("Cancel")',
  ];
  for (const sel of closeSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 50 })) {
        await loc.click({ timeout: 200 });
        await page.waitForTimeout(60).catch(() => undefined);
        return;
      }
    } catch {
      // try next
    }
  }

  // Last-resort click-outside for popovers/menus that don't respond to
  // Escape. Click a top-corner pixel; if a modal still has an overlay
  // there, the click is harmless (overlays absorb it).
  try {
    await page.mouse.click(2, 2, { delay: 0 });
    await page.waitForTimeout(50).catch(() => undefined);
  } catch {
    // ignore
  }
}

/** If the click navigated us elsewhere, navigate back. Best-effort.
 * Deliberately uses domcontentloaded only — Next.js apps stream analytics
 * beacons that keep `networkidle` from settling, which would burn the
 * probe's per-click budget on a state-restoration step. */
async function restoreUrlIfNeeded(
  page: Page,
  baselineUrl: string,
  allowedHosts: string[],
): Promise<void> {
  try {
    if (page.url() !== baselineUrl) {
      // Skip restore if the baseline URL is off-allowlist — this shouldn't
      // happen in normal operation but is a safety net if the allowlist changes
      // mid-probe or the page was already on an unexpected host.
      if (allowedHosts.length > 0 && !isHostAllowed(baselineUrl, allowedHosts)) {
        return;
      }
      await page.goto(baselineUrl, { timeout: 5_000, waitUntil: 'domcontentloaded' });
    }
  } catch {
    // best-effort
  }
}

/** Count VISIBLE `[role="dialog"]` etc. before the click so we can detect
 * *newly visible* ones reliably (apps commonly keep dialogs in the DOM with
 * display:none and toggle visibility — the post-click classifier needs to
 * see "one more visible dialog" rather than "one more dialog node"). */
async function countOpenDialogs(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM types not in tsconfig.lib
      const g = globalThis as any;
      const all = g.document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], dialog[open]',
      );
      let visible = 0;
      for (const el of all) {
        const rect = el.getBoundingClientRect?.();
        const cs = g.getComputedStyle ? g.getComputedStyle(el) : null;
        const isVisible =
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          (!cs || (cs.display !== 'none' && cs.visibility !== 'hidden'));
        if (isVisible) visible += 1;
      }
      return visible;
    });
  } catch {
    return 0;
  }
}

/**
 * Probe non-destructive affordances on the currently-loaded page. The
 * caller MUST already have a fresh PageModel for this page (we read its
 * locators rather than re-discovering them).
 *
 * Always returns an array — never throws. Logs but swallows per-candidate
 * errors so one flaky button doesn't sink the whole probe.
 */
export async function probeAffordances(
  page: Page,
  model: PageModel,
  options?: Partial<AffordanceProbeOptions>,
): Promise<DiscoveredAffordance[]> {
  const opts: AffordanceProbeOptions = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = Date.now();
  const baselineUrl = page.url();
  const out: DiscoveredAffordance[] = [];

  // Aggregate page-level button candidates: toolbars are the primary source
  // (they hold "Add Client", "Settings", "..."), but page-level
  // bareInteractives often contain header buttons too. Dedup on locator.
  const seenLocators = new Set<string>();
  const pageRefs: ActionRef[] = [];
  for (const ref of [...model.toolbars, ...model.bareInteractives]) {
    if (ref.type !== 'button' && ref.type !== 'menuitem') continue;
    if (seenLocators.has(ref.locator)) continue;
    seenLocators.add(ref.locator);
    pageRefs.push(ref);
  }

  const toolbarCandidates = pickToolbarCandidates(pageRefs, opts.maxToolbarProbes);
  const rowCandidates = pickRowActionCandidates(model, opts.maxRowActionProbes);
  const candidates = [...toolbarCandidates, ...rowCandidates];

  // Reserve headroom for one full click+settle+dismiss cycle so we don't
  // start an iteration we can't finish within the budget.
  const perIterReserveMs = opts.perClickTimeoutMs + opts.postClickSettleMs + 500;

  for (const { ref, context } of candidates) {
    if (Date.now() - startedAt > opts.totalBudgetMs - perIterReserveMs) {
      opts.logger?.debug('affordance.probe.budgetExceeded', {
        elapsed: Date.now() - startedAt,
        budget: opts.totalBudgetMs,
        remaining: candidates.length - out.length,
      });
      break;
    }

    let outcome: AffordanceOutcome;
    const dialogCountBefore = await countOpenDialogs(page);

    try {
      const loc = page.locator(ref.locator).first();
      // Skip if not visible/attached — locator may be stale.
      const visible = await loc.isVisible({ timeout: 200 }).catch(() => false);
      if (!visible) {
        out.push({
          trigger: ref,
          context,
          outcome: { kind: 'error', detail: 'not visible' },
        });
        continue;
      }
      await loc.click({ timeout: opts.perClickTimeoutMs, trial: false });
      await page.waitForTimeout(opts.postClickSettleMs).catch(() => undefined);
      outcome = await classifyChange(page, baselineUrl, dialogCountBefore);
    } catch (err) {
      outcome = {
        kind: 'error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    out.push({ trigger: ref, context, outcome });

    // Best-effort cleanup so the next probe starts from baseline state.
    const probeAllowedHosts = opts.allowedHosts ?? [];
    if (outcome.kind === 'navigation') {
      await restoreUrlIfNeeded(page, baselineUrl, probeAllowedHosts);
    } else if (outcome.kind !== 'inert' && outcome.kind !== 'error') {
      await dismissOpened(page);
      // If dismiss didn't fully take and URL drifted, restore.
      if (page.url() !== baselineUrl) {
        await restoreUrlIfNeeded(page, baselineUrl, probeAllowedHosts);
      }
    }
  }

  opts.logger?.debug('affordance.probe.complete', {
    candidates: candidates.length,
    discovered: out.length,
    elapsedMs: Date.now() - startedAt,
  });
  return out;
}
