/**
 * Parser: Playwright Page → PageModel.
 *
 * Single round-trip: every DOM observation runs inside a single
 * `page.evaluate` call. Outside the page we only assemble the result and
 * compute the text hash.
 */

import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type {
  ActionRef,
  ConsoleEntry,
  ElementType,
  FormFieldSpec,
  FormSpec,
  ModalSpec,
  NetworkAnomaly,
  PageModel,
  TableColumn,
  TableSpec,
  WizardSpec,
} from './types.ts';

// `page.evaluate` runs in the browser context where DOM globals exist; our
// tsconfig deliberately excludes the DOM lib (we don't run there). Use a
// single any-escape inside the evaluated function only.
// biome-ignore lint/suspicious/noExplicitAny: DOM types not in tsconfig.lib
type BrowserAny = any;

/** Raw extraction shape returned by the in-page script. We deliberately keep
 * everything as plain JSON (numbers / strings / arrays) because evaluate()
 * serialises the return value over the wire. */
interface RawExtraction {
  url: string;
  title: string;
  primaryHeading?: string;
  bodyText: string;
  forms: RawForm[];
  tables: RawTable[];
  modals: RawModal[];
  wizards: RawWizard[];
  toolbars: RawAction[];
  navLinks: RawAction[];
  bareInteractives: RawAction[];
  interactiveCount: number;
}

interface RawAction {
  locator: string;
  label: string;
  type: ElementType;
  disabled: boolean;
  href?: string;
}

interface RawField {
  locator: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: string[];
}

interface RawForm {
  formLocator: string;
  name: string;
  fields: RawField[];
  actionRefs: RawAction[];
  inModal: boolean;
}

interface RawColumn {
  label: string;
  headerLocator: string;
  sortable: boolean;
}

interface RawTable {
  tableLocator: string;
  name: string;
  columns: RawColumn[];
  rowCount: number;
  rowActions: RawAction[];
  bulkActions: RawAction[];
  filters: RawAction[];
  pagination?: { locator: string; currentPage?: number; totalPages?: number };
}

interface RawModal {
  modalLocator: string;
  name: string;
  form?: RawForm;
  closers: {
    x?: RawAction;
    cancel?: RawAction;
    escapeWorks: boolean;
    clickOutsideCloses: boolean;
  };
  primaryAction?: RawAction;
  isEditScreenLike: boolean;
}

interface RawWizard {
  wizardLocator: string;
  name: string;
  steps: Array<{ label: string; index: number; isCurrent: boolean }>;
  next?: RawAction;
  back?: RawAction;
  skip?: RawAction;
  finish?: RawAction;
  cancel?: RawAction;
}

const ACTION_KEYWORDS =
  /^(save|submit|create|add|delete|remove|apply|publish|run|send|invite|approve|reject|update|confirm|sign\s*in|log\s*in)/;
const NAVIGATE_KEYWORDS = /^(cancel|back|close|more|view|details|edit|open|next|previous)/;

/** Heuristic intent classifier for an ActionRef. Operates on the resolved
 * label + whether the underlying element is a link. */
export function classifyIntent(label: string, hasHref: boolean): ActionRef['intent'] {
  const trimmed = label.trim().toLowerCase();
  if (ACTION_KEYWORDS.test(trimmed)) return 'action';
  if (NAVIGATE_KEYWORDS.test(trimmed)) return 'navigate';
  if (hasHref) return 'navigate';
  return 'unknown';
}

function rawToActionRef(raw: RawAction): ActionRef {
  return {
    locator: raw.locator,
    label: raw.label,
    type: raw.type,
    disabled: raw.disabled,
    intent: classifyIntent(raw.label, !!(raw.href && raw.href.length > 0)),
  };
}

function rawToField(raw: RawField): FormFieldSpec {
  const constraints: FormFieldSpec['constraints'] = {};
  if (raw.min !== undefined) constraints.min = raw.min;
  if (raw.max !== undefined) constraints.max = raw.max;
  if (raw.minLength !== undefined) constraints.minLength = raw.minLength;
  if (raw.maxLength !== undefined) constraints.maxLength = raw.maxLength;
  if (raw.pattern !== undefined) constraints.pattern = raw.pattern;
  if (raw.options !== undefined) constraints.options = raw.options;
  const spec: FormFieldSpec = {
    locator: raw.locator,
    label: raw.label,
    type: raw.type,
    required: raw.required,
    constraints,
  };
  if (raw.placeholder !== undefined) spec.placeholder = raw.placeholder;
  return spec;
}

