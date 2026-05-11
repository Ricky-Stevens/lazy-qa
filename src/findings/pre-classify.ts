/**
 * Deterministic pre-classification of findings.
 *
 * Runs before the LLM critic to cheaply bin findings whose classification
 * is mechanical (HTTP 500 = bug, auth-provider 400 = not a bug, etc.).
 * Findings that pass through as 'needs_review' go to the critic as normal.
 */

import type { ApplicationModel } from '../orchestrator/app-model.ts';
import { SENSITIVE_PATHS } from '../safety/paths.ts';
import type { Finding } from '../types/finding.ts';

export type PreClassification = 'confirmed_bug' | 'not_a_bug' | 'needs_review';

export function preClassifyFinding(
  finding: Finding,
  appModel?: ApplicationModel,
): { classification: PreClassification; reason: string } {
  // 1. HTTP 500+ = confirmed server error
  if (finding.httpStatus && finding.httpStatus >= 500) {
    return { classification: 'confirmed_bug', reason: `Server returned ${finding.httpStatus}` };
  }

  // 2. Console errors with "Uncaught" or "unhandled" = confirmed JS crash
  if (finding.consoleErrors?.some((e) => /uncaught|unhandled/i.test(e))) {
    return { classification: 'confirmed_bug', reason: 'Uncaught/unhandled JS exception detected' };
  }

  // 3. Sensitive path returning 200 = confirmed exposure
  if (finding.httpStatus === 200 && finding.route) {
    let routePath: string | null = null;
    try {
      routePath = new URL(finding.route, 'http://x').pathname;
    } catch {
      // Malformed route — skip sensitive-path check rather than crashing.
    }
    if (routePath && SENSITIVE_PATHS.some((p) => routePath!.endsWith(p) || routePath === p)) {
      return {
        classification: 'confirmed_bug',
        reason: `Sensitive path ${routePath} returned 200`,
      };
    }
  }

  // 4. Auth provider 400 = not a bug (belt-and-suspenders with the filing filter)
  if (finding.httpStatus === 400 && finding.route && /auth0|okta|cognito/i.test(finding.route)) {
    return { classification: 'not_a_bug', reason: 'Auth provider 400 is expected OAuth behavior' };
  }

  // 5. Error-handling category with HTTP 200 and no console errors — send to
  // the LLM critic rather than auto-dismissing. Legitimate findings like
  // "form silently swallows invalid input and shows success" are HTTP 200
  // with no console errors but are real bugs.
  // (Previously auto-classified as not_a_bug, which killed legitimate findings.)

  // 6. App model sort behavior check
  if (appModel?.sortBehavior && /server.side/i.test(appModel.sortBehavior)) {
    if (/sort.*not.*reorder|sort.*indicator.*but.*rows/i.test(finding.title)) {
      return {
        classification: 'not_a_bug',
        reason: 'Server-side sort behavior is expected per app model',
      };
    }
  }

  // 7. App model empty state check — match only findings that DESCRIBE an empty
  // state, not findings that merely mention "empty" in passing (e.g. "empty cart
  // submission lacks CSRF protection" is a real bug, not an empty-state report).
  if (appModel?.emptyStates && appModel.emptyStates.length > 0) {
    if (/^(empty state|no data|no results|no items)\b/i.test(finding.title.trim())) {
      return { classification: 'not_a_bug', reason: 'Empty state is expected per app model' };
    }
  }

  return { classification: 'needs_review', reason: '' };
}
