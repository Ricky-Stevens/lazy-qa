/**
 * Parser: Playwright Page → PageModel.
 *
 * Strategy (WP4.D — AX-tree replacement):
 *   1. `page.ariaSnapshot({ mode: 'ai' })` is the primary tree source. It
 *      returns a YAML representation of the accessibility tree with `[ref=eN]`
 *      element references. We parse it and walk it for forms / tables /
 *      dialogs / tablists / toolbars / nav / standalone interactives.
 *   2. A small `page.evaluate` builds a map of (name, role) → testid/id so
 *      we can preserve the locator preference (data-testid > #id > role+name
 *      > text=) even though the AX tree carries no DOM attributes.
 *   3. A second small `page.evaluate` collects HTML form-field constraints
 *      (required / min / max / pattern / options / placeholder) keyed by
 *      label, name, or id — the AX tree drops these.
 *   4. The AX tree omits `role: form` for unlabeled `<form>`s. To avoid
 *      regressing that case we also harvest a small list of "bare form
 *      structures" from the same constraint-extraction evaluate.
 *
 * Note on Playwright API: `page.accessibility.snapshot()` was removed in
 * Playwright 1.42; `page.ariaSnapshot({ mode: 'ai' })` is the modern
 * replacement and ships in 1.59 (this project's version). The output is
 * standard YAML, parsed via the `yaml` package.
 */