/** Stable form id: sha1(route + ordered field labels). Truncated to 12 chars. */
export function formIdFor(route: string, fieldLabels: string[]): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  for (const lbl of fieldLabels) {
    h.update(lbl);
    h.update('');
  }
  return `form_${h.digest('hex').slice(0, 12)}`;
}

function tableIdFor(route: string, name: string, columnLabels: string[]): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  h.update(name);
  for (const c of columnLabels) {
    h.update('');
    h.update(c);
  }
  return `table_${h.digest('hex').slice(0, 12)}`;
}

function modalIdFor(route: string, name: string, n: number): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  h.update(name);
  h.update('');
  h.update(String(n));
  return `modal_${h.digest('hex').slice(0, 12)}`;
}

function wizardIdFor(route: string, name: string, stepCount: number): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  h.update(name);
  h.update('');
  h.update(String(stepCount));
  return `wizard_${h.digest('hex').slice(0, 12)}`;
}

function rawToForm(raw: RawForm, route: string, defaultIdx: number): FormSpec {
  const fields = raw.fields.map(rawToField);
  const labels = fields.map((f) => f.label);
  const id = formIdFor(route, labels);
  const actionRefs = raw.actionRefs.map(rawToActionRef);

  let submit: ActionRef | undefined;
  let cancel: ActionRef | undefined;
  const extras: ActionRef[] = [];
  for (const a of actionRefs) {
    const lower = a.label.toLowerCase().trim();
    if (!submit && (a.intent === 'action' || /submit/.test(lower))) {
      submit = a;
      continue;
    }
    if (!cancel && /^(cancel|close)/.test(lower)) {
      cancel = a;
      continue;
    }
    extras.push(a);
  }

  const name = raw.name && raw.name.length > 0 ? raw.name : `Form #${defaultIdx + 1}`;
  const spec: FormSpec = {
    id,
    formLocator: raw.formLocator,
    name,
    fields,
    extraActions: extras,
    inModal: raw.inModal,
  };
  if (submit) spec.submit = submit;
  if (cancel) spec.cancel = cancel;
  return spec;
}

function rawToTable(raw: RawTable, route: string, idx: number): TableSpec {
  const columns: TableColumn[] = raw.columns.map((c) => ({
    label: c.label,
    headerLocator: c.headerLocator,
    sortable: c.sortable,
  }));
  const name = raw.name && raw.name.length > 0 ? raw.name : `Table #${idx + 1}`;
  const id = tableIdFor(
    route,
    name,
    columns.map((c) => c.label),
  );
  const spec: TableSpec = {
    id,
    tableLocator: raw.tableLocator,
    name,
    columns,
    rowCount: raw.rowCount,
    rowActions: raw.rowActions.map(rawToActionRef),
    bulkActions: raw.bulkActions.map(rawToActionRef),
    filters: raw.filters.map(rawToActionRef),
  };
  if (raw.pagination) {
    spec.pagination = { locator: raw.pagination.locator };
    if (raw.pagination.currentPage !== undefined)
      spec.pagination.currentPage = raw.pagination.currentPage;
    if (raw.pagination.totalPages !== undefined)
      spec.pagination.totalPages = raw.pagination.totalPages;
  }
  return spec;
}

function rawToModal(raw: RawModal, route: string, idx: number): ModalSpec {
  const name = raw.name && raw.name.length > 0 ? raw.name : `Modal #${idx + 1}`;
  const id = modalIdFor(route, name, idx);
  const closers: ModalSpec['closers'] = {
    escapeWorks: raw.closers.escapeWorks,
    clickOutsideCloses: raw.closers.clickOutsideCloses,
  };
  if (raw.closers.x) closers.x = rawToActionRef(raw.closers.x);
  if (raw.closers.cancel) closers.cancel = rawToActionRef(raw.closers.cancel);
  const spec: ModalSpec = {
    id,
    modalLocator: raw.modalLocator,
    name,
    closers,
    isEditScreenLike: raw.isEditScreenLike,
  };
  if (raw.form) spec.form = rawToForm(raw.form, route, idx);
  if (raw.primaryAction) spec.primaryAction = rawToActionRef(raw.primaryAction);
  return spec;
}

function rawToWizard(raw: RawWizard, route: string, idx: number): WizardSpec {
  const name = raw.name && raw.name.length > 0 ? raw.name : `Wizard #${idx + 1}`;
  const id = wizardIdFor(route, name, raw.steps.length);
  const spec: WizardSpec = {
    id,
    wizardLocator: raw.wizardLocator,
    name,
    steps: raw.steps.map((s) => ({ label: s.label, index: s.index, isCurrent: s.isCurrent })),
  };
  if (raw.next) spec.next = rawToActionRef(raw.next);
  if (raw.back) spec.back = rawToActionRef(raw.back);
  if (raw.skip) spec.skip = rawToActionRef(raw.skip);
  if (raw.finish) spec.finish = rawToActionRef(raw.finish);
  if (raw.cancel) spec.cancel = rawToActionRef(raw.cancel);
  return spec;
}

function computeTextHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function deriveRoute(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Extract a structured PageModel from a Playwright Page.
 *
 * `signals` are passed through; the parser does not own listeners — those live
 * on the browser server which feeds the buffers into each call.
 */
export async function parsePage(
  page: Page,
  signals?: { network?: NetworkAnomaly[]; console?: ConsoleEntry[] },
): Promise<PageModel> {
  const browserFn = (): string => {
    const w: BrowserAny = (globalThis as BrowserAny).window;
    const doc: BrowserAny = (globalThis as BrowserAny).document;

    const isVisible = (el: BrowserAny): boolean => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = w.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity || '1') < 0.05) return false;
      return true;
    };

    const cssEscape = (s: string): string => {
      if (typeof w.CSS !== 'undefined' && w.CSS.escape) return w.CSS.escape(s);
      return String(s).replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`);
    };

    const escAttr = (s: string): string => String(s).replace(/"/g, '\\"');

    /** Resolve a stable Playwright locator. Preference:
     *   data-testid > id > role+name > text= */
    const locatorFor = (
      el: BrowserAny,
      role: string,
      name: string,
    ): string => {
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${escAttr(testid)}"]`;
      if (el.id) return `#${cssEscape(el.id)}`;
      if (role && name) return `role=${role}[name="${escAttr(name.slice(0, 60))}"]`;
      if (name) return `text="${escAttr(name.slice(0, 60))}"`;
      return el.tagName ? String(el.tagName).toLowerCase() : 'unknown';
    };

    /** Resolve a stable container locator (for forms / tables / modals). */
    const containerLocator = (el: BrowserAny, fallback: string): string => {
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${escAttr(testid)}"]`;
      if (el.id) return `#${cssEscape(el.id)}`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `${fallback}[aria-label="${escAttr(aria)}"]`;
      return fallback;
    };

    const labelTextFor = (el: BrowserAny): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const ariaLabelledBy = el.getAttribute('aria-labelledby');
      if (ariaLabelledBy) {
        const ref = doc.getElementById(ariaLabelledBy);
        if (ref && ref.textContent) return ref.textContent.trim();
      }
      if (el.id) {
        try {
          const lbl = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
          if (lbl && lbl.textContent) return lbl.textContent.trim();
        } catch {
          /* malformed selector; ignore */
        }
      }
      // wrapped label: <label>name <input /></label>
      let walker: BrowserAny = el.parentElement;
      while (walker) {
        if (String(walker.tagName).toLowerCase() === 'label') {
          // strip nested input text
          const clone = walker.cloneNode(true);
          for (const inner of Array.from(
            clone.querySelectorAll('input, textarea, select'),
          ) as BrowserAny[]) {
            inner.remove();
          }
          return (clone.textContent || '').trim();
        }
        walker = walker.parentElement;
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const name = el.getAttribute('name');
      if (name) return name.trim();
      return '';
    };

    const interactiveLabel = (el: BrowserAny): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 80);
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
      const value = el.value;
      if (value) return String(value).slice(0, 80);
      const testid = el.getAttribute('data-testid');
      if (testid) return `testid:${testid}`;
      return '';
    };

    const elementTypeOf = (el: BrowserAny): string => {
      const tag = String(el.tagName).toLowerCase();
      const role = el.getAttribute('role');
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textarea';
      if (tag === 'select') return 'select';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'input';
      }
      if (role === 'button') return 'button';
      if (role === 'link') return 'link';
      if (role === 'tab') return 'tab';
      if (role === 'menuitem') return 'menuitem';
      if (role === 'option') return 'option';
      if (role === 'row') return 'row';
      if (role === 'cell' || role === 'gridcell') return 'cell';
      if (role === 'checkbox' || role === 'switch') return 'checkbox';
      if (role === 'radio') return 'radio';
      if (role === 'dialog') return 'dialog';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return 'other';
    };

    const ariaRoleFor = (el: BrowserAny): string => {
      const role = el.getAttribute('role');
      if (role) return role;
      const tag = String(el.tagName).toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button') return 'button';
        return 'textbox';
      }
      return tag;
    };

    const isDisabled = (el: BrowserAny): boolean => {
      if (el.hasAttribute && el.hasAttribute('disabled')) return true;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      return false;
    };

    const buildAction = (el: BrowserAny): RawAction => {
      const label = interactiveLabel(el);
      const role = ariaRoleFor(el);
      const locator = locatorFor(el, role, label);
      const tag = String(el.tagName).toLowerCase();
      const href = tag === 'a' ? el.getAttribute('href') || '' : '';
      const out: RawAction = {
        locator,
        label,
        type: elementTypeOf(el) as ElementType,
        disabled: isDisabled(el),
      };
      if (href) out.href = href;
      return out;
    };

    const isInsideAny = (el: BrowserAny, ancestors: BrowserAny[]): boolean => {
      for (const a of ancestors) {
        if (a.contains && a.contains(el)) return true;
      }
      return false;
    };

    const closestModalRoot = (el: BrowserAny): BrowserAny | null => {
      let walker: BrowserAny = el.parentElement;
      while (walker) {
        if (
          walker.getAttribute &&
          (walker.getAttribute('role') === 'dialog' ||
            walker.getAttribute('aria-modal') === 'true')
        )
          return walker;
        walker = walker.parentElement;
      }
      return null;
    };

    // ---- Forms ----
    const formEls: BrowserAny[] = Array.from(doc.querySelectorAll('form'));
    const forms: RawForm[] = [];
    for (const form of formEls) {
      if (!isVisible(form)) continue;
      const formLocator = containerLocator(form, 'form');
      const heading = form.querySelector('h1, h2, h3, [aria-label]');
      const headingText =
        (heading && heading !== form && heading.textContent
          ? heading.textContent.trim()
          : '') || form.getAttribute('aria-label') || '';
      const fields: RawField[] = [];
      const fieldEls: BrowserAny[] = Array.from(
        form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
        ),
      );
      const seenRadioGroups = new Set<string>();
      for (const fe of fieldEls) {
        if (!isVisible(fe)) continue;
        const tag = String(fe.tagName).toLowerCase();
        const inputType =
          tag === 'input' ? (fe.getAttribute('type') || 'text').toLowerCase() : tag;
        if (inputType === 'radio') {
          const name = fe.getAttribute('name') || '';
          if (name && seenRadioGroups.has(name)) continue;
          if (name) seenRadioGroups.add(name);
        }
        const label = labelTextFor(fe) || fe.getAttribute('name') || '';
        const role = ariaRoleFor(fe);
        const locator = locatorFor(fe, role, label);
        const required =
          fe.hasAttribute('required') || fe.getAttribute('aria-required') === 'true';
        const placeholder = fe.getAttribute('placeholder') || undefined;
        const minAttr = fe.getAttribute('min');
        const maxAttr = fe.getAttribute('max');
        const minLengthAttr = fe.getAttribute('minlength');
        const maxLengthAttr = fe.getAttribute('maxlength');
        const pattern = fe.getAttribute('pattern') || undefined;
        let options: string[] | undefined;
        if (tag === 'select') {
          options = Array.from(fe.querySelectorAll('option'))
            .map((o: BrowserAny) => (o.textContent || '').trim())
            .filter((s: string) => s.length > 0);
        } else if (inputType === 'radio') {
          const name = fe.getAttribute('name') || '';
          if (name) {
            options = Array.from(
              form.querySelectorAll(`input[type="radio"][name="${escAttr(name)}"]`),
            ).map((r: BrowserAny) => labelTextFor(r) || r.getAttribute('value') || '');
          }
        }
        const f: RawField = {
          locator,
          label,
          type: inputType,
          required,
        };
        if (placeholder) f.placeholder = placeholder;
        if (minAttr !== null && !Number.isNaN(Number(minAttr))) f.min = Number(minAttr);
        if (maxAttr !== null && !Number.isNaN(Number(maxAttr))) f.max = Number(maxAttr);
        if (minLengthAttr !== null && !Number.isNaN(Number(minLengthAttr)))
          f.minLength = Number(minLengthAttr);
        if (maxLengthAttr !== null && !Number.isNaN(Number(maxLengthAttr)))
          f.maxLength = Number(maxLengthAttr);
        if (pattern) f.pattern = pattern;
        if (options && options.length > 0) f.options = options;
        fields.push(f);
      }

      const actionEls: BrowserAny[] = Array.from(
        form.querySelectorAll(
          'button, input[type="submit"], input[type="button"], [role="button"]',
        ),
      );
      const actionRefs: RawAction[] = [];
      for (const ae of actionEls) {
        if (!isVisible(ae)) continue;
        actionRefs.push(buildAction(ae));
      }

      forms.push({
        formLocator,
        name: headingText,
        fields,
        actionRefs,
        inModal: !!closestModalRoot(form),
      });
    }

    // ---- Tables ----
    const tableEls: BrowserAny[] = Array.from(doc.querySelectorAll('table, [role="table"]'));
    const tables: RawTable[] = [];
    for (const t of tableEls) {
      if (!isVisible(t)) continue;
      const tableLocator = containerLocator(t, 'table');
      // Heading: caption, preceding h*, or aria-label.
      let name = t.getAttribute('aria-label') || '';
      const caption = t.querySelector('caption');
      if (!name && caption && caption.textContent) name = caption.textContent.trim();
      if (!name) {
        let walker: BrowserAny = t.previousElementSibling;
        while (walker) {
          if (/^h[1-4]$/i.test(walker.tagName)) {
            name = (walker.textContent || '').trim();
            break;
          }
          walker = walker.previousElementSibling;
        }
      }

      const headerEls: BrowserAny[] = Array.from(
        t.querySelectorAll('thead th, [role="columnheader"]'),
      );
      const columns: RawColumn[] = headerEls.map((h: BrowserAny) => {
        const lbl = (h.textContent || '').trim().replace(/\s+/g, ' ');
        const sortable =
          h.getAttribute('aria-sort') !== null ||
          h.hasAttribute('data-sortable') ||
          !!h.querySelector('button, [role="button"]');
        return {
          label: lbl,
          headerLocator: locatorFor(h, 'columnheader', lbl),
          sortable,
        };
      });

      const bodyRows: BrowserAny[] = Array.from(t.querySelectorAll('tbody tr, [role="row"]'));
      // Filter to non-header rows.
      const dataRows = bodyRows.filter(
        (r: BrowserAny) => !r.querySelector('th') || r.querySelector('td'),
      );
      const rowCount = dataRows.length;

      // Sample row actions from first data row.
      const rowActions: RawAction[] = [];
      if (dataRows[0]) {
        const acts: BrowserAny[] = Array.from(
          dataRows[0].querySelectorAll('button, a[href], [role="button"], [role="menuitem"]'),
        );
        for (const a of acts) {
          if (!isVisible(a)) continue;
          rowActions.push(buildAction(a));
        }
      }

      // Bulk-action heuristic: look for elements near a select-all checkbox in
      // the table or its preceding sibling toolbar that are buttons / links.
      const bulkActions: RawAction[] = [];
      const selectAll = t.querySelector(
        'thead input[type="checkbox"], [data-testid*="select-all"]',
      );
      if (selectAll) {
        const toolbarLike = t.parentElement;
        if (toolbarLike) {
          const candidates: BrowserAny[] = Array.from(
            toolbarLike.querySelectorAll('button, [role="button"]'),
          );
          for (const c of candidates) {
            if (!isVisible(c)) continue;
            if (t.contains(c)) continue;
            bulkActions.push(buildAction(c));
            if (bulkActions.length >= 6) break;
          }
        }
      }

      // Filters: search/filter inputs in the table's containing element.
      const filters: RawAction[] = [];
      const filterRoot = t.parentElement;
      if (filterRoot) {
        const fEls: BrowserAny[] = Array.from(
          filterRoot.querySelectorAll(
            'input[type="search"], input[placeholder*="earch" i], input[placeholder*="ilter" i], [role="searchbox"]',
          ),
        );
        for (const fe of fEls) {
          if (!isVisible(fe)) continue;
          if (t.contains(fe)) continue;
          filters.push(buildAction(fe));
        }
      }

      const paginationEl = (filterRoot &&
        filterRoot.querySelector('[role="navigation"][aria-label*="ag" i], nav[aria-label*="ag" i], [data-testid*="pagination"], [class*="pagination" i]')) as BrowserAny | null;
      const tableSpec: RawTable = {
        tableLocator,
        name,
        columns,
        rowCount,
        rowActions,
        bulkActions,
        filters,
      };
      if (paginationEl) {
        tableSpec.pagination = {
          locator: locatorFor(paginationEl, 'navigation', 'pagination'),
        };
      }
      tables.push(tableSpec);
    }

    // ---- Modals ----
    const modalEls: BrowserAny[] = Array.from(
      doc.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
    );
    const modals: RawModal[] = [];
    const modalRoots: BrowserAny[] = [];
    for (const m of modalEls) {
      if (!isVisible(m)) continue;
      modalRoots.push(m);
      const modalLocator = containerLocator(m, '[role="dialog"]');
      let name = m.getAttribute('aria-label') || '';
      if (!name) {
        const labelledBy = m.getAttribute('aria-labelledby');
        if (labelledBy) {
          const ref = doc.getElementById(labelledBy);
          if (ref && ref.textContent) name = ref.textContent.trim();
        }
      }
      if (!name) {
        const heading = m.querySelector('h1, h2, h3');
        if (heading && heading.textContent) name = heading.textContent.trim();
      }

      // Form inside?
      let formInside: RawForm | undefined;
      const innerForm = m.querySelector('form');
      if (innerForm && isVisible(innerForm)) {
        // Reconstruct a RawForm scoped to this inner form.
        const innerActions: BrowserAny[] = Array.from(
          innerForm.querySelectorAll(
            'button, input[type="submit"], input[type="button"], [role="button"]',
          ),
        );
        const fieldEls: BrowserAny[] = Array.from(
          innerForm.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
          ),
        );
        const innerFields: RawField[] = [];
        const seenRadioGroups = new Set<string>();
        for (const fe of fieldEls) {
          if (!isVisible(fe)) continue;
          const tag = String(fe.tagName).toLowerCase();
          const inputType =
            tag === 'input' ? (fe.getAttribute('type') || 'text').toLowerCase() : tag;
          if (inputType === 'radio') {
            const nm = fe.getAttribute('name') || '';
            if (nm && seenRadioGroups.has(nm)) continue;
            if (nm) seenRadioGroups.add(nm);
          }
          const label = labelTextFor(fe) || fe.getAttribute('name') || '';
          const role = ariaRoleFor(fe);
          const locator = locatorFor(fe, role, label);
          const required =
            fe.hasAttribute('required') || fe.getAttribute('aria-required') === 'true';
          const placeholder = fe.getAttribute('placeholder') || undefined;
          const f: RawField = { locator, label, type: inputType, required };
          if (placeholder) f.placeholder = placeholder;
          innerFields.push(f);
        }
        const innerRefs: RawAction[] = [];
        for (const a of innerActions) {
          if (!isVisible(a)) continue;
          innerRefs.push(buildAction(a));
        }
        formInside = {
          formLocator: containerLocator(innerForm, 'form'),
          name,
          fields: innerFields,
          actionRefs: innerRefs,
          inModal: true,
        };
      }

      // Closers: look for an X / close button in the modal header.
      let xCloser: RawAction | undefined;
      let cancelCloser: RawAction | undefined;
      let primaryAction: RawAction | undefined;
      const buttons: BrowserAny[] = Array.from(
        m.querySelectorAll('button, [role="button"]'),
      );
      for (const b of buttons) {
        if (!isVisible(b)) continue;
        const action = buildAction(b);
        const lower = action.label.toLowerCase().trim();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (
          !xCloser &&
          (aria === 'close' ||
            lower === '×' ||
            lower === 'x' ||
            (lower === '' && /close/.test(aria)))
        ) {
          xCloser = action;
          continue;
        }
        if (!cancelCloser && /^(cancel|close|dismiss)/.test(lower)) {
          cancelCloser = action;
          continue;
        }
        if (!primaryAction && classifyIntentInPage(action.label, false) === 'action') {
          primaryAction = action;
        }
      }

      // Heuristic: edit-screen-like = modal contains a form with > 5 fields, or
      // has an "Open in new" / "View full" link.
      let isEditScreenLike = false;
      if (formInside && formInside.fields.length > 5) isEditScreenLike = true;
      const expandLink = m.querySelector('a[href]');
      if (expandLink) {
        const t = (expandLink.textContent || '').toLowerCase();
        if (/full|expand|open in/.test(t)) isEditScreenLike = true;
      }

      const modalSpec: RawModal = {
        modalLocator,
        name,
        closers: {
          escapeWorks: true,
          clickOutsideCloses: !!doc.querySelector(
            '[class*="overlay" i], [class*="backdrop" i], [data-testid*="overlay"]',
          ),
        },
        isEditScreenLike,
      };
      if (xCloser) modalSpec.closers.x = xCloser;
      if (cancelCloser) modalSpec.closers.cancel = cancelCloser;
      if (primaryAction) modalSpec.primaryAction = primaryAction;
      if (formInside) modalSpec.form = formInside;
      modals.push(modalSpec);
    }

    // Mirror of the Node-side intent classifier so we can resolve primary
    // actions inside the in-page extraction (purely advisory; final intent
    // assigned outside).
    function classifyIntentInPage(
      label: string,
      hasHref: boolean,
    ): 'action' | 'navigate' | 'unknown' {
      const trimmed = label.trim().toLowerCase();
      if (
        /^(save|submit|create|add|delete|remove|apply|publish|run|send|invite|approve|reject|update|confirm|sign\s*in|log\s*in)/.test(
          trimmed,
        )
      )
        return 'action';
      if (/^(cancel|back|close|more|view|details|edit|open|next|previous)/.test(trimmed))
        return 'navigate';
      if (hasHref) return 'navigate';
      return 'unknown';
    }

    // ---- Wizards ----
    const wizardCandidates: BrowserAny[] = Array.from(
      doc.querySelectorAll(
        '[role="tablist"], [class*="stepper" i], [class*="wizard" i], [aria-label*="Step" i], [data-testid*="wizard"], [data-testid*="stepper"]',
      ),
    );
    const wizards: RawWizard[] = [];
    const wizardRoots: BrowserAny[] = [];
    for (const w of wizardCandidates) {
      if (!isVisible(w)) continue;
      // Dedupe: if a previously-accepted wizard already contains or is
      // contained by this candidate, skip. We prefer the outermost root so
      // the agent sees the wizard as a whole rather than just its tablist.
      let skipCandidate = false;
      for (const existing of wizardRoots) {
        if (existing.contains(w)) {
          skipCandidate = true;
          break;
        }
        if (w.contains(existing)) {
          // Replace inner with outer.
          const idx = wizardRoots.indexOf(existing);
          wizardRoots.splice(idx, 1);
          wizards.splice(idx, 1);
          break;
        }
      }
      if (skipCandidate) continue;
      // Collect step descendants.
      const stepEls: BrowserAny[] = Array.from(
        w.querySelectorAll(
          '[role="tab"], [aria-label*="Step" i], [data-testid*="step"], [class*="step" i]:not([class*="stepper" i])',
        ),
      );
      // Strict filter: must look like a discrete step.
      const stepsRaw = stepEls.filter((s: BrowserAny) => isVisible(s));
      if (stepsRaw.length < 2) continue;

      let name = w.getAttribute('aria-label') || '';
      if (!name) {
        const heading = w.querySelector('h1, h2, h3');
        if (heading && heading.textContent) name = heading.textContent.trim();
      }
      const steps = stepsRaw.slice(0, 12).map((s: BrowserAny, i: number) => ({
        label: (s.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || `Step ${i + 1}`,
        index: i,
        isCurrent:
          s.getAttribute('aria-current') === 'step' ||
          s.getAttribute('aria-selected') === 'true' ||
          /current|active/i.test(s.getAttribute('class') || ''),
      }));

      // Find Next/Back/Skip/Finish/Cancel buttons in nearby siblings (or inside).
      const scope = w.parentElement || w;
      const candidateBtns: BrowserAny[] = Array.from(
        scope.querySelectorAll('button, [role="button"]'),
      );
      let next: RawAction | undefined;
      let back: RawAction | undefined;
      let skip: RawAction | undefined;
      let finish: RawAction | undefined;
      let cancel: RawAction | undefined;
      for (const b of candidateBtns) {
        if (!isVisible(b)) continue;
        const action = buildAction(b);
        const lower = action.label.toLowerCase().trim();
        if (!next && /^next/.test(lower)) next = action;
        else if (!back && /^(back|previous)/.test(lower)) back = action;
        else if (!skip && /^skip/.test(lower)) skip = action;
        else if (!finish && /^(finish|done|complete|submit)/.test(lower)) finish = action;
        else if (!cancel && /^cancel/.test(lower)) cancel = action;
      }
      if (!next && !back && !finish) continue;

      wizardRoots.push(w);
      const wizardSpec: RawWizard = {
        wizardLocator: containerLocator(w, '[role="tablist"]'),
        name,
        steps,
      };
      if (next) wizardSpec.next = next;
      if (back) wizardSpec.back = back;
      if (skip) wizardSpec.skip = skip;
      if (finish) wizardSpec.finish = finish;
      if (cancel) wizardSpec.cancel = cancel;
      wizards.push(wizardSpec);
    }

    // ---- Toolbars ----
    const toolbarEls: BrowserAny[] = Array.from(
      doc.querySelectorAll('[role="toolbar"], [data-testid*="toolbar"], [class*="toolbar" i]'),
    );
    const toolbars: RawAction[] = [];
    const toolbarRoots: BrowserAny[] = [];
    for (const t of toolbarEls) {
      if (!isVisible(t)) continue;
      toolbarRoots.push(t);
      const items: BrowserAny[] = Array.from(
        t.querySelectorAll('button, a[href], [role="button"], [role="link"]'),
      );
      for (const i of items) {
        if (!isVisible(i)) continue;
        toolbars.push(buildAction(i));
        if (toolbars.length >= 30) break;
      }
      if (toolbars.length >= 30) break;
    }

    // ---- Nav links ----
    const navEls: BrowserAny[] = Array.from(doc.querySelectorAll('nav, [role="navigation"]'));
    const navLinks: RawAction[] = [];
    const navRoots: BrowserAny[] = [];
    const seenNav = new Set<BrowserAny>();
    for (const n of navEls) {
      if (!isVisible(n)) continue;
      navRoots.push(n);
      const items: BrowserAny[] = Array.from(
        n.querySelectorAll('a[href], [role="link"], button'),
      );
      for (const i of items) {
        if (!isVisible(i)) continue;
        if (seenNav.has(i)) continue;
        seenNav.add(i);
        navLinks.push(buildAction(i));
        if (navLinks.length >= 40) break;
      }
      if (navLinks.length >= 40) break;
    }

    // ---- Bare interactives ----
    // Anything clickable not inside a form / table / modal / wizard / toolbar / nav.
    const allInteractive: BrowserAny[] = Array.from(
      doc.querySelectorAll(
        'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]',
      ),
    );
    const excluded: BrowserAny[] = [
      ...formEls,
      ...tableEls,
      ...modalRoots,
      ...wizardRoots,
      ...toolbarRoots,
      ...navRoots,
    ];
    const bareInteractives: RawAction[] = [];
    let interactiveCount = 0;
    const seenBare = new Set<BrowserAny>();
    for (const el of allInteractive) {
      if (!isVisible(el)) continue;
      interactiveCount += 1;
      if (isInsideAny(el, excluded)) continue;
      if (seenBare.has(el)) continue;
      seenBare.add(el);
      bareInteractives.push(buildAction(el));
      if (bareInteractives.length >= 60) break;
    }

    // Body text — visible body innerText, capped.
    const body = doc.body;
    const bodyText = body && body.innerText ? String(body.innerText).slice(0, 20_000) : '';

    const url = w.location ? w.location.href : '';
    const title = doc.title || '';
    let primaryHeading: string | undefined;
    const h1 = doc.querySelector('h1');
    if (h1 && h1.textContent) primaryHeading = h1.textContent.trim();

    const result: RawExtraction = {
      url,
      title,
      bodyText,
      forms,
      tables,
      modals,
      wizards,
      toolbars,
      navLinks,
      bareInteractives,
      interactiveCount,
    };
    if (primaryHeading) result.primaryHeading = primaryHeading;
    return JSON.stringify(result);
  };

  let serialized: string;
  try {
    serialized = await page.evaluate(browserFn);
  } catch (err) {
    // Defensive: if evaluation fails (page closed mid-call, etc.) emit a
    // minimal model so callers don't crash.
    const url = (() => {
      try {
        return page.url();
      } catch {
        return '';
      }
    })();
    return {
      url,
      route: deriveRoute(url),
      title: '',
      forms: [],
      tables: [],
      modals: [],
      wizards: [],
      toolbars: [],
      navLinks: [],
      bareInteractives: [],
      discovered: [],
      network: signals?.network ?? [],
      console: signals?.console ?? [],
      textHash: '',
      looksBroken: true,
      interactiveCount: 0,
      capturedAt: new Date().toISOString(),
    };
  }

  let raw: RawExtraction;
  try {
    raw = JSON.parse(serialized) as RawExtraction;
  } catch {
    raw = {
      url: page.url(),
      title: '',
      bodyText: '',
      forms: [],
      tables: [],
      modals: [],
      wizards: [],
      toolbars: [],
      navLinks: [],
      bareInteractives: [],
      interactiveCount: 0,
    };
  }

  const route = deriveRoute(raw.url || page.url());
  const forms = raw.forms.map((f, i) => rawToForm(f, route, i));
  const tables = raw.tables.map((t, i) => rawToTable(t, route, i));
  const modals = raw.modals.map((m, i) => rawToModal(m, route, i));
  const wizards = raw.wizards.map((w, i) => rawToWizard(w, route, i));
  const toolbars = raw.toolbars.map(rawToActionRef);
  const navLinks = raw.navLinks.map(rawToActionRef);
  const bareInteractives = raw.bareInteractives.map(rawToActionRef);

  const model: PageModel = {
    url: raw.url || page.url(),
    route,
    title: raw.title,
    forms,
    tables,
    modals,
    wizards,
    toolbars,
    navLinks,
    bareInteractives,
    discovered: [],
    network: signals?.network ?? [],
    console: signals?.console ?? [],
    textHash: computeTextHash(raw.bodyText || ''),
    looksBroken: raw.interactiveCount < 8,
    interactiveCount: raw.interactiveCount,
    capturedAt: new Date().toISOString(),
  };
  if (raw.primaryHeading) model.primaryHeading = raw.primaryHeading;
  return model;
}
