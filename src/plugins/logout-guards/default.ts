/**
 * Default logout guard. Ports the regex set from
 * `src/tools/browser-server.ts` (lines ~320-365). Used to suppress click
 * attempts at the tool layer — a recurring failure mode is that a broken
 * page renders ONLY a "Log out" link in the header, the agent clicks it
 * (it's the only thing on screen), and the whole shared session cascades.
 *
 * Whole-string text matching is DELIBERATE: links titled "Logout audit log"
 * or "Sign out attempts (admin)" must remain clickable.
 */

import type { LogoutGuard } from '../types.ts';

const LOGOUT_TEXT_PATTERN = /^\s*(log\s*[-_]?\s*out|sign\s*[-_]?\s*out)\s*$/i;
const LOGOUT_HREF_PATTERN = /(^|\/)(logout|signout|sign-out|log-out)(\/|\?|$)/i;
const LOGOUT_TESTID_PATTERN = /(^|[-_])(logout|signout|log-out|sign-out)([-_]|$)/i;

export const defaultLogoutGuard: LogoutGuard = {
  name: 'default',

  isLogout(meta) {
    if (meta.text && LOGOUT_TEXT_PATTERN.test(meta.text)) {
      return { matched: true, reason: `text="${meta.text.trim()}"` };
    }
    if (meta.ariaLabel && LOGOUT_TEXT_PATTERN.test(meta.ariaLabel)) {
      return { matched: true, reason: `aria-label="${meta.ariaLabel}"` };
    }
    if (meta.title && LOGOUT_TEXT_PATTERN.test(meta.title)) {
      return { matched: true, reason: `title="${meta.title}"` };
    }
    if (meta.href && LOGOUT_HREF_PATTERN.test(meta.href)) {
      return { matched: true, reason: `href="${meta.href}"` };
    }
    if (meta.testid && LOGOUT_TESTID_PATTERN.test(meta.testid)) {
      return { matched: true, reason: `data-testid="${meta.testid}"` };
    }
    return { matched: false };
  },
};