import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import YAML from 'yaml';
import { deriveRoute } from '../util/route.ts';
import type {
  ActionRef,
  BareFieldRef,
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

// ---------------------------------------------------------------------------
// Public API: stable across the rewrite.
// ---------------------------------------------------------------------------

const ACTION_KEYWORDS =
  /^(save|submit|create|add|delete|remove|apply|publish|run|send|invite|approve|reject|update|confirm|sign\s*in|log\s*in)/;
const NAVIGATE_KEYWORDS = /^(cancel|back|close|more|view|details|edit|open|next|previous)/;

export function classifyIntent(label: string, hasHref: boolean): ActionRef['intent'] {
  const trimmed = label.trim().toLowerCase();
  if (ACTION_KEYWORDS.test(trimmed)) return 'action';
  if (NAVIGATE_KEYWORDS.test(trimmed)) return 'navigate';
  if (hasHref) return 'navigate';
  return 'unknown';
}

/** Stable form id: sha1(route + ordered field labels). Truncated to 12 chars. */
export function formIdFor(route: string, fieldLabels: string[]): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  for (const lbl of fieldLabels) {
    h.update(lbl);
    h.update('');
  }
  return `form_${h.digest('hex').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// AX-tree parsing
// ---------------------------------------------------------------------------

/** A flattened node decoded from the YAML AX-tree. */
interface AXNode {
  role: string;
  name: string;
  ref?: string;
  /** Bracketed flag attributes from the head: `[disabled]`, `[selected]`,
   *  `[level=2]`, `[active]`, etc. */
  flags: Record<string, string | boolean>;
  /** Slash-prefixed attributes like `/url:`, `/placeholder:`. */
  attrs: Record<string, string>;
  /** Inline text after the colon — e.g. `button "Close": ×`. */
  text?: string;
  children: AXNode[];
}

/**
 * Parse a head string of the form `role "Name" [flag] [k=v] [ref=eN]`.
 * The role is the first whitespace-delimited token. The name is the
 * double-quoted segment that immediately follows (if any). Anything in
 * `[brackets]` becomes a flag/attr.
 */
function parseHead(head: string): {
  role: string;
  name: string;
  ref?: string;
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  let role = '';
  let name = '';
  let ref: string | undefined;

  // 1. Role: first run of letters/dashes.
  const roleMatch = head.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (!roleMatch) return { role: '', name: '', flags };
  role = roleMatch[1] ?? '';
  let cursor = role.length;

  // 2. Optional name: " ... " possibly with escaped quotes.
  while (cursor < head.length && head[cursor] === ' ') cursor++;
  if (head[cursor] === '"') {
    cursor++;
    let buf = '';
    while (cursor < head.length) {
      const ch = head[cursor];
      if (ch === '\\' && head[cursor + 1] !== undefined) {
        buf += head[cursor + 1];
        cursor += 2;
        continue;
      }
      if (ch === '"') {
        cursor++;
        break;
      }
      buf += ch;
      cursor++;
    }
    name = buf;
  }

  // 3. Bracketed flags.
  const tail = head.slice(cursor);
  const bracketRe = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null = bracketRe.exec(tail);
  while (m !== null) {
    const inner = m[1] ?? '';
    if (inner.startsWith('ref=')) {
      ref = inner.slice(4);
    } else if (inner.includes('=')) {
      const idx = inner.indexOf('=');
      const k = inner.slice(0, idx);
      const v = inner.slice(idx + 1);
      flags[k] = v;
    } else {
      flags[inner] = true;
    }
    m = bracketRe.exec(tail);
  }

  return { role, name, ref, flags };
}

/** Convert one node from the YAML structure into an AXNode. */
function decodeNode(key: string, value: unknown): AXNode {
  const head = parseHead(key);
  const node: AXNode = {
    role: head.role,
    name: head.name,
    flags: head.flags,
    attrs: {},
    children: [],
  };
  if (head.ref) node.ref = head.ref;

  if (typeof value === 'string') {
    node.text = value;
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        // A bare child like `textbox "Name" [ref=e5]` (no further nesting).
        const childHead = parseHead(item);
        const childNode: AXNode = {
          role: childHead.role,
          name: childHead.name,
          flags: childHead.flags,
          attrs: {},
          children: [],
        };
        if (childHead.ref) childNode.ref = childHead.ref;
        node.children.push(childNode);
      } else if (item && typeof item === 'object') {
        // Either `{role-key: children-array}` or a slash-attr like `{/url: /foo}`.
        for (const [ck, cv] of Object.entries(item as Record<string, unknown>)) {
          if (ck.startsWith('/')) {
            node.attrs[ck.slice(1)] = String(cv);
          } else if (ck === 'text') {
            // A leaf "- text: Hello" becomes { text: "Hello" } at this level.
            node.children.push({
              role: 'text',
              name: String(cv),
              flags: {},
              attrs: {},
              children: [],
            });
          } else {
            node.children.push(decodeNode(ck, cv));
          }
        }
      }
    }
  }
  return node;
}

/** Parse the YAML output of `ariaSnapshot({ mode: 'ai' })` into a flat list
 *  of top-level AXNodes. Returns `[]` for an empty page. */
function parseAxYaml(yamlStr: string): AXNode[] {
  if (!yamlStr.trim()) return [];
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlStr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: AXNode[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      const head = parseHead(item);
      const n: AXNode = {
        role: head.role,
        name: head.name,
        flags: head.flags,
        attrs: {},
        children: [],
      };
      if (head.ref) n.ref = head.ref;
      out.push(n);
    } else if (item && typeof item === 'object') {
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        out.push(decodeNode(k, v));
      }
    }
  }
  return out;
}

/** Walk an AXNode tree (depth-first) yielding each node. */
function* walkAx(roots: AXNode[]): Generator<{ node: AXNode; ancestors: AXNode[] }> {
  const stack: Array<{ node: AXNode; ancestors: AXNode[] }> = roots.map((r) => ({
    node: r,
    ancestors: [],
  }));
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    yield cur;
    for (let i = cur.node.children.length - 1; i >= 0; i--) {
      const ch = cur.node.children[i];
      if (!ch) continue;
      stack.push({ node: ch, ancestors: [...cur.ancestors, cur.node] });
    }
  }
}

// ---------------------------------------------------------------------------
// DOM-side data: testid/id map + form constraints + bare-form skeletons.
// ---------------------------------------------------------------------------

interface DomFieldRecord {
  /** Best-effort match key: aria-label, label-text, name, or id (lowercased). */
  matchKeys: string[];
  required: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: string[];
  /** Resolved testid for this field, if any. */
  testid?: string;
  /** Resolved DOM id for this field, if any. */
  domId?: string;
  /** Tag/type used for type resolution: 'text', 'email', 'password', 'select',
   *  'textarea', 'checkbox', 'radio', etc. */
  type: string;
  /** Best human-readable label we could derive on the DOM side. */
  label: string;
  /** Index inside the form (for stable joins to AX-derived fields). */
  formIndex: number;
}

interface DomFormSkeleton {
  /** Best-effort form name (heading, aria-label, or empty). */
  name: string;
  ariaLabel?: string;
  testid?: string;
  domId?: string;
  /** Heuristic: form sits inside a `[role=dialog]`. */
  inModal: boolean;
  /** All visible non-hidden field records, in document order. */
  fields: DomFieldRecord[];
  /** All visible action-like elements inside the form (submit/buttons), in
   *  document order. */
  actionLabels: Array<{ label: string; testid?: string; domId?: string; href?: string }>;
}

interface DomLocatorEntry {
  /** `${role}::${name}` lowercased. */
  key: string;
  testid?: string;
  domId?: string;
  href?: string;
  /** Filled for buttons/links so we know if the element is disabled. */
  disabled?: boolean;
}

interface DomScan {
  /** Multimap: each entry is one (role, name) → locator-data pair. We use an
   *  array because the same (role,name) can recur (e.g. several "Cancel"
   *  buttons). The walker pops entries left-to-right to match document order. */
  locatorEntries: DomLocatorEntry[];
  /** All visible forms. */
  forms: DomFormSkeleton[];
  /** Total visible interactive count. */
  interactiveCount: number;
  /** Body innerText (capped). */
  bodyText: string;
  /** Whether at least one element matching `[class*="overlay" i]` etc. exists. */
  hasOverlay: boolean;
  /** Selectors for tables that the AX tree may have rendered as `role: table`
   *  but where we want to lookup the testid/id map for the table container.
   *  `sortableHeaders` is the lowercased column-label set that has aria-sort
   *  or data-sortable, so the AX walker can flag columns the AX tree drops. */
  tables: Array<{
    name: string;
    testid?: string;
    domId?: string;
    ariaLabel?: string;
    sortableHeaders: string[];
  }>;
  /** Toolbars with role attribute (for lookup). */
  toolbars: Array<{ testid?: string; domId?: string; ariaLabel?: string }>;
  /** Navigation containers. */
  navs: Array<{ testid?: string; domId?: string; ariaLabel?: string }>;
  /** Modals (`[role=dialog]` / `[aria-modal=true]`). */
  modals: Array<{ name: string; testid?: string; domId?: string; ariaLabel?: string }>;
  /** Wizard / tablist roots (for dedup + locator lookup). `currentTabs` is
   *  the lowercased aria-label / text of any tab carrying aria-current="step",
   *  aria-selected="true", or class~="current"/"active" — used to set
   *  `isCurrent` on AX-derived steps which the AX YAML strips. */
  wizards: Array<{
    name: string;
    testid?: string;
    domId?: string;
    ariaLabel?: string;
    currentTabs: string[];
  }>;
  /** Page metadata. */
  url: string;
  title: string;
  primaryHeading?: string;
}

/**
 * The single in-page evaluate. Returns a JSON-safe object with everything we
 * need from the DOM that the AX tree won't carry (testids, ids, constraints,
 * structural roots for fallback, page metadata, body text).
 *
 * Kept deliberately small (~120 LOC) compared to the old monolithic walker.
 */
function domScanScript(): string {
  // We return the function source as a string so the runtime can pass it
  // through `page.evaluate(...)` without TypeScript complaining about DOM
  // globals that aren't in our tsconfig `lib`.
  return `() => {
    const w = window;
    const doc = document;

    const isVisible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = w.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity || '1') < 0.05) return false;
      return true;
    };

    const labelTextFor = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const ref = doc.getElementById(lb);
        if (ref && ref.textContent) return ref.textContent.trim();
      }
      if (el.id) {
        try {
          const lbl = doc.querySelector('label[for="' + (w.CSS && w.CSS.escape ? w.CSS.escape(el.id) : el.id) + '"]');
          if (lbl && lbl.textContent) return lbl.textContent.trim();
        } catch (_) {}
      }
      let walker = el.parentElement;
      while (walker) {
        if (String(walker.tagName).toLowerCase() === 'label') {
          const clone = walker.cloneNode(true);
          for (const inner of Array.from(clone.querySelectorAll('input, textarea, select'))) {
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
      const nameAttr = el.getAttribute('name');
      if (nameAttr) return nameAttr.trim();
      return '';
    };

    const inDialog = (el) => {
      let p = el.parentElement;
      while (p) {
        if (
          p.getAttribute &&
          (p.getAttribute('role') === 'dialog' ||
            p.getAttribute('role') === 'alertdialog' ||
            p.getAttribute('aria-modal') === 'true')
        )
          return true;
        p = p.parentElement;
      }
      return false;
    };

    const interactiveLabel = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (text) return text.slice(0, 80);
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
      const v = el.value;
      if (v) return String(v).slice(0, 80);
      return '';
    };

    const ariaRoleFor = (el) => {
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

    const isDisabled = (el) => {
      if (el.hasAttribute && el.hasAttribute('disabled')) return true;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      return false;
    };

    const locatorEntries = [];
    const recordLocator = (el, role, name) => {
      const testid = el.getAttribute && el.getAttribute('data-testid');
      const domId = el.id || undefined;
      const tag = String(el.tagName).toLowerCase();
      const href = tag === 'a' ? (el.getAttribute('href') || undefined) : undefined;
      const e = { key: (role + '::' + (name || '')).toLowerCase() };
      if (testid) e.testid = testid;
      if (domId) e.domId = domId;
      if (href) e.href = href;
      e.disabled = isDisabled(el);
      locatorEntries.push(e);
    };

    // Structural roots.
    const formEls = Array.from(doc.querySelectorAll('form'));
    const formSkeletons = [];
    for (const formEl of formEls) {
      if (!isVisible(formEl)) continue;
      const ariaLabel = formEl.getAttribute('aria-label') || undefined;
      const testid = formEl.getAttribute('data-testid') || undefined;
      const domId = formEl.id || undefined;
      let name = ariaLabel || '';
      if (!name) {
        const heading = formEl.querySelector('h1, h2, h3');
        if (heading && heading.textContent) name = heading.textContent.trim();
      }
      // Collect testid/id locator data for the form container itself.
      recordLocator(formEl, 'form', name);

      const fields = [];
      const fieldEls = Array.from(formEl.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
      ));
      const seenRadioGroups = new Set();
      let formIndex = 0;
      for (const fe of fieldEls) {
        if (!isVisible(fe)) continue;
        const tag = String(fe.tagName).toLowerCase();
        const inputType = tag === 'input' ? (fe.getAttribute('type') || 'text').toLowerCase() : tag;
        if (inputType === 'radio') {
          const nm = fe.getAttribute('name') || '';
          if (nm && seenRadioGroups.has(nm)) continue;
          if (nm) seenRadioGroups.add(nm);
        }
        const lbl = labelTextFor(fe) || fe.getAttribute('name') || '';
        const matchKeys = [];
        if (lbl) matchKeys.push(lbl.toLowerCase());
        const nm = fe.getAttribute('name');
        if (nm) matchKeys.push(nm.toLowerCase());
        const placeholder = fe.getAttribute('placeholder') || undefined;
        if (placeholder) matchKeys.push(placeholder.toLowerCase());
        if (fe.id) matchKeys.push(String(fe.id).toLowerCase());
        const required = fe.hasAttribute('required') || fe.getAttribute('aria-required') === 'true';
        const minAttr = fe.getAttribute('min');
        const maxAttr = fe.getAttribute('max');
        const minLengthAttr = fe.getAttribute('minlength');
        const maxLengthAttr = fe.getAttribute('maxlength');
        const pattern = fe.getAttribute('pattern') || undefined;
        let options;
        if (tag === 'select') {
          options = Array.from(fe.querySelectorAll('option'))
            .map((o) => (o.textContent || '').trim())
            .filter((s) => s.length > 0);
        } else if (inputType === 'radio') {
          const radioName = fe.getAttribute('name') || '';
          if (radioName) {
            options = Array.from(
              formEl.querySelectorAll('input[type="radio"][name="' + radioName.replace(/"/g, '\\\\"') + '"]'),
            ).map((r) => labelTextFor(r) || r.getAttribute('value') || '');
          }
        }
        const rec = {
          matchKeys: Array.from(new Set(matchKeys)).filter(Boolean),
          required,
          type: inputType,
          label: lbl,
          formIndex: formIndex++,
        };
        if (placeholder) rec.placeholder = placeholder;
        if (minAttr !== null && !Number.isNaN(Number(minAttr))) rec.min = Number(minAttr);
        if (maxAttr !== null && !Number.isNaN(Number(maxAttr))) rec.max = Number(maxAttr);
        if (minLengthAttr !== null && !Number.isNaN(Number(minLengthAttr)))
          rec.minLength = Number(minLengthAttr);
        if (maxLengthAttr !== null && !Number.isNaN(Number(maxLengthAttr)))
          rec.maxLength = Number(maxLengthAttr);
        if (pattern) rec.pattern = pattern;
        if (options && options.length > 0) rec.options = options;
        const ftestid = fe.getAttribute('data-testid');
        if (ftestid) rec.testid = ftestid;
        if (fe.id) rec.domId = fe.id;
        fields.push(rec);

        // Also record locator entry for the field so AX-walk can find it.
        recordLocator(fe, ariaRoleFor(fe), lbl);
      }

      // Action elements inside the form.
      const actionEls = Array.from(formEl.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]',
      ));
      const actionLabels = [];
      for (const ae of actionEls) {
        if (!isVisible(ae)) continue;
        const lbl = interactiveLabel(ae);
        const a = { label: lbl };
        const at = ae.getAttribute('data-testid');
        if (at) a.testid = at;
        if (ae.id) a.domId = ae.id;
        actionLabels.push(a);
        recordLocator(ae, ariaRoleFor(ae), lbl);
      }

      const skel = {
        name,
        inModal: inDialog(formEl),
        fields,
        actionLabels,
      };
      if (ariaLabel) skel.ariaLabel = ariaLabel;
      if (testid) skel.testid = testid;
      if (domId) skel.domId = domId;
      formSkeletons.push(skel);
    }

    // Tables.
    const tableEls = Array.from(doc.querySelectorAll('table, [role="table"]'));
    const tables = [];
    for (const t of tableEls) {
      if (!isVisible(t)) continue;
      let name = t.getAttribute('aria-label') || '';
      const caption = t.querySelector('caption');
      if (!name && caption && caption.textContent) name = caption.textContent.trim();
      if (!name) {
        let walker = t.previousElementSibling;
        while (walker) {
          if (/^h[1-4]$/i.test(walker.tagName)) {
            name = (walker.textContent || '').trim();
            break;
          }
          walker = walker.previousElementSibling;
        }
      }
      const sortableHeaders = [];
      // Headers — record locators so AX walk can find them, and capture
      // aria-sort / data-sortable / nested-button signals.
      const headerEls = Array.from(t.querySelectorAll('thead th, [role="columnheader"]'));
      for (const h of headerEls) {
        const lbl = (h.textContent || '').trim().replace(/\\s+/g, ' ');
        recordLocator(h, 'columnheader', lbl);
        const sortable =
          h.getAttribute('aria-sort') !== null ||
          h.hasAttribute('data-sortable') ||
          !!h.querySelector('button, [role="button"]');
        if (sortable) sortableHeaders.push(lbl.toLowerCase());
      }
      const rec = { name, sortableHeaders };
      const at = t.getAttribute('data-testid');
      if (at) rec.testid = at;
      if (t.id) rec.domId = t.id;
      const al = t.getAttribute('aria-label');
      if (al) rec.ariaLabel = al;
      tables.push(rec);
      recordLocator(t, 'table', name);
    }

    // Modals.
    const modalEls = Array.from(doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
    const modals = [];
    for (const m of modalEls) {
      if (!isVisible(m)) continue;
      let name = m.getAttribute('aria-label') || '';
      if (!name) {
        const lb = m.getAttribute('aria-labelledby');
        if (lb) {
          const ref = doc.getElementById(lb);
          if (ref && ref.textContent) name = ref.textContent.trim();
        }
      }
      if (!name) {
        const heading = m.querySelector('h1, h2, h3');
        if (heading && heading.textContent) name = heading.textContent.trim();
      }
      const rec = { name };
      const at = m.getAttribute('data-testid');
      if (at) rec.testid = at;
      if (m.id) rec.domId = m.id;
      const al = m.getAttribute('aria-label');
      if (al) rec.ariaLabel = al;
      modals.push(rec);
      const role = m.getAttribute('role') || 'dialog';
      recordLocator(m, role, name);
    }

    // Wizards / tablists.
    const wizardCandidates = Array.from(doc.querySelectorAll(
      '[role="tablist"], [class*="wizard" i], [class*="stepper" i], [data-testid*="wizard"], [data-testid*="stepper"], [aria-label*="Step" i]'
    ));
    const wizardRoots = [];
    for (const w of wizardCandidates) {
      if (!isVisible(w)) continue;
      let skip = false;
      for (const existing of wizardRoots) {
        if (existing.contains(w)) { skip = true; break; }
        if (w.contains(existing)) {
          wizardRoots.splice(wizardRoots.indexOf(existing), 1);
          break;
        }
      }
      if (skip) continue;
      wizardRoots.push(w);
    }
    const wizards = [];
    for (const w of wizardRoots) {
      let name = w.getAttribute('aria-label') || '';
      if (!name) {
        const heading = w.querySelector('h1, h2, h3');
        if (heading && heading.textContent) name = heading.textContent.trim();
      }
      // Identify tabs whose label matches one carrying aria-current="step",
      // aria-selected="true", or class~="current"/"active".
      const currentTabs = [];
      const tabEls = Array.from(w.querySelectorAll('[role="tab"]'));
      for (const tabEl of tabEls) {
        const isCurrent =
          tabEl.getAttribute('aria-current') === 'step' ||
          tabEl.getAttribute('aria-selected') === 'true' ||
          /current|active/i.test(tabEl.getAttribute('class') || '');
        if (!isCurrent) continue;
        // The AX YAML names tabs by their aria-label or visible text. Capture
        // both so we can match at walker time.
        const al = tabEl.getAttribute('aria-label');
        if (al) currentTabs.push(al.toLowerCase());
        const txt = (tabEl.textContent || '').trim();
        if (txt) currentTabs.push(txt.toLowerCase());
      }
      const rec = { name, currentTabs };
      const at = w.getAttribute('data-testid');
      if (at) rec.testid = at;
      if (w.id) rec.domId = w.id;
      const al = w.getAttribute('aria-label');
      if (al) rec.ariaLabel = al;
      wizards.push(rec);
    }

    // Toolbars.
    const toolbarEls = Array.from(doc.querySelectorAll('[role="toolbar"]'));
    const toolbars = [];
    for (const tb of toolbarEls) {
      if (!isVisible(tb)) continue;
      const rec = {};
      const at = tb.getAttribute('data-testid');
      if (at) rec.testid = at;
      if (tb.id) rec.domId = tb.id;
      const al = tb.getAttribute('aria-label');
      if (al) rec.ariaLabel = al;
      toolbars.push(rec);
    }

    // Nav.
    const navEls = Array.from(doc.querySelectorAll('nav, [role="navigation"]'));
    const navs = [];
    for (const nav of navEls) {
      if (!isVisible(nav)) continue;
      const rec = {};
      const at = nav.getAttribute('data-testid');
      if (at) rec.testid = at;
      if (nav.id) rec.domId = nav.id;
      const al = nav.getAttribute('aria-label');
      if (al) rec.ariaLabel = al;
      navs.push(rec);
    }

    // Generic interactive elements: capture testid/id/href for every visible
    // button / link / role=button / role=link so the AX walker can resolve
    // locators by (role, name).
    const allInteractive = Array.from(doc.querySelectorAll(
      'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], [role="checkbox"], [role="radio"], [role="switch"]'
    ));
    let interactiveCount = 0;
    for (const el of allInteractive) {
      if (!isVisible(el)) continue;
      interactiveCount++;
      const lbl = interactiveLabel(el);
      const role = ariaRoleFor(el);
      recordLocator(el, role, lbl);
    }

    // Body text + page metadata.
    const body = doc.body;
    const bodyText = body && body.innerText ? String(body.innerText).slice(0, 20000) : '';
    const url = w.location ? w.location.href : '';
    const title = doc.title || '';
    let primaryHeading;
    const h1 = doc.querySelector('h1');
    if (h1 && h1.textContent) primaryHeading = h1.textContent.trim();

    const hasOverlay = !!doc.querySelector(
      '[class*="overlay" i], [class*="backdrop" i], [data-testid*="overlay"]'
    );

    const out = {
      locatorEntries,
      forms: formSkeletons,
      interactiveCount,
      bodyText,
      hasOverlay,
      tables,
      toolbars,
      navs,
      modals,
      wizards,
      url,
      title,
    };
    if (primaryHeading) out.primaryHeading = primaryHeading;
    return JSON.stringify(out);
  }`;
}

// ---------------------------------------------------------------------------
// Locator resolution
// ---------------------------------------------------------------------------

/** Encode a string for embedding in a CSS attribute selector. */
function escAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** A small index of locator entries keyed by `${role}::${name}` (lowercased)
 *  with FIFO popping so duplicates resolve to distinct DOM elements. */
class LocatorIndex {
  private buckets = new Map<string, DomLocatorEntry[]>();

  constructor(entries: DomLocatorEntry[]) {
    for (const e of entries) {
      const arr = this.buckets.get(e.key) ?? [];
      arr.push(e);
      this.buckets.set(e.key, arr);
    }
  }

  /** Pop the next entry for (role, name). Falls back to a relaxed lookup if
   *  the strict (role,name) key has no remaining entries. */
  pop(role: string, name: string): DomLocatorEntry | undefined {
    const key = `${role}::${(name || '').toLowerCase()}`;
    const arr = this.buckets.get(key);
    if (arr && arr.length > 0) return arr.shift();
    // Relaxed: try just by name (any role) — handy for buttons whose AX role
    // differs from our DOM-assigned role (e.g. `combobox` vs `select`).
    for (const [k, v] of this.buckets) {
      if (v.length === 0) continue;
      const sep = k.indexOf('::');
      if (k.slice(sep + 2) === (name || '').toLowerCase()) {
        return v.shift();
      }
    }
    return undefined;
  }

  /** Peek without consuming — used for container locators where multiple AX
   *  nodes may legitimately reference the same DOM element. */
  peek(role: string, name: string): DomLocatorEntry | undefined {
    const key = `${role}::${(name || '').toLowerCase()}`;
    const arr = this.buckets.get(key);
    if (arr && arr.length > 0) return arr[0];
    return undefined;
  }
}

/** Build the AX-locator string Playwright accepts for a given role+name. */
function axLocator(role: string, name: string): string {
  if (role && name) return `role=${role}[name="${escAttr(name.slice(0, 60))}"]`;
  if (name) return `text="${escAttr(name.slice(0, 60))}"`;
  if (role) return `role=${role}`;
  return 'unknown';
}

function resolveLocator(role: string, name: string, entry: DomLocatorEntry | undefined): string {
  if (entry?.testid) return `[data-testid="${escAttr(entry.testid)}"]`;
  if (entry?.domId) return `#${cssEscapeId(entry.domId)}`;
  return axLocator(role, name);
}

