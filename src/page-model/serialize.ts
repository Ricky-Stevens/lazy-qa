/**
 * Serializer: PageModel → compact textual representation for the agent.
 *
 * Target: ~1-2 KB for a typical page; hard cap 4096 chars on rich pages.
 * The format is dense, line-oriented, and stable so the agent can rely on
 * counts (e.g. "Forms: 3") to navigate.
 */

import type {
  ActionRef,
  BareFieldRef,
  DiscoveredAffordance,
  FormSpec,
  ModalSpec,
  PageModel,
  TableSpec,
  WizardSpec,
} from './types.ts';

const HARD_CAP = 4096;

/** Build a one-line summary of a single ActionRef. */
function fmtAction(a: ActionRef): string {
  const flags: string[] = [];
  if (a.disabled) flags.push('disabled');
  if (a.intent !== 'unknown') flags.push(a.intent);
  if (a.blockedByModal) flags.push('blocked-by-modal');
  const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  return `  - ${a.type}: "${a.label}" → ${a.locator}${flagStr}`;
}

function fmtBareField(f: BareFieldRef): string {
  const flags: string[] = [];
  if (f.blockedByModal) flags.push('blocked-by-modal');
  const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  return `  - ${f.role}: "${f.label}" → ${f.locator}${flagStr}`;
}

function fmtForm(f: FormSpec, idx: number): string {
  const lines: string[] = [];
  const modalTag = f.inModal ? ' (in modal)' : '';
  lines.push(`Form #${idx + 1}: ${f.name} [${f.id}]${modalTag} @ ${f.formLocator}`);
  lines.push(`  fields (${f.fields.length}):`);
  for (const field of f.fields) {
    const reqTag = field.required ? '*' : '';
    const constraints: string[] = [];
    // Bug 2 fix: emit all numeric constraints so the agent can act on ranges.
    if (field.constraints.min !== undefined) constraints.push(`min=${field.constraints.min}`);
    if (field.constraints.max !== undefined) constraints.push(`max=${field.constraints.max}`);
    if (field.constraints.minLength !== undefined)
      constraints.push(`minLength=${field.constraints.minLength}`);
    if (field.constraints.maxLength !== undefined)
      constraints.push(`maxLength=${field.constraints.maxLength}`);
    if (field.constraints.pattern) constraints.push(`pattern`);
    if (field.constraints.options) constraints.push(`options=${field.constraints.options.length}`);
    const cStr = constraints.length > 0 ? ` (${constraints.join(',')})` : '';
    lines.push(`    - ${field.label}${reqTag}: ${field.type}${cStr}`);
  }
  if (f.submit) lines.push(`  submit: "${f.submit.label}" → ${f.submit.locator}`);
  if (f.cancel) lines.push(`  cancel: "${f.cancel.label}" → ${f.cancel.locator}`);
  if (f.extraActions.length > 0) {
    lines.push(`  extras (${f.extraActions.length}):`);
    for (const a of f.extraActions) lines.push(fmtAction(a));
  }
  return lines.join('\n');
}

function fmtTable(t: TableSpec, idx: number): string {
  const lines: string[] = [];
  lines.push(
    `Table #${idx + 1}: ${t.name} [${t.id}] @ ${t.tableLocator} — ${t.rowCount} rows, ${t.columns.length} cols`,
  );
  if (t.columns.length > 0) {
    const colSummary = t.columns.map((c) => `${c.label}${c.sortable ? '↕' : ''}`).join(' | ');
    lines.push(`  cols: ${colSummary}`);
  }
  if (t.rowActions.length > 0) {
    lines.push(`  rowActions (${t.rowActions.length}):`);
    for (const a of t.rowActions.slice(0, 6)) lines.push(fmtAction(a));
  }
  if (t.bulkActions.length > 0) {
    lines.push(`  bulkActions (${t.bulkActions.length}):`);
    for (const a of t.bulkActions.slice(0, 4)) lines.push(fmtAction(a));
  }
  if (t.filters.length > 0) {
    lines.push(`  filters (${t.filters.length}):`);
    for (const a of t.filters.slice(0, 4)) lines.push(fmtAction(a));
  }
  if (t.pagination) lines.push(`  pagination @ ${t.pagination.locator}`);
  if (t.sampleRows && t.sampleRows.length > 0) {
    lines.push(`  rows (sample, top ${t.sampleRows.length}):`);
    for (const row of t.sampleRows) {
      // Show up to 6 cells per row; agents inspecting wider tables can click in.
      const compact = row
        .slice(0, 6)
        .map((c) => (c.length === 0 ? '∅' : c))
        .join(' | ');
      lines.push(`    [${compact}]`);
    }
  }
  return lines.join('\n');
}

