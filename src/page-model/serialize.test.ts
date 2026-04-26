import { describe, expect, it } from 'vitest';
import { serializeForAgent } from './serialize.ts';
import type {
  ActionRef,
  FormSpec,
  ModalSpec,
  PageModel,
  TableSpec,
  WizardSpec,
} from './types.ts';

function ref(label: string, locator: string): ActionRef {
  return { label, locator, type: 'button', disabled: false, intent: 'unknown' };
}

function makeForm(idx: number, fieldCount: number): FormSpec {
  return {
    id: `form_${String(idx).padStart(12, '0')}`,
    formLocator: `#form-${idx}`,
    name: `Form ${idx}`,
    fields: Array.from({ length: fieldCount }, (_, i) => ({
      locator: `#form-${idx}-field-${i}`,
      label: `field-${idx}-${i}`,
      type: 'text',
      required: i === 0,
      constraints: {},
    })),
    submit: ref('Save', `#form-${idx}-save`),
    cancel: ref('Cancel', `#form-${idx}-cancel`),
    extraActions: [],
    inModal: false,
  };
}

function makeTable(idx: number, cols: number): TableSpec {
  return {
    id: `table_${String(idx).padStart(12, '0')}`,
    tableLocator: `#table-${idx}`,
    name: `Table ${idx}`,
    columns: Array.from({ length: cols }, (_, i) => ({
      label: `col-${i}`,
      headerLocator: `#table-${idx}-col-${i}`,
      sortable: true,
    })),
    rowCount: 25,
    rowActions: [ref('Edit', '#row-edit'), ref('Delete', '#row-del')],
    bulkActions: [],
    filters: [],
  };
}

function makeModal(idx: number): ModalSpec {
  return {
    id: `modal_${idx}`,
    modalLocator: `[data-testid="modal-${idx}"]`,
    name: `Modal ${idx}`,
    closers: { escapeWorks: true, clickOutsideCloses: true },
    isEditScreenLike: false,
  };
}

function makeWizard(idx: number): WizardSpec {
  return {
    id: `wizard_${idx}`,
    wizardLocator: `[data-testid="wizard-${idx}"]`,
    name: `Wizard ${idx}`,
    steps: [
      { label: 'One', index: 0, isCurrent: true },
      { label: 'Two', index: 1, isCurrent: false },
    ],
    next: ref('Next', '#next'),
  };
}

function makePageModel(overrides: Partial<PageModel> = {}): PageModel {
  return {
    url: 'https://example.com/foo',
    route: 'https://example.com/foo',
    title: 'Test page',
    primaryHeading: 'Heading',
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network: [],
    console: [],
    textHash: 'abc123',
    looksBroken: false,
    interactiveCount: 50,
    capturedAt: '2026-04-26T00:00:00Z',
    ...overrides,
  };
}

describe('serializeForAgent', () => {
  it('produces a compact representation under 1.5KB on a small model', () => {
    const model = makePageModel({
      forms: [makeForm(1, 3)],
      tables: [makeTable(1, 3)],
      bareInteractives: [ref('Edit', '#e'), ref('Delete', '#d')],
    });
    const out = serializeForAgent(model);
    expect(out.length).toBeLessThan(1500);
    expect(out).toContain('URL: https://example.com/foo');
    expect(out).toContain('Form 1');
    expect(out).toContain('Table 1');
  });

  it('clamps output to <= 4096 chars on a model with 18 forms / 9 tables', () => {
    const forms = Array.from({ length: 18 }, (_, i) => makeForm(i, 6));
    const tables = Array.from({ length: 9 }, (_, i) => makeTable(i, 5));
    const model = makePageModel({ forms, tables });
    const out = serializeForAgent(model);
    expect(out.length).toBeLessThanOrEqual(4096);
    // Truncation footer should be present.
    expect(out).toMatch(/truncated|more\)/);
    // Header still present.
    expect(out).toContain('URL: https://example.com/foo');
  });

  it('includes signal section when network/console anomalies present', () => {
    const model = makePageModel({
      bareInteractives: [ref('Click', '#x')],
      network: [
        { ts: 1, status: 500, method: 'GET', url: '/api/x', resourceType: 'fetch' },
      ],
      console: [{ ts: '1', level: 'error', text: 'Uncaught error' }],
    });
    const out = serializeForAgent(model);
    expect(out).toContain('since last action');
    expect(out).toContain('500 GET /api/x');
    expect(out).toContain('Uncaught error');
  });

  it('omits the signals section when there are no anomalies', () => {
    const model = makePageModel({ bareInteractives: [ref('X', '#x')] });
    const out = serializeForAgent(model);
    expect(out).not.toContain('since last action');
  });

  it('renders modals and wizards with control summaries', () => {
    const model = makePageModel({
      modals: [makeModal(1)],
      wizards: [makeWizard(1)],
    });
    const out = serializeForAgent(model);
    expect(out).toContain('Modal 1');
    expect(out).toContain('Wizard 1');
    expect(out).toContain('step 1/2');
    expect(out).toContain('next:#next');
  });
});