function cssEscapeId(id: string): string {
  // Approximation of CSS.escape for identifier-safe ids; falls back to
  // backslash-escape for special chars. Same approach as the previous parser.
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// AX role → ElementType mapping
// ---------------------------------------------------------------------------

function axRoleToElementType(role: string, fieldType?: string): ElementType {
  if (role === 'button') return 'button';
  if (role === 'link') return 'link';
  if (role === 'textbox') {
    if (fieldType === 'textarea') return 'textarea';
    return 'input';
  }
  if (role === 'combobox') return 'select';
  if (role === 'checkbox' || role === 'switch') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'tab') return 'tab';
  if (role === 'menuitem') return 'menuitem';
  if (role === 'option') return 'option';
  if (role === 'row') return 'row';
  if (role === 'cell' || role === 'gridcell') return 'cell';
  if (role === 'heading') return 'heading';
  if (role === 'dialog' || role === 'alertdialog') return 'dialog';
  return 'other';
}

// ---------------------------------------------------------------------------
// Field assembly: AX-derived label + DOM-derived constraints/type/locator.
// ---------------------------------------------------------------------------

function findFieldRecord(
  form: DomFormSkeleton,
  axName: string,
  axRole: string,
): DomFieldRecord | undefined {
  const lower = (axName || '').toLowerCase();
  // 1. Exact match by any matchKey.
  for (const f of form.fields) {
    if (f.matchKeys.includes(lower)) return f;
  }
  // 2. By name-vs-label substring (handles "Name " trailing space etc.).
  for (const f of form.fields) {
    for (const k of f.matchKeys) {
      if (k && (k.startsWith(lower) || lower.startsWith(k))) return f;
    }
  }
  // 3. AX role hint. textbox/select/checkbox/radio narrow.
  const wantTypes: string[] = [];
  if (axRole === 'combobox') wantTypes.push('select');
  if (axRole === 'checkbox') wantTypes.push('checkbox');
  if (axRole === 'radio') wantTypes.push('radio');
  if (axRole === 'textbox')
    wantTypes.push('text', 'email', 'password', 'tel', 'url', 'search', 'number', 'textarea');
  if (wantTypes.length > 0) {
    for (const f of form.fields) {
      if (wantTypes.includes(f.type)) return f;
    }
  }
  return undefined;
}

