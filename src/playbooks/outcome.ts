/**
 * PlaybookOutcome — uniform structured result returned by every playbook.
 * The outcome contains a human-readable summary (returned to the LLM as the
 * tool result), structured evidence, signals captured during the playbook,
 * and a sub-step trace for debugging.
 */

import type { ConsoleEntry, NetworkAnomaly } from '../page-model/types.ts';

export interface PlaybookStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface PlaybookOutcome {
  playbookName: string;
  status: 'ok' | 'failed' | 'suspicious';
  /** Concise human-readable summary, returned to the agent as the tool result. */
  summary: string;
  /** Structured evidence. Whatever the playbook gathered that another tool
   * (or a reviewer) might use. Free-form. */
  evidence: Record<string, unknown>;
  /** Console errors and network anomalies captured during the playbook's run. */
  signals: {
    networkAnomalies: NetworkAnomaly[];
    consoleErrors: ConsoleEntry[];
    visualMismatch?: boolean;
  };
  /** Sub-step trace. Useful when a playbook fails halfway. */
  steps: PlaybookStep[];
  durationMs: number;
  /** If the playbook captured a screenshot, the path relative to runDir. */
  screenshotPath?: string;
}

/** Convenience constructor for an OK outcome. */
export function ok(
  playbookName: string,
  summary: string,
  evidence: Record<string, unknown> = {},
  steps: PlaybookStep[] = [],
): PlaybookOutcome {
  return {
    playbookName,
    status: 'ok',
    summary,
    evidence,
    signals: { networkAnomalies: [], consoleErrors: [] },
    steps,
    durationMs: 0,
  };
}

/** Convenience constructor for a failed outcome. */
export function fail(
  playbookName: string,
  summary: string,
  evidence: Record<string, unknown> = {},
  steps: PlaybookStep[] = [],
): PlaybookOutcome {
  return {
    playbookName,
    status: 'failed',
    summary,
    evidence,
    signals: { networkAnomalies: [], consoleErrors: [] },
    steps,
    durationMs: 0,
  };
}

/** Convenience constructor for a suspicious outcome (probable bug evidence). */
export function suspicious(
  playbookName: string,
  summary: string,
  evidence: Record<string, unknown>,
  steps: PlaybookStep[] = [],
): PlaybookOutcome {
  return {
    playbookName,
    status: 'suspicious',
    summary,
    evidence,
    signals: { networkAnomalies: [], consoleErrors: [] },
    steps,
    durationMs: 0,
  };
}