function fmtModal(m: ModalSpec, idx: number): string {
  const lines: string[] = [];
  const tag = m.isEditScreenLike ? ' (edit-screen-like)' : '';
  lines.push(`Modal #${idx + 1}: ${m.name} [${m.id}]${tag} @ ${m.modalLocator}`);
  if (m.form) lines.push(`  form: ${m.form.name} (${m.form.fields.length} fields) [${m.form.id}]`);
  if (m.primaryAction)
    lines.push(`  primary: "${m.primaryAction.label}" → ${m.primaryAction.locator}`);
  if (m.closers.x) lines.push(`  closeX: ${m.closers.x.locator}`);
  if (m.closers.cancel) lines.push(`  cancel: ${m.closers.cancel.locator}`);
  return lines.join('\n');
}

function fmtWizard(w: WizardSpec, idx: number): string {
  const lines: string[] = [];
  const current = w.steps.find((s) => s.isCurrent);
  const step = current ? `${current.index + 1}/${w.steps.length}` : `?/${w.steps.length}`;
  lines.push(`Wizard #${idx + 1}: ${w.name} [${w.id}] @ ${w.wizardLocator} (step ${step})`);
  const stepLabels = w.steps
    .map((s) => `${s.index + 1}.${s.label}${s.isCurrent ? '*' : ''}`)
    .join(' | ');
  lines.push(`  steps: ${stepLabels}`);
  const ctrls: string[] = [];
  if (w.next) ctrls.push(`next:${w.next.locator}`);
  if (w.back) ctrls.push(`back:${w.back.locator}`);
  if (w.skip) ctrls.push(`skip:${w.skip.locator}`);
  if (w.finish) ctrls.push(`finish:${w.finish.locator}`);
  if (w.cancel) ctrls.push(`cancel:${w.cancel.locator}`);
  if (ctrls.length > 0) lines.push(`  controls: ${ctrls.join(' ')}`);
  return lines.join('\n');
}

interface Section {
  /** Order matters: header is always kept; body is what we trim under cap. */
  header: string;
  body: string[];
}

function joinSections(sections: Section[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    if (s.header) parts.push(s.header);
    if (s.body.length > 0) parts.push(s.body.join('\n'));
  }
  return parts.filter((p) => p.length > 0).join('\n\n');
}

/**
 * Produce a compact text representation of a PageModel suitable for an LLM
 * tool result. Output is hard-capped at HARD_CAP characters; if exceeded,
 * sections are trimmed proportionally with a footer indicating truncation.
 */