function rawToFieldFromAx(
  axNode: AXNode,
  form: DomFormSkeleton,
  consumedFields: Set<DomFieldRecord>,
  locators: LocatorIndex,
): FormFieldSpec {
  const axName = axNode.name || '';
  const axRole = axNode.role;
  let rec = findFieldRecord(form, axName, axRole);
  // Skip fields we've already attached to other AX nodes.
  if (rec && consumedFields.has(rec)) {
    rec = form.fields.find(
      (f) => !consumedFields.has(f) && (axRole === 'combobox' ? f.type === 'select' : true),
    );
  }
  if (rec) consumedFields.add(rec);

  const type =
    rec?.type ??
    (axRole === 'combobox'
      ? 'select'
      : axRole === 'checkbox'
        ? 'checkbox'
        : axRole === 'radio'
          ? 'radio'
          : 'text');
  const label = rec?.label || axName;
  const required = rec?.required ?? false;

  const constraints: FormFieldSpec['constraints'] = {};
  if (rec) {
    if (rec.min !== undefined) constraints.min = rec.min;
    if (rec.max !== undefined) constraints.max = rec.max;
    if (rec.minLength !== undefined) constraints.minLength = rec.minLength;
    if (rec.maxLength !== undefined) constraints.maxLength = rec.maxLength;
    if (rec.pattern !== undefined) constraints.pattern = rec.pattern;
    if (rec.options !== undefined) constraints.options = rec.options;
  }

  // Combobox AX nodes have option children; if our DOM record didn't already
  // capture options (e.g. role="combobox" on a custom div), use them.
  if (axRole === 'combobox' && (!constraints.options || constraints.options.length === 0)) {
    const opts: string[] = [];
    for (const c of axNode.children) {
      if (c.role === 'option' && c.name) opts.push(c.name);
    }
    if (opts.length > 0) constraints.options = opts;
  }

  // Locator: prefer the DOM record's own testid/id, then fall back to the
  // shared locator index, then to the AX-locator.
  let entry: DomLocatorEntry | undefined = locators.pop(axRole, label);
  if (!entry && rec && (rec.testid || rec.domId)) {
    entry = {
      key: '',
      ...(rec.testid ? { testid: rec.testid } : {}),
      ...(rec.domId ? { domId: rec.domId } : {}),
    };
  }
  const locator = resolveLocator(axRole, label, entry);

  const spec: FormFieldSpec = {
    locator,
    label,
    type,
    required,
    constraints,
  };
  if (rec?.placeholder) spec.placeholder = rec.placeholder;
  return spec;
}

// ---------------------------------------------------------------------------
// AX-tree walkers per construct
// ---------------------------------------------------------------------------

function isFormFieldRole(role: string): boolean {
  return (
    role === 'textbox' ||
    role === 'combobox' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch' ||
    role === 'searchbox' ||
    role === 'spinbutton' ||
    role === 'slider'
  );
}

function isActionRole(role: string): boolean {
  return role === 'button' || role === 'link' || role === 'menuitem';
}

