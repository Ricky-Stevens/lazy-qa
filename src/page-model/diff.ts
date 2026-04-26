/**
 * Structural diff between two PageModels. Used by the agent loop's
 * "did the page actually change?" gate and by playbooks that need to detect
 * new affordances appearing after an action (modal openings, etc.).
 */

import type { ActionRef, PageModel } from './types.ts';

export interface PageModelDiff {
  added: ActionRef[];
  removed: ActionRef[];
  routeChanged: boolean;
  textChanged: boolean;
}

/** Stable key for an ActionRef — locator + label is stable enough to detect
 * "same element, just moved" while still flagging genuine additions. */
function actionKey(a: ActionRef): string {
  return `${a.locator}::${a.label}`;
}

/** Collect every ActionRef across the various groupings of a PageModel. */
function collectActionRefs(model: PageModel): ActionRef[] {
  const out: ActionRef[] = [];
  out.push(...model.toolbars);
  out.push(...model.navLinks);
  out.push(...model.bareInteractives);
  for (const f of model.forms) {
    if (f.submit) out.push(f.submit);
    if (f.cancel) out.push(f.cancel);
    out.push(...f.extraActions);
  }
  for (const t of model.tables) {
    out.push(...t.rowActions);
    out.push(...t.bulkActions);
    out.push(...t.filters);
  }
  for (const m of model.modals) {
    if (m.closers.x) out.push(m.closers.x);
    if (m.closers.cancel) out.push(m.closers.cancel);
    if (m.primaryAction) out.push(m.primaryAction);
    if (m.form) {
      if (m.form.submit) out.push(m.form.submit);
      if (m.form.cancel) out.push(m.form.cancel);
      out.push(...m.form.extraActions);
    }
  }
  for (const w of model.wizards) {
    if (w.next) out.push(w.next);
    if (w.back) out.push(w.back);
    if (w.skip) out.push(w.skip);
    if (w.finish) out.push(w.finish);
    if (w.cancel) out.push(w.cancel);
  }
  return out;
}

/**
 * Pure function: compute the diff between two PageModels.
 *
 * - `routeChanged` — origin+pathname differs (query/fragment ignored, see
 *   PageModel.route definition).
 * - `textChanged` — visible body text hash differs.
 * - `added` — ActionRefs present in `b` but not `a`.
 * - `removed` — ActionRefs present in `a` but not `b`.
 */
export function diffPageModels(a: PageModel, b: PageModel): PageModelDiff {
  const aMap = new Map<string, ActionRef>();
  for (const ref of collectActionRefs(a)) aMap.set(actionKey(ref), ref);
  const bMap = new Map<string, ActionRef>();
  for (const ref of collectActionRefs(b)) bMap.set(actionKey(ref), ref);

  const added: ActionRef[] = [];
  for (const [k, ref] of bMap) {
    if (!aMap.has(k)) added.push(ref);
  }
  const removed: ActionRef[] = [];
  for (const [k, ref] of aMap) {
    if (!bMap.has(k)) removed.push(ref);
  }

  return {
    added,
    removed,
    routeChanged: a.route !== b.route,
    textChanged: a.textHash !== b.textHash,
  };
}