export function serializeForAgent(model: PageModel): string {
  const headerLines: string[] = [
    `URL: ${model.url}`,
    `Route: ${model.route}`,
    `Title: ${model.title || '(no title)'}`,
  ];
  if (model.primaryHeading) headerLines.push(`H1: ${model.primaryHeading}`);
  headerLines.push(`Interactive: ${model.interactiveCount}, looksBroken=${model.looksBroken}`);

  // Notices — testbed-style "you just hit a known bug" toasts. Surfaced FIRST,
  // before everything else, because they're the strongest "file a finding now"
  // signal we have. Run #7 evidence: completionist auto-solved 7 distinct
  // OWASP Juice Shop challenges via normal browsing and filed zero findings.
  if (model.notices && model.notices.length > 0) {
    headerLines.push(
      `★ NOTICE — the page reports an in-app event you should treat as a confirmed bug:`,
    );
    for (const n of model.notices.slice(0, 5)) headerLines.push(`  • ${n}`);
    headerLines.push(
      '  → file_finding NOW with severity=major describing what you just did and the notice text. The post-run reviewer will dedupe duplicates; do NOT skip.',
    );
  }

  // Modal-blocking warning. Without this, agents on SPAs (Juice Shop's
  // cookie+welcome stack) repeatedly see "Bare interactives (0)" because
  // the elements are tagged blockedByModal — surfacing the modals' dismiss
  // affordances first lets the agent unblock the page in one turn.
  if (model.modals.length > 0) {
    const dismissers: string[] = [];
    for (const m of model.modals) {
      if (m.closers.cancel)
        dismissers.push(`"${m.closers.cancel.label}" → ${m.closers.cancel.locator}`);
      else if (m.closers.x) dismissers.push(`closeX → ${m.closers.x.locator}`);
    }
    headerLines.push(
      `⚠ ${model.modals.length} modal(s) currently open — interactives below them are tagged [blocked-by-modal]. Dismiss first:`,
    );
    for (const d of dismissers.slice(0, 4)) headerLines.push(`  → ${d}`);
  }

  const formsSection: Section = {
    header: `Forms (${model.forms.length}):`,
    body: model.forms.map((f, i) => fmtForm(f, i)),
  };
  const tablesSection: Section = {
    header: `Tables (${model.tables.length}):`,
    body: model.tables.map((t, i) => fmtTable(t, i)),
  };
  const modalsSection: Section = {
    header: `Modals (${model.modals.length}):`,
    body: model.modals.map((m, i) => fmtModal(m, i)),
  };
  const wizardsSection: Section = {
    header: `Wizards (${model.wizards.length}):`,
    body: model.wizards.map((w, i) => fmtWizard(w, i)),
  };
  const toolbarsSection: Section = {
    header: `Toolbars (${model.toolbars.length}):`,
    body: model.toolbars.slice(0, 20).map(fmtAction),
  };
  const navSection: Section = {
    header: `Nav (${model.navLinks.length}):`,
    body: model.navLinks.slice(0, 30).map(fmtAction),
  };
  const bareSection: Section = {
    header: `Bare interactives (${model.bareInteractives.length}, top 30):`,
    body: model.bareInteractives.slice(0, 30).map(fmtAction),
  };
  const bareFieldsSection: Section = {
    header: `Bare fields (${model.bareFields.length}, top 20):`,
    body: model.bareFields.slice(0, 20).map(fmtBareField),
  };

  const discoveredLines: string[] = [];
  if (model.discovered && model.discovered.length > 0) {
    for (const d of model.discovered.slice(0, 10)) {
      const outcome = d.outcome.kind;
      if (outcome === 'inert') continue;
      let detail = '';
      if (d.outcome.kind === 'modal')
        detail = ` → modal "${d.outcome.modalName}"${d.outcome.hasForm ? ' (has form)' : ''}`;
      else if (d.outcome.kind === 'menu') detail = ` → menu (${d.outcome.items.length} items)`;
      else if (d.outcome.kind === 'inline-form') detail = ` → inline form "${d.outcome.formName}"`;
      else if (d.outcome.kind === 'navigation') detail = ` → navigates to ${d.outcome.toRoute}`;
      else if (d.outcome.kind === 'error') detail = ` → error: ${d.outcome.detail}`;
      discoveredLines.push(`  - "${d.trigger.label}" [${d.context}]${detail}`);
    }
  }
  const discoveredSection: Section = {
    header: discoveredLines.length > 0 ? `Discovered affordances (${discoveredLines.length}):` : '',
    body: discoveredLines,
  };

  const signalLines: string[] = [];
  if (model.network.length > 0 || model.console.length > 0) {
    signalLines.push('⚠️ since last action:');
    if (model.network.length > 0) {
      const n = model.network.length;
      const recent = model.network.slice(-5);
      const summary = recent.map((r) => `${r.status} ${r.method} ${r.url}`).join('; ');
      signalLines.push(`  network: ${n} anomaly(ies) — ${summary}`);
    }
    if (model.console.length > 0) {
      const errs = model.console.filter((c) => c.level === 'error' || c.level === 'pageerror');
      const recent = (errs.length > 0 ? errs : model.console).slice(-3);
      signalLines.push(
        `  console: ${model.console.length} entries — ${recent
          .map((c) => `[${c.level}] ${c.text.slice(0, 80)}`)
          .join('; ')}`,
      );
    }
  }
  const signalsSection: Section = {
    header: signalLines[0] ?? '',
    body: signalLines.slice(1),
  };

  // First pass: full output. If under cap, return.
  const sections: Section[] = [
    { header: headerLines.join('\n'), body: [] },
    formsSection,
    tablesSection,
    modalsSection,
    wizardsSection,
    toolbarsSection,
    navSection,
    bareSection,
    bareFieldsSection,
    discoveredSection,
    signalsSection,
  ];
  let output = joinSections(sections);
  if (output.length <= HARD_CAP) return output;

  // Over cap: trim body sections proportionally. Keep headers intact;
  // collectively the bodies must fit in the remaining budget.
  const headerOnly = joinSections(sections.map((s) => ({ header: s.header, body: [] })));
  const truncationFooter = '\n\n... (truncated to fit context budget)';
  const budget = HARD_CAP - headerOnly.length - truncationFooter.length - 200; // 200 char safety margin

  const trimmable = [
    formsSection,
    tablesSection,
    modalsSection,
    wizardsSection,
    toolbarsSection,
    navSection,
    bareSection,
    bareFieldsSection,
    discoveredSection,
  ];
  const totalBodyLen = trimmable.reduce((acc, s) => acc + s.body.join('\n').length, 0);
  if (totalBodyLen === 0) {
    return `${headerOnly}${truncationFooter}`;
  }

  for (const s of trimmable) {
    const len = s.body.join('\n').length;
    if (len === 0) continue;
    const share = Math.max(60, Math.floor((budget * len) / totalBodyLen));
    let acc = '';
    const kept: string[] = [];
    for (const item of s.body) {
      if (acc.length + item.length + 1 > share) break;
      kept.push(item);
      acc += `${item}\n`;
    }
    if (kept.length < s.body.length) {
      kept.push(`  ... (${s.body.length - kept.length} more)`);
    }
    s.body = kept;
  }

  output = joinSections(sections);
  if (output.length > HARD_CAP) {
    output = `${output.slice(0, HARD_CAP - truncationFooter.length)}${truncationFooter}`;
  }
  return output;
}