function actionFromAx(node: AXNode, locators: LocatorIndex): ActionRef {
  const label = node.name || '';
  const entry = locators.pop(node.role, label);
  const hasHref = !!(entry?.href && entry.href.length > 0) || node.role === 'link';
  const elType = axRoleToElementType(node.role);
  return {
    locator: resolveLocator(node.role, label, entry),
    label,
    type: elType,
    disabled: node.flags.disabled === true || entry?.disabled === true,
    intent: classifyIntent(label, hasHref),
  };
}

/** Find every AX node descendant matching predicate (depth-first, including
 *  the root). Used to gather fields/actions inside a form/modal/wizard. */
function collectDescendants(root: AXNode, predicate: (n: AXNode) => boolean): AXNode[] {
  const out: AXNode[] = [];
  const stack: AXNode[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    if (predicate(cur)) out.push(cur);
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const c = cur.children[i];
      if (c) stack.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build PageModel from AX + DOM scan
// ---------------------------------------------------------------------------

function tableIdFor(route: string, name: string, columnLabels: string[]): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  h.update(name);
  for (const c of columnLabels) {
    h.update('');
    h.update(c);
  }
  return `table_${h.digest('hex').slice(0, 12)}`;
}

function modalIdFor(route: string, name: string, n: number): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  h.update(name);
  h.update('');
  h.update(String(n));
  return `modal_${h.digest('hex').slice(0, 12)}`;
}

function wizardIdFor(route: string, name: string, stepCount: number): string {
  const h = createHash('sha1');
  h.update(route);
  h.update('');
  h.update(name);
  h.update('');
  h.update(String(stepCount));
  return `wizard_${h.digest('hex').slice(0, 12)}`;
}

function computeTextHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** Locate a DOM form skeleton matching the AX form node by name, then by
 *  presence of the aria-label, then by index. Returns the first unconsumed
 *  match. */
function matchDomForm(
  axName: string,
  domForms: DomFormSkeleton[],
  consumed: Set<DomFormSkeleton>,
  inModal: boolean,
): DomFormSkeleton | undefined {
  const lname = (axName || '').toLowerCase();
  // 1. exact aria-label match
  for (const f of domForms) {
    if (consumed.has(f)) continue;
    if (f.inModal !== inModal) continue;
    if (f.ariaLabel && f.ariaLabel.toLowerCase() === lname) {
      return f;
    }
  }
  // 2. heading-name match
  for (const f of domForms) {
    if (consumed.has(f)) continue;
    if (f.inModal !== inModal) continue;
    if (f.name && f.name.toLowerCase() === lname) return f;
  }
  // 3. first unconsumed in matching modal scope
  for (const f of domForms) {
    if (consumed.has(f)) continue;
    if (f.inModal === inModal) return f;
  }
  // 4. first unconsumed regardless
  for (const f of domForms) {
    if (!consumed.has(f)) return f;
  }
  return undefined;
}

function buildFormFromAx(
  axNode: AXNode,
  domForm: DomFormSkeleton,
  locators: LocatorIndex,
  route: string,
  defaultIdx: number,
): FormSpec {
  // Field nodes inside the AX form, in document order.
  const axFields = collectDescendants(axNode, (n) => isFormFieldRole(n.role));
  const consumedFields = new Set<DomFieldRecord>();
  const fields: FormFieldSpec[] = axFields.map((f) =>
    rawToFieldFromAx(f, domForm, consumedFields, locators),
  );

  // Actions: AX buttons/links inside the form.
  const axActions = collectDescendants(axNode, (n) => isActionRole(n.role));
  const actionRefs: ActionRef[] = axActions.map((a) => actionFromAx(a, locators));

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

  const labels = fields.map((f) => f.label);
  const id = formIdFor(route, labels);
  const headingNode = collectDescendants(axNode, (n) => n.role === 'heading')[0];
  const axHeadingName = headingNode?.name ?? '';
  const candidateName = axNode.name || axHeadingName || domForm.name || '';
  const name = candidateName.length > 0 ? candidateName : `Form #${defaultIdx + 1}`;

  let formLocator: string;
  if (domForm.testid) {
    formLocator = `[data-testid="${escAttr(domForm.testid)}"]`;
  } else if (domForm.domId) {
    formLocator = `#${cssEscapeId(domForm.domId)}`;
  } else if (domForm.ariaLabel) {
    formLocator = `form[aria-label="${escAttr(domForm.ariaLabel)}"]`;
  } else {
    formLocator = 'form';
  }

  const spec: FormSpec = {
    id,
    formLocator,
    name,
    fields,
    extraActions: extras,
    inModal: domForm.inModal,
  };
  if (submit) spec.submit = submit;
  if (cancel) spec.cancel = cancel;
  return spec;
}

/** Build a form from a DOM-only skeleton (used when AX dropped the form
 *  because it had no aria-label). */
function buildFormFromDom(
  domForm: DomFormSkeleton,
  locators: LocatorIndex,
  route: string,
  defaultIdx: number,
): FormSpec {
  const fields: FormFieldSpec[] = domForm.fields.map((f) => {
    const constraints: FormFieldSpec['constraints'] = {};
    if (f.min !== undefined) constraints.min = f.min;
    if (f.max !== undefined) constraints.max = f.max;
    if (f.minLength !== undefined) constraints.minLength = f.minLength;
    if (f.maxLength !== undefined) constraints.maxLength = f.maxLength;
    if (f.pattern !== undefined) constraints.pattern = f.pattern;
    if (f.options !== undefined) constraints.options = f.options;
    let locator: string;
    if (f.testid) locator = `[data-testid="${escAttr(f.testid)}"]`;
    else if (f.domId) locator = `#${cssEscapeId(f.domId)}`;
    else {
      const role =
        f.type === 'select'
          ? 'combobox'
          : f.type === 'textarea'
            ? 'textbox'
            : f.type === 'checkbox'
              ? 'checkbox'
              : f.type === 'radio'
                ? 'radio'
                : 'textbox';
      locator = axLocator(role, f.label);
    }
    const spec: FormFieldSpec = {
      locator,
      label: f.label,
      type: f.type,
      required: f.required,
      constraints,
    };
    if (f.placeholder) spec.placeholder = f.placeholder;
    return spec;
  });

  const labels = fields.map((f) => f.label);
  const id = formIdFor(route, labels);

  // Build action refs from DOM action labels (we don't have AX info here).
  const actionRefs: ActionRef[] = domForm.actionLabels.map((a) => {
    const entry = locators.pop('button', a.label);
    const hasHref = !!a.href;
    return {
      locator: resolveLocator('button', a.label, entry),
      label: a.label,
      type: 'button',
      disabled: entry?.disabled === true,
      intent: classifyIntent(a.label, hasHref),
    };
  });

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

  let formLocator: string;
  if (domForm.testid) formLocator = `[data-testid="${escAttr(domForm.testid)}"]`;
  else if (domForm.domId) formLocator = `#${cssEscapeId(domForm.domId)}`;
  else formLocator = 'form';

  const name = domForm.name && domForm.name.length > 0 ? domForm.name : `Form #${defaultIdx + 1}`;
  const spec: FormSpec = {
    id,
    formLocator,
    name,
    fields,
    extraActions: extras,
    inModal: domForm.inModal,
  };
  if (submit) spec.submit = submit;
  if (cancel) spec.cancel = cancel;
  return spec;
}

