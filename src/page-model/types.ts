/**
 * Structured representation of a page state, produced by the parser and
 * consumed by playbooks, the crawler, and the agent loop. Replaces the v1
 * flat element list (`fastSnapshot`).
 */

export type ElementType =
  | 'button'
  | 'link'
  | 'input'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'tab'
  | 'menuitem'
  | 'option'
  | 'row'
  | 'cell'
  | 'heading'
  | 'dialog'
  | 'other';

/** A reference to a clickable / interactable element. */
export interface ActionRef {
  /** Stable Playwright locator. Preference order:
   * 1. `[data-testid="X"]`
   * 2. `#X` (element id)
   * 3. `role=NAME[name="X"]`
   * 4. `text="X"`
   */
  locator: string;
  label: string;
  type: ElementType;
  disabled: boolean;
  /** Heuristic classification — does this look like navigation (link, "Back",
   * "Cancel", "Close") or an action (Save, Submit, Delete, Add, Send)? */
  intent: 'navigate' | 'action' | 'unknown';
}

/** A single field inside a form. */
export interface FormFieldSpec {
  locator: string;
  label: string;
  /** HTML input `type` for `<input>` or 'select'/'textarea'/'checkbox'/etc. */
  type: string;
  required: boolean;
  placeholder?: string;
  constraints: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    /** For `<select>` and radio groups. */
    options?: string[];
  };
}

/** A discovered form. Stable id is hashed from (route, ordered field labels). */
export interface FormSpec {
  id: string;
  formLocator: string;
  /** Heuristic name: visible heading, aria-label, or "Form #N". */
  name: string;
  fields: FormFieldSpec[];
  submit?: ActionRef;
  cancel?: ActionRef;
  /** Other action-intent buttons inside the form (Save Draft, Apply, etc.). */
  extraActions: ActionRef[];
  /** Is this form rendered inside a dialog/modal? */
  inModal: boolean;
}

/** A column header in a table. */
export interface TableColumn {
  label: string;
  /** Locator for the `<th>` element (used for click-to-sort). */
  headerLocator: string;
  sortable: boolean;
}

/** A discovered table. */
export interface TableSpec {
  id: string;
  tableLocator: string;
  name: string;
  columns: TableColumn[];
  /** Visible row count (excluding header). */
  rowCount: number;
  /** Per-row interactive elements detected (kebab, edit, delete icons,
   * inline buttons). Sample taken from the first visible row. */
  rowActions: ActionRef[];
  /** Bulk action elements often near a select-all checkbox. */
  bulkActions: ActionRef[];
  pagination?: {
    locator: string;
    currentPage?: number;
    totalPages?: number;
  };
  /** Filter / search affordances near the table. */
  filters: ActionRef[];
}

/** A discovered modal / dialog. */
export interface ModalSpec {
  id: string;
  modalLocator: string;
  name: string;
  /** Form inside the modal, if any. */
  form?: FormSpec;
  /** Close affordances. */
  closers: {
    x?: ActionRef;
    cancel?: ActionRef;
    /** True if pressing Escape dismisses (heuristic: most `[role=dialog]`s do). */
    escapeWorks: boolean;
    /** True if clicking outside dismisses (heuristic: presence of overlay). */
    clickOutsideCloses: boolean;
  };
  primaryAction?: ActionRef;
  /** Heuristic: does this modal "expand" into an edit screen? Set if it has
   * its own URL fragment, a "View full" / "Open in new" link, or is large
   * enough that the form-inside-modal looks like an edit screen rather than
   * a quick-action dialog. */
  isEditScreenLike: boolean;
}

/** A multi-step wizard / stepper. */
export interface WizardSpec {
  id: string;
  wizardLocator: string;
  name: string;
  steps: Array<{ label: string; index: number; isCurrent: boolean }>;
  next?: ActionRef;
  back?: ActionRef;
  skip?: ActionRef;
  finish?: ActionRef;
  cancel?: ActionRef;
}

/** An HTTP response anomaly captured by the browser server's network listener. */
export interface NetworkAnomaly {
  ts: number;
  status: number;
  method: string;
  url: string;
  resourceType: string;
}

/** A console message captured by the browser server's console listener. */
export interface ConsoleEntry {
  ts: string;
  level: 'error' | 'warning' | 'pageerror';
  text: string;
  url?: string;
}

/** Result of clicking a candidate trigger and observing what changed. The
 * affordance probe records one of these per probed trigger so agents can see
 * "what's behind that button" without burning their own turns finding out.
 *
 * The probe is non-destructive: it opens, classifies, and dismisses. */
export type AffordanceOutcome =
  | { kind: 'modal'; modalName: string; hasForm: boolean }
  | { kind: 'wizard'; wizardName: string; stepCount: number }
  | { kind: 'inline-form'; formName: string }
  | { kind: 'navigation'; toRoute: string }
  | { kind: 'menu'; items: string[] }
  | { kind: 'toast'; text?: string }
  | { kind: 'inert' }
  | { kind: 'error'; detail: string };

export interface DiscoveredAffordance {
  trigger: ActionRef;
  /** Where on the page the trigger sits — "toolbar", "row", "header", "tab-focus". */
  context: 'toolbar' | 'header' | 'row' | 'tab-focus' | 'page';
  outcome: AffordanceOutcome;
}

/** Top-level structured page state. */
export interface PageModel {
  url: string;
  /** origin + pathname (no query/fragment). */
  route: string;
  title: string;
  primaryHeading?: string;
  forms: FormSpec[];
  tables: TableSpec[];
  modals: ModalSpec[];
  wizards: WizardSpec[];
  /** Primary action bars, often above tables/forms. */
  toolbars: ActionRef[];
  /** Top-level navigation entries. */
  navLinks: ActionRef[];
  /** Anything else clickable not classified above. */
  bareInteractives: ActionRef[];
  /** Affordances surfaced by clicking buttons/kebabs/etc. and observing
   * what opened. Optional: absent (or empty) if the route hasn't been probed
   * yet. The probe is non-destructive but takes a few seconds, so it only
   * runs on first visit (or when an agent invokes the
   * `discover_route_affordances` playbook). */
  discovered?: DiscoveredAffordance[];
  /** Recent network anomalies since last extraction. */
  network: NetworkAnomaly[];
  /** Recent console entries since last extraction. */
  console: ConsoleEntry[];
  /** Sha1 of visible body text — cheap "did this page actually change?" signal. */
  textHash: string;
  /** Was the page mostly empty / broken at extract time? */
  looksBroken: boolean;
  /** Total interactive element count — useful for "is this a real page?" heuristic. */
  interactiveCount: number;
  capturedAt: string;
}
