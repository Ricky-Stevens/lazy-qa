/**
 * Tests for the affordance probe. Uses Playwright `setContent` to build
 * small fixtures: a page with toolbar buttons that open modals/menus, a
 * table with a row kebab, and a destructive button that should be SKIPPED.
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRef, PageModel, TableSpec } from '../page-model/types.ts';
import { probeAffordances } from './affordance-probe.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

function blankModel(extra: Partial<PageModel> = {}): PageModel {
  return {
    url: 'about:blank',
    route: 'about:blank',
    title: 'Test',
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareFields: [],
    bareInteractives: [],
    discovered: [],
    network: [],
    console: [],
    textHash: '',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

function actionRef(
  label: string,
  locator: string,
  intent: ActionRef['intent'] = 'action',
): ActionRef {
  return { label, locator, type: 'button', disabled: false, intent };
}

function tableSpec(rowActions: ActionRef[]): TableSpec {
  return {
    id: 'test-table',
    tableLocator: 'table',
    name: 'Test',
    columns: [],
    rowCount: 1,
    rowActions,
    bulkActions: [],
    filters: [],
  };
}

describe('probeAffordances', () => {
  it('classifies a button that opens a modal as kind: "modal"', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <div role="toolbar">
            <button id="add" type="button">Add Client</button>
          </div>
          <div id="dlg" role="dialog" aria-label="New Client" style="display:none">
            <h2>New Client</h2>
            <form><input name="x" /></form>
            <button aria-label="Close" id="closex">Close</button>
          </div>
          <script>
            document.getElementById('add').addEventListener('click', () => {
              document.getElementById('dlg').style.display = 'block';
            });
            document.getElementById('closex').addEventListener('click', () => {
              document.getElementById('dlg').style.display = 'none';
            });
          </script>
        </body></html>
      `);
      const model = blankModel({
        toolbars: [actionRef('Add Client', '#add')],
      });
      const result = await probeAffordances(page, model);
      expect(result).toHaveLength(1);
      expect(result[0]?.outcome.kind).toBe('modal');
      if (result[0]?.outcome.kind === 'modal') {
        expect(result[0].outcome.modalName).toContain('New Client');
        expect(result[0].outcome.hasForm).toBe(true);
      }
    } finally {
      await page.close();
    }
  });

  it('classifies a kebab as kind: "menu" with item labels', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <table>
            <tr>
              <td>Row 1</td>
              <td>
                <button id="kebab" aria-label="More options">⋮</button>
                <ul id="menu" role="menu" style="display:none">
                  <li role="menuitem">Edit</li>
                  <li role="menuitem">Disable</li>
                  <li role="menuitem">Duplicate</li>
                </ul>
              </td>
            </tr>
          </table>
          <script>
            document.getElementById('kebab').addEventListener('click', () => {
              const m = document.getElementById('menu');
              m.style.display = m.style.display === 'block' ? 'none' : 'block';
            });
          </script>
        </body></html>
      `);
      const model = blankModel({
        tables: [tableSpec([actionRef('⋮', '#kebab')])],
      });
      const result = await probeAffordances(page, model);
      expect(result).toHaveLength(1);
      expect(result[0]?.outcome.kind).toBe('menu');
      if (result[0]?.outcome.kind === 'menu') {
        expect(result[0].outcome.items).toEqual(
          expect.arrayContaining(['Edit', 'Disable', 'Duplicate']),
        );
      }
    } finally {
      await page.close();
    }
  });

  it('skips destructive labels (Delete/Save/Logout) without clicking them', async () => {
    const page = await browser.newPage();
    try {
      let deleteClicks = 0;
      await page.exposeFunction('onDeleteClick', () => {
        deleteClicks += 1;
      });
      await page.setContent(`
        <html><body>
          <div role="toolbar">
            <button id="del" type="button">Delete All</button>
            <button id="save" type="button">Save Changes</button>
            <button id="logout" type="button">Sign Out</button>
            <button id="add" type="button">Add Item</button>
          </div>
          <div id="ack" style="display:none">added</div>
          <script>
            document.getElementById('del').addEventListener('click', () => onDeleteClick());
            document.getElementById('add').addEventListener('click', () => {
              const a = document.getElementById('ack');
              a.setAttribute('role','alert');
              a.style.display = 'block';
              a.textContent = 'Item added';
            });
          </script>
        </body></html>
      `);
      const model = blankModel({
        toolbars: [
          actionRef('Delete All', '#del'),
          actionRef('Save Changes', '#save'),
          actionRef('Sign Out', '#logout'),
          actionRef('Add Item', '#add'),
        ],
      });
      const result = await probeAffordances(page, model);
      expect(deleteClicks).toBe(0);
      // Only "Add Item" should have been probed.
      expect(result).toHaveLength(1);
      expect(result[0]?.trigger.label).toBe('Add Item');
    } finally {
      await page.close();
    }
  });

  it('classifies a button that navigates as kind: "navigation"', async () => {
    const page = await browser.newPage();
    try {
      // pushState fails on about:blank (cross-origin guard), so use a hash
      // change which works from any origin.
      await page.setContent(`
        <html><body>
          <div role="toolbar">
            <button id="open" type="button">Open Details</button>
          </div>
          <script>
            document.getElementById('open').addEventListener('click', () => {
              location.hash = '#details';
            });
          </script>
        </body></html>
      `);
      const model = blankModel({ toolbars: [actionRef('Open Details', '#open')] });
      const result = await probeAffordances(page, model);
      expect(result).toHaveLength(1);
      expect(result[0]?.outcome.kind).toBe('navigation');
    } finally {
      await page.close();
    }
  });

  it('classifies a button with no observable change as kind: "inert"', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <div role="toolbar">
            <button id="noop" type="button">More Options</button>
          </div>
        </body></html>
      `);
      const model = blankModel({ toolbars: [actionRef('More Options', '#noop')] });
      const result = await probeAffordances(page, model);
      expect(result).toHaveLength(1);
      expect(result[0]?.outcome.kind).toBe('inert');
    } finally {
      await page.close();
    }
  });

  it('skips newly-blocked destructive labels (Promote/Suspend/Resend/Refund)', async () => {
    const page = await browser.newPage();
    try {
      let firedCount = 0;
      await page.exposeFunction('onForbiddenClick', () => {
        firedCount += 1;
      });
      await page.setContent(`
        <html><body>
          <div role="toolbar">
            <button id="promote" type="button">Promote to Admin</button>
            <button id="suspend" type="button">Suspend Account</button>
            <button id="resend" type="button">Resend Invite</button>
            <button id="refund" type="button">Refund Payment</button>
            <button id="run" type="button">Run Job</button>
            <button id="invite" type="button">Invite User</button>
          </div>
          <script>
            for (const id of ['promote','suspend','resend','refund','run','invite']) {
              document.getElementById(id).addEventListener('click', () => onForbiddenClick());
            }
          </script>
        </body></html>
      `);
      const model = blankModel({
        toolbars: [
          actionRef('Promote to Admin', '#promote'),
          actionRef('Suspend Account', '#suspend'),
          actionRef('Resend Invite', '#resend'),
          actionRef('Refund Payment', '#refund'),
          actionRef('Run Job', '#run'),
          actionRef('Invite User', '#invite'),
        ],
      });
      await probeAffordances(page, model);
      expect(firedCount).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('only probes kebab-shaped row triggers (icon-only Resend buttons skipped)', async () => {
    const page = await browser.newPage();
    try {
      let resendClicks = 0;
      await page.exposeFunction('onResendClick', () => {
        resendClicks += 1;
      });
      await page.setContent(`
        <html><body>
          <table>
            <tr>
              <td>row 1</td>
              <td><button id="resend1" aria-label="Resend invite">↻</button></td>
            </tr>
          </table>
        </body></html>
      `);
      const model = blankModel({
        tables: [tableSpec([actionRef('↻', '#resend1')])],
      });
      const result = await probeAffordances(page, model);
      expect(resendClicks).toBe(0);
      // Glyph "↻" is not a kebab, so the row-action picker should reject it.
      expect(result).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it('respects the totalBudgetMs cap', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <html><body>
          <div role="toolbar">
            <button id="b1" type="button">Add One</button>
            <button id="b2" type="button">Add Two</button>
            <button id="b3" type="button">Add Three</button>
          </div>
        </body></html>
      `);
      const model = blankModel({
        toolbars: [
          actionRef('Add One', '#b1'),
          actionRef('Add Two', '#b2'),
          actionRef('Add Three', '#b3'),
        ],
      });
      // Tiny budget — should bail before completing all 3.
      const result = await probeAffordances(page, model, { totalBudgetMs: 50 });
      expect(result.length).toBeLessThan(3);
    } finally {
      await page.close();
    }
  });
});