function buildTableFromAx(
  axNode: AXNode,
  domTables: Array<DomScan['tables'][number]>,
  domTablesConsumed: Set<DomScan['tables'][number]>,
  locators: LocatorIndex,
  route: string,
  idx: number,
): TableSpec {
  // Match a DOM table for testid/id/aria-sort first — we need its
  // `sortableHeaders` set to compute the `sortable` column flag below.
  let domTable: DomScan['tables'][number] | undefined;
  const lname = (axNode.name || '').toLowerCase();
  for (const t of domTables) {
    if (domTablesConsumed.has(t)) continue;
    if ((t.name || '').toLowerCase() === lname || (t.ariaLabel ?? '').toLowerCase() === lname) {
      domTable = t;
      break;
    }
  }
  if (!domTable) {
    for (const t of domTables) {
      if (!domTablesConsumed.has(t)) {
        domTable = t;
        break;
      }
    }
  }
  if (domTable) domTablesConsumed.add(domTable);
  const sortableSet = new Set<string>(domTable?.sortableHeaders ?? []);

  // Columns come from columnheader descendants, in tree order.
  const headerNodes = collectDescendants(axNode, (n) => n.role === 'columnheader');
  const columns: TableColumn[] = headerNodes.map((h) => {
    const lbl = h.name || '';
    const entry = locators.pop('columnheader', lbl);
    return {
      label: lbl,
      headerLocator: resolveLocator('columnheader', lbl, entry),
      sortable: sortableSet.has(lbl.toLowerCase()) || hasButtonChild(h),
    };
  });

  // Rows: count rowgroup>row that contain `cell` (skip header-only rows).
  // Also extract sample row content (first 5 data rows) so the agent can read
  // table data straight from the snapshot without having to click into cells.
  // This is the fix for the Juice Shop /#/administration feedback-table case
  // where the BIP39 mnemonic was invisible in run #7.
  const SAMPLE_ROW_LIMIT = 5;
  const SAMPLE_CELL_CHAR_CAP = 120;
  let rowCount = 0;
  const sampleRows: string[][] = [];
  for (const c of axNode.children) {
    const dataRows: AXNode[] =
      c.role === 'rowgroup'
        ? c.children.filter(
            (r) =>
              r.role === 'row' &&
              r.children.some((x) => x.role === 'cell' || x.role === 'gridcell'),
          )
        : c.role === 'row' && c.children.some((x) => x.role === 'cell' || x.role === 'gridcell')
          ? [c]
          : [];
    for (const r of dataRows) {
      rowCount++;
      if (sampleRows.length < SAMPLE_ROW_LIMIT) {
        const cells: string[] = [];
        for (const cell of r.children) {
          if (cell.role !== 'cell' && cell.role !== 'gridcell') continue;
          // Cell text comes from .name (AX accessible-name) when present, else
          // descendants' visible text. We collect descendant text content
          // recursively so dynamic Material cells (which often wrap text in
          // nested span/div) still surface their value.
          let text = cell.name?.trim() ?? '';
          if (!text) text = collectVisibleText(cell);
          if (text.length > SAMPLE_CELL_CHAR_CAP) {
            text = `${text.slice(0, SAMPLE_CELL_CHAR_CAP)}…`;
          }
          cells.push(text);
        }
        if (cells.some((c) => c.length > 0)) {
          sampleRows.push(cells);
        }
      }
    }
  }

  const name =
    axNode.name && axNode.name.length > 0
      ? axNode.name
      : domTable?.name && domTable.name.length > 0
        ? domTable.name
        : `Table #${idx + 1}`;

  let tableLocator = 'table';
  if (domTable?.testid) tableLocator = `[data-testid="${escAttr(domTable.testid)}"]`;
  else if (domTable?.domId) tableLocator = `#${cssEscapeId(domTable.domId)}`;
  else if (domTable?.ariaLabel) tableLocator = `table[aria-label="${escAttr(domTable.ariaLabel)}"]`;

  const id = tableIdFor(
    route,
    name,
    columns.map((c) => c.label),
  );

  // Row actions: scan first data row's interactive descendants.
  let rowActions: ActionRef[] = [];
  for (const c of axNode.children) {
    const rows =
      c.role === 'rowgroup'
        ? c.children.filter((x) => x.role === 'row')
        : c.role === 'row'
          ? [c]
          : [];
    const firstDataRow = rows.find((r) =>
      r.children.some((x) => x.role === 'cell' || x.role === 'gridcell'),
    );
    if (firstDataRow) {
      const acts = collectDescendants(firstDataRow, (n) => isActionRole(n.role));
      rowActions = acts.map((a) => actionFromAx(a, locators));
      break;
    }
  }

  return {
    id,
    tableLocator,
    name,
    columns,
    rowCount,
    rowActions,
    bulkActions: [], // AX tree can't reliably localise bulk-action toolbars; parser drops these for now.
    filters: [],
    sampleRows: sampleRows.length > 0 ? sampleRows : undefined,
  };
}

/** Concatenate visible text content under an AX node. Handles the common
 *  Material table case where a cell wraps its value in nested role=text /
 *  generic nodes — `cell.name` is empty but the value is in descendants.
 *  Returns `''` for empty subtrees. Whitespace is normalised. */
