/**
 * Responsive playbook — `responsive_check`. Tests the current page at mobile
 * (375x812) and tablet (768x1024) viewports. Compares page models to detect
 * forms, tables, or navigation that disappear without a mobile-friendly
 * replacement (e.g. hamburger menu).
 */

import { z } from 'zod';
import type { PageModel } from '../page-model/types.ts';
import type { Playbook, PlaybookContext } from './framework.ts';
import { ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const TABLET_VIEWPORT = { width: 768, height: 1024 };
const REFLOW_WAIT_MS = 500;

export const responsiveCheckShape = {
  route: z.string(),
} satisfies z.ZodRawShape;

export interface ResponsiveCheckInput {
  route: string;
}

interface ViewportSnapshot {
  viewport: string;
  formCount: number;
  tableCount: number;
  navLinkCount: number;
  toolbarCount: number;
  bareInteractiveCount: number;
}

function snapshotModel(model: PageModel, viewportLabel: string): ViewportSnapshot {
  return {
    viewport: viewportLabel,
    formCount: model.forms.length,
    tableCount: model.tables.length,
    navLinkCount: model.navLinks.length,
    toolbarCount: model.toolbars.length,
    bareInteractiveCount: model.bareInteractives.length,
  };
}

/** Check if the page has a hamburger / mobile menu toggle that could
 *  explain missing nav links. */
async function hasMobileMenuToggle(ctx: PlaybookContext): Promise<boolean> {
  const selectors = [
    '[aria-label*="menu" i]',
    '[aria-label*="hamburger" i]',
    '[aria-label*="navigation" i]',
    'button.navbar-toggler',
    'button.menu-toggle',
    '[data-toggle="collapse"]',
    '.hamburger',
    '[class*="hamburger" i]',
    '[class*="menu-toggle" i]',
    '[class*="nav-toggle" i]',
  ];
  for (const sel of selectors) {
    const count = await ctx.page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

export const responsiveCheck: Playbook<ResponsiveCheckInput> = {
  name: 'responsive_check',
  description:
    'Tests the page at mobile (375x812) and tablet (768x1024) viewports. ' +
    'Compares page models to detect forms, tables, or navigation that vanish ' +
    'without a mobile-friendly replacement. Input: `route` (URL to test).',
  categories: ['responsive'],
  estimatedDurationMs: 10_000,
  inputShape: responsiveCheckShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { route: input.route };
    const issues: string[] = [];

    // Navigate to the route
    try {
      await ctx.page.goto(input.route, { waitUntil: 'load', timeout: 15_000 });
      steps.push({ label: 'navigated to route', ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        playbookName: responsiveCheck.name,
        status: 'failed',
        summary: `Failed to navigate to ${input.route}: ${message}`,
        evidence,
        signals: { networkAnomalies: [], consoleErrors: [] },
        steps: [{ label: 'navigation failed', ok: false, detail: message }],
        durationMs: 0,
      };
    }

    // Capture desktop snapshot
    const originalViewport = ctx.page.viewportSize();
    const desktopModel = await ctx.pageModel();
    const desktopSnap = snapshotModel(desktopModel, 'desktop');
    evidence.desktop = desktopSnap;
    steps.push({
      label: `desktop: ${desktopSnap.formCount} forms, ${desktopSnap.tableCount} tables, ${desktopSnap.navLinkCount} nav links`,
      ok: true,
    });

    // Test mobile viewport — wrapped in try/finally to guarantee viewport
    // restoration even if pageModel() or evaluate() throws.
    let mobileSnap: ReturnType<typeof snapshotModel> | undefined;
    await ctx.page.setViewportSize(MOBILE_VIEWPORT);
    try {
      await ctx.page.waitForTimeout(REFLOW_WAIT_MS);
      const mobileModel = await ctx.pageModel();
      mobileSnap = snapshotModel(mobileModel, 'mobile');
      evidence.mobile = mobileSnap;

      // Check for disappeared elements at mobile
      if (desktopSnap.formCount > 0 && mobileSnap.formCount === 0) {
        issues.push(`All ${desktopSnap.formCount} form(s) disappeared at mobile viewport`);
        steps.push({
          label: `mobile: forms disappeared (${desktopSnap.formCount} -> 0)`,
          ok: false,
        });
      } else {
        steps.push({
          label: `mobile: ${mobileSnap.formCount} form(s) present`,
          ok: true,
        });
      }

      if (desktopSnap.tableCount > 0 && mobileSnap.tableCount === 0) {
        issues.push(`All ${desktopSnap.tableCount} table(s) disappeared at mobile viewport`);
        steps.push({
          label: `mobile: tables disappeared (${desktopSnap.tableCount} -> 0)`,
          ok: false,
        });
      } else {
        steps.push({
          label: `mobile: ${mobileSnap.tableCount} table(s) present`,
          ok: true,
        });
      }

      // Nav links: allow disappearance if a hamburger menu toggle exists
      if (desktopSnap.navLinkCount > 0 && mobileSnap.navLinkCount === 0) {
        const hasHamburger = await hasMobileMenuToggle(ctx);
        if (hasHamburger) {
          steps.push({
            label: 'mobile: nav links hidden behind mobile menu toggle (OK)',
            ok: true,
          });
        } else {
          issues.push(
            `All ${desktopSnap.navLinkCount} nav link(s) disappeared at mobile with no hamburger menu`,
          );
          steps.push({
            label: `mobile: nav links vanished without menu toggle (${desktopSnap.navLinkCount} -> 0)`,
            ok: false,
          });
        }
      } else {
        steps.push({
          label: `mobile: ${mobileSnap.navLinkCount} nav link(s) present`,
          ok: true,
        });
      }

      // Check for horizontal overflow at mobile
      const hasOverflow = await ctx.page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      if (hasOverflow) {
        issues.push('Page content overflows viewport width at mobile');
        steps.push({ label: 'mobile: horizontal overflow detected', ok: false });
      } else {
        steps.push({ label: 'mobile: no horizontal overflow', ok: true });
      }
    } finally {
      // Restore original viewport before tablet test
      if (originalViewport) {
        await ctx.page.setViewportSize(originalViewport);
      } else {
        await ctx.page.setViewportSize({ width: 1280, height: 720 });
      }
    }

    // Test tablet viewport
    let tabletSnap: ReturnType<typeof snapshotModel> | undefined;
    await ctx.page.setViewportSize(TABLET_VIEWPORT);
    try {
      await ctx.page.waitForTimeout(REFLOW_WAIT_MS);
      const tabletModel = await ctx.pageModel();
      tabletSnap = snapshotModel(tabletModel, 'tablet');
      evidence.tablet = tabletSnap;

      if (desktopSnap.formCount > 0 && tabletSnap.formCount === 0) {
        issues.push(`All ${desktopSnap.formCount} form(s) disappeared at tablet viewport`);
        steps.push({
          label: `tablet: forms disappeared (${desktopSnap.formCount} -> 0)`,
          ok: false,
        });
      } else {
        steps.push({
          label: `tablet: ${tabletSnap.formCount} form(s) present`,
          ok: true,
        });
      }

      if (desktopSnap.tableCount > 0 && tabletSnap.tableCount === 0) {
        issues.push(`All ${desktopSnap.tableCount} table(s) disappeared at tablet viewport`);
        steps.push({
          label: `tablet: tables disappeared (${desktopSnap.tableCount} -> 0)`,
          ok: false,
        });
      } else {
        steps.push({
          label: `tablet: ${tabletSnap.tableCount} table(s) present`,
          ok: true,
        });
      }

      // Check for horizontal overflow at tablet
      const tabletOverflow = await ctx.page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      if (tabletOverflow) {
        issues.push('Page content overflows viewport width at tablet');
        steps.push({ label: 'tablet: horizontal overflow detected', ok: false });
      } else {
        steps.push({ label: 'tablet: no horizontal overflow', ok: true });
      }
    } finally {
      // Restore original viewport
      if (originalViewport) {
        await ctx.page.setViewportSize(originalViewport);
      } else {
        await ctx.page.setViewportSize({ width: 1280, height: 720 });
      }
    }

    evidence.issues = issues;
    if (mobileSnap) {
      evidence.mobileElementCount =
        mobileSnap.formCount +
        mobileSnap.tableCount +
        mobileSnap.navLinkCount +
        mobileSnap.toolbarCount +
        mobileSnap.bareInteractiveCount;
    }
    if (tabletSnap) {
      evidence.tabletElementCount =
        tabletSnap.formCount +
        tabletSnap.tableCount +
        tabletSnap.navLinkCount +
        tabletSnap.toolbarCount +
        tabletSnap.bareInteractiveCount;
    }
    evidence.desktopElementCount =
      desktopSnap.formCount +
      desktopSnap.tableCount +
      desktopSnap.navLinkCount +
      desktopSnap.toolbarCount +
      desktopSnap.bareInteractiveCount;

    if (issues.length > 0) {
      return suspicious(
        responsiveCheck.name,
        `${issues.length} responsive issue(s) at mobile/tablet viewport: ${issues.join('; ')}`,
        evidence,
        steps,
      );
    }

    return ok(
      responsiveCheck.name,
      `Page structure preserved at mobile and tablet viewports on ${input.route}`,
      evidence,
      steps,
    );
  },
};
