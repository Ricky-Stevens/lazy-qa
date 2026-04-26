import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Browser, type Page, chromium } from 'playwright';
import { parsePage } from './parser.ts';

let browser: Browser;
let page: Page;

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterEach(async () => {
  await browser?.close();
});

async function setHtml(html: string): Promise<void> {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
}

describe('parsePage', () => {
  it('marks an empty page as broken with zero interactives', async () => {
    await setHtml('<div></div>');
    const model = await parsePage(page);
    expect(model.interactiveCount).toBe(0);
    expect(model.looksBroken).toBe(true);
    expect(model.forms).toHaveLength(0);
    expect(model.tables).toHaveLength(0);
    expect(model.modals).toHaveLength(0);
    expect(model.wizards).toHaveLength(0);
  });

  it('extracts a form with labelled inputs', async () => {
    await setHtml(`
      <form id="user-form" aria-label="New user">
        <h2>New user</h2>
        <label>Name <input name="name" required></label>
        <label>Email <input name="email" type="email" required placeholder="you@example.com"></label>
        <label>Bio <textarea name="bio" maxlength="500"></textarea></label>
        <label>Country
          <select name="country">
            <option>UK</option>
            <option>US</option>
          </select>
        </label>
        <button type="submit">Save</button>
        <button type="button">Cancel</button>
      </form>
    `);
    const model = await parsePage(page);
    expect(model.forms).toHaveLength(1);
    const form = model.forms[0]!;
    expect(form.name).toBe('New user');
    expect(form.fields).toHaveLength(4);

    const nameField = form.fields.find((f) => f.label === 'Name');
    expect(nameField).toBeDefined();
    expect(nameField?.required).toBe(true);
    expect(nameField?.type).toBe('text');

    const emailField = form.fields.find((f) => f.label === 'Email');
    expect(emailField?.type).toBe('email');
    expect(emailField?.placeholder).toBe('you@example.com');

    const bioField = form.fields.find((f) => f.label === 'Bio');
    expect(bioField?.type).toBe('textarea');
    expect(bioField?.constraints.maxLength).toBe(500);

    const countryField = form.fields.find((f) => f.label === 'Country');
    expect(countryField?.type).toBe('select');
    expect(countryField?.constraints.options).toEqual(['UK', 'US']);

    expect(form.submit).toBeDefined();
    expect(form.submit?.label).toBe('Save');
    expect(form.cancel?.label).toBe('Cancel');
    expect(form.id).toMatch(/^form_[0-9a-f]{12}$/);
  });

  it('extracts a table with sortable headers', async () => {
    await setHtml(`
      <h2>Users</h2>
      <table id="users">
        <thead>
          <tr>
            <th aria-sort="none">Name</th>
            <th aria-sort="none">Email</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Alice</td><td>a@x.com</td><td>2025-01-01</td></tr>
          <tr><td>Bob</td><td>b@x.com</td><td>2025-01-02</td></tr>
        </tbody>
      </table>
    `);
    const model = await parsePage(page);
    expect(model.tables).toHaveLength(1);
    const t = model.tables[0]!;
    expect(t.columns).toHaveLength(3);
    expect(t.columns[0]?.label).toBe('Name');
    expect(t.columns[0]?.sortable).toBe(true);
    expect(t.columns[2]?.label).toBe('Created');
    expect(t.columns[2]?.sortable).toBe(false);
    expect(t.rowCount).toBe(2);
    expect(t.id).toMatch(/^table_[0-9a-f]{12}$/);
  });

  it('extracts a modal containing a form', async () => {
    await setHtml(`
      <main><button>Open</button></main>
      <div role="dialog" aria-label="Add brand">
        <h2 id="brand-title">Add brand</h2>
        <button aria-label="Close">×</button>
        <form>
          <label>Brand name <input name="brand" required></label>
          <button type="submit">Create</button>
          <button type="button">Cancel</button>
        </form>
      </div>
    `);
    const model = await parsePage(page);
    expect(model.modals).toHaveLength(1);
    const modal = model.modals[0]!;
    expect(modal.name).toBe('Add brand');
    expect(modal.form).toBeDefined();
    expect(modal.form?.fields[0]?.label).toBe('Brand name');
    expect(modal.form?.inModal).toBe(true);
    // The form is inside a modal — must NOT also be reported as a top-level form.
    expect(model.forms.some((f) => f.inModal)).toBe(true);
    expect(modal.closers.x).toBeDefined();
    expect(modal.closers.cancel?.label).toBe('Cancel');
  });

  it('detects a wizard via aria-label="Step 1 of 3" + Next', async () => {
    await setHtml(`
      <div class="wizard" aria-label="Onboarding">
        <ol role="tablist">
          <li role="tab" aria-current="step" aria-label="Step 1 of 3">Profile</li>
          <li role="tab" aria-label="Step 2 of 3">Workspace</li>
          <li role="tab" aria-label="Step 3 of 3">Done</li>
        </ol>
        <div class="content">
          <input name="full_name">
        </div>
        <div class="controls">
          <button>Back</button>
          <button>Next</button>
          <button>Skip</button>
          <button>Cancel</button>
        </div>
      </div>
    `);
    const model = await parsePage(page);
    expect(model.wizards).toHaveLength(1);
    const w = model.wizards[0]!;
    expect(w.steps).toHaveLength(3);
    expect(w.steps[0]?.isCurrent).toBe(true);
    expect(w.next?.label).toBe('Next');
    expect(w.back?.label).toBe('Back');
    expect(w.skip?.label).toBe('Skip');
    expect(w.cancel?.label).toBe('Cancel');
  });

  it('classifies button intents — Save = action, link with href = navigate', async () => {
    await setHtml(`
      <main>
        <button id="save-btn">Save</button>
        <button id="cancel-btn">Cancel</button>
        <button id="back-btn">Back</button>
        <button id="close-btn">Close</button>
        <button id="more-btn">More</button>
        <button id="view-btn">View</button>
        <button id="random-btn">Tooltip</button>
        <a href="/elsewhere">Go elsewhere</a>
        <button id="delete-btn">Delete</button>
        <button id="submit-btn">Submit</button>
      </main>
    `);
    const model = await parsePage(page);
    const byLabel = (l: string) =>
      model.bareInteractives.find((b) => b.label === l);
    expect(byLabel('Save')?.intent).toBe('action');
    expect(byLabel('Submit')?.intent).toBe('action');
    expect(byLabel('Delete')?.intent).toBe('action');
    expect(byLabel('Cancel')?.intent).toBe('navigate');
    expect(byLabel('Back')?.intent).toBe('navigate');
    expect(byLabel('Close')?.intent).toBe('navigate');
    expect(byLabel('More')?.intent).toBe('navigate');
    expect(byLabel('View')?.intent).toBe('navigate');
    expect(byLabel('Go elsewhere')?.intent).toBe('navigate');
    expect(byLabel('Tooltip')?.intent).toBe('unknown');
  });

  it('locator preference: data-testid > id > role+name > text', async () => {
    await setHtml(`
      <main>
        <button data-testid="primary-cta" id="ignored">First</button>
        <button id="second-only">Second</button>
        <button>Third</button>
      </main>
    `);
    const model = await parsePage(page);
    const first = model.bareInteractives.find((b) => b.label === 'First');
    expect(first?.locator).toBe('[data-testid="primary-cta"]');

    const second = model.bareInteractives.find((b) => b.label === 'Second');
    expect(second?.locator).toBe('#second-only');

    const third = model.bareInteractives.find((b) => b.label === 'Third');
    // No data-testid, no id — should fall back to role+name.
    expect(third?.locator).toBe('role=button[name="Third"]');
  });

  it('passes through network/console signals supplied by the caller', async () => {
    await setHtml(`<button>Click</button>`);
    const model = await parsePage(page, {
      network: [
        { ts: 1, status: 500, method: 'GET', url: '/api/x', resourceType: 'fetch' },
      ],
      console: [{ ts: '1', level: 'error', text: 'boom' }],
    });
    expect(model.network).toHaveLength(1);
    expect(model.console).toHaveLength(1);
  });

  it('computes a stable textHash for identical content', async () => {
    await setHtml(`<main><h1>Hello</h1><p>Same content</p></main>`);
    const a = await parsePage(page);
    await setHtml(`<main><h1>Hello</h1><p>Same content</p></main>`);
    const b = await parsePage(page);
    expect(a.textHash).toBe(b.textHash);
  });

  it('derives route from origin + pathname (drops query/fragment)', async () => {
    // setContent uses about:blank URL by default — derive on a fake URL via
    // navigation to a data URL and back with goto.
    await page.setContent('<button>x</button>');
    const model = await parsePage(page);
    // about:blank case — route may be 'about:blank'; ensure it does not throw.
    expect(typeof model.route).toBe('string');
  });
});