function collectVisibleText(node: AXNode): string {
  const parts: string[] = [];
  function walk(n: AXNode): void {
    // Skip interactive children — they're tracked as rowActions, not cell text.
    if (isActionRole(n.role)) return;
    if (n.name && n.name.trim().length > 0) parts.push(n.name.trim());
    for (const c of n.children) walk(c);
  }
  for (const c of node.children) walk(c);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function hasButtonChild(node: AXNode): boolean {
  for (const c of node.children) {
    if (c.role === 'button') return true;
    if (hasButtonChild(c)) return true;
  }
  return false;
}

function buildModalFromAx(
  axNode: AXNode,
  domModals: Array<DomScan['modals'][number]>,
  consumedDomModals: Set<DomScan['modals'][number]>,
  locators: LocatorIndex,
  route: string,
  idx: number,
  hasOverlay: boolean,
  domForms: DomFormSkeleton[],
  consumedDomForms: Set<DomFormSkeleton>,
): ModalSpec {
  // Match DOM modal.
  let domModal: DomScan['modals'][number] | undefined;
  const lname = (axNode.name || '').toLowerCase();
  for (const m of domModals) {
    if (consumedDomModals.has(m)) continue;
    if ((m.name || '').toLowerCase() === lname) {
      domModal = m;
      break;
    }
  }
  if (!domModal) {
    for (const m of domModals) {
      if (!consumedDomModals.has(m)) {
        domModal = m;
        break;
      }
    }
  }
  if (domModal) consumedDomModals.add(domModal);

  const name = axNode.name || domModal?.name || `Modal #${idx + 1}`;
  const id = modalIdFor(route, name, idx);

  let modalLocator = '[role="dialog"]';
  if (domModal?.testid) modalLocator = `[data-testid="${escAttr(domModal.testid)}"]`;
  else if (domModal?.domId) modalLocator = `#${cssEscapeId(domModal.domId)}`;
  else if (domModal?.ariaLabel)
    modalLocator = `[role="dialog"][aria-label="${escAttr(domModal.ariaLabel)}"]`;

  // Form inside modal: find a DOM form with inModal=true and (heading match
  // OR first unconsumed) — then prefer AX-walk if there's a `form` AX node
  // descendant.
  const axInnerForm = collectDescendants(axNode, (n) => n.role === 'form')[0];
  let formInside: FormSpec | undefined;
  const innerDomForm = matchDomForm(axNode.name || '', domForms, consumedDomForms, true);
  if (axInnerForm && innerDomForm) {
    consumedDomForms.add(innerDomForm);
    formInside = buildFormFromAx(axInnerForm, innerDomForm, locators, route, idx);
  } else if (innerDomForm) {
    consumedDomForms.add(innerDomForm);
    formInside = buildFormFromDom(innerDomForm, locators, route, idx);
  }

  // Buttons inside the modal: classify into closer X / cancel / primary.
  const buttons = collectDescendants(axNode, (n) => n.role === 'button');
  let xCloser: ActionRef | undefined;
  let cancelCloser: ActionRef | undefined;
  let primaryAction: ActionRef | undefined;
  // Avoid double-consuming buttons that the form already attached locator
  // entries for. We also track which AX nodes are inside the inner form.
  const formAxNodes = axInnerForm
    ? new Set(collectDescendants(axInnerForm, () => true))
    : new Set<AXNode>();
  for (const b of buttons) {
    if (formAxNodes.has(b)) continue;
    const action = actionFromAx(b, locators);
    const lower = action.label.toLowerCase().trim();
    if (!xCloser && (lower === '×' || lower === 'x' || lower === 'close')) {
      xCloser = action;
      continue;
    }
    if (!cancelCloser && /^(cancel|close|dismiss)/.test(lower)) {
      cancelCloser = action;
      continue;
    }
    if (!primaryAction && action.intent === 'action') {
      primaryAction = action;
    }
  }

  // Edit-screen-like heuristic.
  let isEditScreenLike = false;
  if (formInside && formInside.fields.length > 5) isEditScreenLike = true;
  const expandLink = collectDescendants(axNode, (n) => n.role === 'link');
  for (const l of expandLink) {
    if (/full|expand|open in/i.test(l.name)) {
      isEditScreenLike = true;
      break;
    }
  }

  const closers: ModalSpec['closers'] = {
    escapeWorks: true,
    clickOutsideCloses: hasOverlay,
  };
  if (xCloser) closers.x = xCloser;
  if (cancelCloser) closers.cancel = cancelCloser;

  const spec: ModalSpec = {
    id,
    modalLocator,
    name,
    closers,
    isEditScreenLike,
  };
  if (formInside) spec.form = formInside;
  if (primaryAction) spec.primaryAction = primaryAction;
  return spec;
}

function buildWizardFromAx(
  axNode: AXNode,
  scopeRoots: AXNode[],
  domWizards: Array<DomScan['wizards'][number]>,
  consumedDomWizards: Set<DomScan['wizards'][number]>,
  locators: LocatorIndex,
  route: string,
  idx: number,
): WizardSpec | null {
  const tabs = axNode.children.filter((c) => c.role === 'tab');
  if (tabs.length < 2) return null;

  // Match a DOM wizard first so we can use its `currentTabs` set when
  // computing each step's `isCurrent` (the AX YAML strips aria-current). We
  // search by the parent (ancestor) name as well — the AX wizard often has
  // an empty name while its `generic "Onboarding"` ancestor carries the label.
  let domWizard: DomScan['wizards'][number] | undefined;
  const wizardName =
    axNode.name || scopeRoots.find((s) => s?.name && s.role !== 'tablist')?.name || '';
  const lname = wizardName.toLowerCase();
  for (const w of domWizards) {
    if (consumedDomWizards.has(w)) continue;
    if ((w.name || '').toLowerCase() === lname || (w.ariaLabel ?? '').toLowerCase() === lname) {
      domWizard = w;
      break;
    }
  }
  if (!domWizard) {
    for (const w of domWizards) {
      if (!consumedDomWizards.has(w)) {
        domWizard = w;
        break;
      }
    }
  }
  if (domWizard) consumedDomWizards.add(domWizard);
  const currentTabSet = new Set<string>(domWizard?.currentTabs ?? []);

  const steps = tabs.slice(0, 12).map((t, i) => {
    const labelRaw = ((t.text ?? '') || t.name || `Step ${i + 1}`).trim().replace(/\s+/g, ' ');
    const lblLower = labelRaw.toLowerCase();
    const axNameLower = (t.name || '').toLowerCase();
    const isCurrent =
      t.flags.selected === true ||
      t.flags.current === 'step' ||
      currentTabSet.has(lblLower) ||
      currentTabSet.has(axNameLower) ||
      currentTabSet.has((t.text ?? '').toLowerCase());
    return {
      label: labelRaw.slice(0, 40),
      index: i,
      isCurrent,
    };
  });

  // Find adjacent buttons in the same scope — search the tablist's nearest
  // ancestor's full subtree but exclude descendants of OTHER tablists.
  let next: ActionRef | undefined;
  let back: ActionRef | undefined;
  let skip: ActionRef | undefined;
  let finish: ActionRef | undefined;
  let cancel: ActionRef | undefined;

  const buttonsInScope = scopeRoots.flatMap((r) =>
    collectDescendants(r, (n) => n.role === 'button'),
  );
  for (const b of buttonsInScope) {
    const lower = (b.name || '').toLowerCase().trim();
    if (!next && /^next/.test(lower)) next = actionFromAx(b, locators);
    else if (!back && /^(back|previous)/.test(lower)) back = actionFromAx(b, locators);
    else if (!skip && /^skip/.test(lower)) skip = actionFromAx(b, locators);
    else if (!finish && /^(finish|done|complete|submit)/.test(lower))
      finish = actionFromAx(b, locators);
    else if (!cancel && /^cancel/.test(lower)) cancel = actionFromAx(b, locators);
  }
  if (!next && !back && !finish) return null;

  const name = wizardName || domWizard?.name || `Wizard #${idx + 1}`;
  const id = wizardIdFor(route, name, steps.length);

  let wizardLocator = '[role="tablist"]';
  if (domWizard?.testid) wizardLocator = `[data-testid="${escAttr(domWizard.testid)}"]`;
  else if (domWizard?.domId) wizardLocator = `#${cssEscapeId(domWizard.domId)}`;
  else if (domWizard?.ariaLabel)
    wizardLocator = `[role="tablist"][aria-label="${escAttr(domWizard.ariaLabel)}"]`;

  const spec: WizardSpec = { id, wizardLocator, name, steps };
  if (next) spec.next = next;
  if (back) spec.back = back;
  if (skip) spec.skip = skip;
  if (finish) spec.finish = finish;
  if (cancel) spec.cancel = cancel;
  return spec;
}

// ---------------------------------------------------------------------------
// parsePage entry point
// ---------------------------------------------------------------------------

const EMPTY_DOM: DomScan = {
  locatorEntries: [],
  forms: [],
  interactiveCount: 0,
  bodyText: '',
  hasOverlay: false,
  tables: [],
  toolbars: [],
  navs: [],
  modals: [],
  wizards: [],
  url: '',
  title: '',
};

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
  let yamlStr = '';
  let dom: DomScan = EMPTY_DOM;
  try {
    const [ax, domSerialized] = await Promise.all([
      page.ariaSnapshot({ mode: 'ai' }).catch(() => ''),
      page
        // The script is a string that evaluates to an IIFE returning a JSON
        // string. We pass it through `evaluate` as an expression because the
        // body references DOM globals not present in our Node-side
        // tsconfig.lib.
        .evaluate<string>(`(${domScanScript()})()`)
        .catch(() => JSON.stringify(EMPTY_DOM)),
    ]);
    yamlStr = ax;
    try {
      dom = JSON.parse(domSerialized) as DomScan;
    } catch {
      dom = EMPTY_DOM;
    }
  } catch {
    // Page closed mid-call etc. — return a minimal "broken" model.
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
      bareFields: [],
      discovered: [],
      network: signals?.network ?? [],
      console: signals?.console ?? [],
      textHash: '',
      looksBroken: true,
      interactiveCount: 0,
      capturedAt: new Date().toISOString(),
    };
  }

  const axRoots = parseAxYaml(yamlStr);
  const locators = new LocatorIndex(dom.locatorEntries);
  const route = deriveRoute(dom.url || page.url());

  // Build modals FIRST (they consume their inner forms from `dom.forms`).
  const consumedDomForms = new Set<DomFormSkeleton>();
  const consumedDomModals = new Set<DomScan['modals'][number]>();
  const modals: ModalSpec[] = [];
  for (const { node } of walkAx(axRoots)) {
    if (node.role !== 'dialog' && node.role !== 'alertdialog') continue;
    modals.push(
      buildModalFromAx(
        node,
        dom.modals,
        consumedDomModals,
        locators,
        route,
        modals.length,
        dom.hasOverlay,
        dom.forms,
        consumedDomForms,
      ),
    );
  }

  // Top-level forms. The original parser surfaced forms-inside-modals BOTH
  // on the modal AND in the top-level `forms` list (with `inModal: true`),
  // so consumers that just look at `model.forms` see the full set. We
  // preserve that behaviour by including modal forms here.
  const forms: FormSpec[] = [];
  for (const m of modals) {
    if (m.form) forms.push(m.form);
  }
  // AX-tree top-level forms (not inside any dialog).
  for (const { node, ancestors } of walkAx(axRoots)) {
    if (node.role !== 'form') continue;
    const inDialog = ancestors.some((a) => a.role === 'dialog' || a.role === 'alertdialog');
    if (inDialog) continue; // already handled via modals.
    const dom_form = matchDomForm(node.name, dom.forms, consumedDomForms, false);
    if (!dom_form) continue;
    consumedDomForms.add(dom_form);
    forms.push(buildFormFromAx(node, dom_form, locators, route, forms.length));
  }
  // DOM-only forms (unlabeled ones AX dropped) at top level.
  for (const df of dom.forms) {
    if (consumedDomForms.has(df)) continue;
    if (df.inModal) continue; // already handled by the modal builder
    consumedDomForms.add(df);
    forms.push(buildFormFromDom(df, locators, route, forms.length));
  }

  // Tables. If any built table has columnheaders but zero data rows, the most
  // common cause on Angular SPAs (Juice Shop /#/administration is the canonical
  // case) is the snapshot firing before the data-fetch+render completed. Retry
  // ONCE with a short settle wait, re-take just the AX snapshot, and rebuild
  // tables. The DOM scan stays — only AX changes once data renders.
  let consumedDomTables = new Set<DomScan['tables'][number]>();
  let tables: TableSpec[] = [];
  for (const { node } of walkAx(axRoots)) {
    if (node.role !== 'table' && node.role !== 'grid') continue;
    tables.push(
      buildTableFromAx(node, dom.tables, consumedDomTables, locators, route, tables.length),
    );
  }
  const needsTableRetry = tables.some((t) => t.columns.length > 0 && t.rowCount === 0);
  if (needsTableRetry) {
    try {
      await page.waitForLoadState('networkidle', { timeout: 1200 }).catch(() => undefined);
      await page.waitForTimeout(300);
      const retryYaml = await page.ariaSnapshot({ mode: 'ai' }).catch(() => '');
      if (retryYaml && retryYaml !== yamlStr) {
        const retryRoots = parseAxYaml(retryYaml);
        const retryConsumed = new Set<DomScan['tables'][number]>();
        const retryTables: TableSpec[] = [];
        for (const { node } of walkAx(retryRoots)) {
          if (node.role !== 'table' && node.role !== 'grid') continue;
          retryTables.push(
            buildTableFromAx(node, dom.tables, retryConsumed, locators, route, retryTables.length),
          );
        }
        // Only adopt the retry result if it actually populated rows. Otherwise
        // the table is genuinely empty (an honest "No records to show") and we
        // keep the original parse to avoid masking a real empty-state bug.
        const retryYieldsRows = retryTables.some((t) => t.rowCount > 0);
        if (retryYieldsRows) {
          tables = retryTables;
          consumedDomTables = retryConsumed;
        }
      }
    } catch {
      // Best-effort — fall back to the original empty-row tables.
    }
  }

  // Wizards.
  const consumedDomWizards = new Set<DomScan['wizards'][number]>();
  const wizards: WizardSpec[] = [];
  // Iterate tablist nodes. For the "scope" we use the tablist's parent
  // ancestor chain — from the walker we get ancestors so we can grab the
  // immediate parent for adjacent-button discovery.
  for (const { node, ancestors } of walkAx(axRoots)) {
    if (node.role !== 'tablist') continue;
    // Scope: the immediate parent (or root if none).
    const scope = ancestors.length > 0 ? [ancestors[ancestors.length - 1]] : [node];
    const filteredScope = scope.filter((s): s is AXNode => !!s);
    const wz = buildWizardFromAx(
      node,
      filteredScope,
      dom.wizards,
      consumedDomWizards,
      locators,
      route,
      wizards.length,
    );
    if (wz) wizards.push(wz);
  }

  // Toolbars.
  const toolbars: ActionRef[] = [];
  const seenToolbarLabels = new Set<string>();
  for (const { node } of walkAx(axRoots)) {
    if (node.role !== 'toolbar') continue;
    const items = collectDescendants(node, (n) => isActionRole(n.role));
    for (const it of items) {
      const a = actionFromAx(it, locators);
      const k = `${a.label}::${a.locator}`;
      if (seenToolbarLabels.has(k)) continue;
      seenToolbarLabels.add(k);
      toolbars.push(a);
      if (toolbars.length >= 30) break;
    }
    if (toolbars.length >= 30) break;
  }

  // Nav links.
  const navLinks: ActionRef[] = [];
  const seenNavLabels = new Set<string>();
  for (const { node } of walkAx(axRoots)) {
    if (node.role !== 'navigation') continue;
    const items = collectDescendants(node, (n) => isActionRole(n.role));
    for (const it of items) {
      const a = actionFromAx(it, locators);
      const k = `${a.label}::${a.locator}`;
      if (seenNavLabels.has(k)) continue;
      seenNavLabels.add(k);
      navLinks.push(a);
      if (navLinks.length >= 40) break;
    }
    if (navLinks.length >= 40) break;
  }

  // Containers that already render their interactives in their own section
  // (forms.fields, tables.rowActions, etc.) — bare* walkers skip these.
  const ownedContainerRoles = new Set([
    'form',
    'table',
    'grid',
    'tablist',
    'toolbar',
    'navigation',
    'rowgroup',
    'row',
  ]);
  // Modal/dialog ancestors — interactives inside ARE collected (so the agent
  // can see what's available behind the dismiss UI) but flagged
  // `blockedByModal: true` so the agent knows to dismiss first. Without this,
  // a stacked cookie + welcome banner on an SPA presents as "0 interactives".
  const modalContainerRoles = new Set(['dialog', 'alertdialog']);

  const bareInteractives: ActionRef[] = [];
  const seenBareLabels = new Set<string>();
  for (const { node, ancestors } of walkAx(axRoots)) {
    if (!isActionRole(node.role)) continue;
    if (ancestors.some((a) => ownedContainerRoles.has(a.role))) continue;
    const a = actionFromAx(node, locators);
    if (!a.label) continue;
    const k = `${a.label}::${a.locator}`;
    if (seenBareLabels.has(k)) continue;
    seenBareLabels.add(k);
    if (ancestors.some((anc) => modalContainerRoles.has(anc.role))) {
      a.blockedByModal = true;
    }
    bareInteractives.push(a);
    if (bareInteractives.length >= 60) break;
  }

  // Bare fields: standalone form fields outside any form/table. SPAs with
  // search bars in <mat-form-field> (Angular Material) or navbar-level inputs
  // commonly have these; they would otherwise be invisible to the agent.
  const bareFields: BareFieldRef[] = [];
  const seenBareFieldLabels = new Set<string>();
  for (const { node, ancestors } of walkAx(axRoots)) {
    if (!isFormFieldRole(node.role)) continue;
    if (ancestors.some((a) => ownedContainerRoles.has(a.role))) continue;
    const label = node.name || '';
    if (!label) continue;
    const locator = axLocator(node.role, label);
    const k = `${label}::${locator}`;
    if (seenBareFieldLabels.has(k)) continue;
    seenBareFieldLabels.add(k);
    const f: BareFieldRef = {
      locator,
      label,
      role: node.role,
    };
    if (ancestors.some((anc) => modalContainerRoles.has(anc.role))) {
      f.blockedByModal = true;
    }
    bareFields.push(f);
    if (bareFields.length >= 30) break;
  }

  // Notices — toast/snackbar text containing strong bug signals. The structured
  // PageModel otherwise discards plain text nodes; without this, OWASP Juice
  // Shop's "You successfully solved a challenge: X" popups vanish from the
  // snapshot and the agent has no cue to file. We grep the raw AX yaml for the
  // canonical toast patterns. Generic enough to catch other testbed scorers
  // without app-specific config.
  const notices: string[] = [];
  if (yamlStr) {
    const challengeRe = /successfully solved a challenge:\s*([^"\n)]+?)(?:\s*\([^)]*\))?["\n]/gi;
    const seenNotices = new Set<string>();
    challengeRe.lastIndex = 0;
    for (let m = challengeRe.exec(yamlStr); m !== null; m = challengeRe.exec(yamlStr)) {
      const name = (m[1] ?? '').trim();
      if (!name || seenNotices.has(name)) continue;
      seenNotices.add(name);
      notices.push(`successfully solved a challenge: ${name}`);
      if (notices.length >= 10) break;
    }
  }

  const model: PageModel = {
    url: dom.url || page.url(),
    route,
    title: dom.title,
    forms,
    tables,
    modals,
    wizards,
    toolbars,
    navLinks,
    bareInteractives,
    bareFields,
    discovered: [],
    network: signals?.network ?? [],
    console: signals?.console ?? [],
    textHash: computeTextHash(dom.bodyText || ''),
    looksBroken: dom.interactiveCount < 3,
    interactiveCount: dom.interactiveCount,
    capturedAt: new Date().toISOString(),
  };
  if (dom.primaryHeading) model.primaryHeading = dom.primaryHeading;
  if (notices.length > 0) model.notices = notices;
  return model;
}
