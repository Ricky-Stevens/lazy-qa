import { describe, expect, it } from 'vitest';
import { diffPageModels } from './diff.ts';
import type { ActionRef, PageModel } from './types.ts';

function ref(label: string, locator: string, type: ActionRef['type'] = 'button'): ActionRef {
  return { label, locator, type, disabled: false, intent: 'unknown' };
}

function model(
  overrides: Partial<PageModel> & { route?: string; textHash?: string },
): PageModel {
  return {
    url: overrides.url ?? 'https://example.com/foo',
    route: overrides.route ?? 'https://example.com/foo',
    title: overrides.title ?? 'Foo',
    forms: overrides.forms ?? [],
    tables: overrides.tables ?? [],
    modals: overrides.modals ?? [],
    wizards: overrides.wizards ?? [],
    toolbars: overrides.toolbars ?? [],
    navLinks: overrides.navLinks ?? [],
    bareInteractives: overrides.bareInteractives ?? [],
    network: overrides.network ?? [],
    console: overrides.console ?? [],
    textHash: overrides.textHash ?? 'aaaa',
    looksBroken: overrides.looksBroken ?? false,
    interactiveCount: overrides.interactiveCount ?? 10,
    capturedAt: overrides.capturedAt ?? '2026-04-26T00:00:00Z',
  };
}

describe('diffPageModels', () => {
  it('detects added bare interactives', () => {
    const a = model({ bareInteractives: [ref('Save', '#save')] });
    const b = model({
      bareInteractives: [ref('Save', '#save'), ref('Delete', '#del')],
    });
    const d = diffPageModels(a, b);
    expect(d.added.map((r) => r.label)).toEqual(['Delete']);
    expect(d.removed).toEqual([]);
    expect(d.routeChanged).toBe(false);
    expect(d.textChanged).toBe(false);
  });

  it('detects removed bare interactives', () => {
    const a = model({ bareInteractives: [ref('Save', '#save'), ref('Delete', '#del')] });
    const b = model({ bareInteractives: [ref('Save', '#save')] });
    const d = diffPageModels(a, b);
    expect(d.removed.map((r) => r.label)).toEqual(['Delete']);
    expect(d.added).toEqual([]);
  });

  it('flags route change', () => {
    const a = model({ route: 'https://example.com/a' });
    const b = model({ route: 'https://example.com/b' });
    const d = diffPageModels(a, b);
    expect(d.routeChanged).toBe(true);
  });

  it('flags text change via textHash', () => {
    const a = model({ textHash: 'aaaa' });
    const b = model({ textHash: 'bbbb' });
    const d = diffPageModels(a, b);
    expect(d.textChanged).toBe(true);
  });

  it('walks form actions when computing diff', () => {
    const submit = ref('Save', '#submit');
    const a = model({
      forms: [
        {
          id: 'form_1',
          formLocator: '#form',
          name: 'F',
          fields: [],
          submit,
          extraActions: [],
          inModal: false,
        },
      ],
    });
    const b = model({ forms: [] });
    const d = diffPageModels(a, b);
    expect(d.removed.map((r) => r.label)).toContain('Save');
  });

  it('walks modal actions when computing diff', () => {
    const primary = ref('Confirm', '#confirm');
    const a = model({
      modals: [
        {
          id: 'modal_1',
          modalLocator: '[role=dialog]',
          name: 'M',
          closers: { escapeWorks: true, clickOutsideCloses: false },
          isEditScreenLike: false,
          primaryAction: primary,
        },
      ],
    });
    const b = model({});
    const d = diffPageModels(a, b);
    expect(d.removed.some((r) => r.label === 'Confirm')).toBe(true);
  });

  it('returns empty added/removed when models are identical', () => {
    const a = model({ bareInteractives: [ref('X', '#x')] });
    const b = model({ bareInteractives: [ref('X', '#x')] });
    const d = diffPageModels(a, b);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.routeChanged).toBe(false);
    expect(d.textChanged).toBe(false);
  });
});
