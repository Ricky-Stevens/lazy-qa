/**
 * Setup phase — run ID generation, directory creation, symlink, event writer,
 * console tap, logger, manifest stub, run.start event, and the
 * unhandledRejection handler.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config/types.ts';
import type { Logger } from '../../logging/logger.ts';
import { createLogger } from '../../logging/logger.ts';
import { EventWriter, formatEventLine } from '../events.ts';
import { writeRunManifest } from '../../findings/persist.ts';
import type { TestPlan } from '../test-plan.ts';
import { matchEventToTestPlan } from '../test-plan.ts';

export interface SetupResult {
  runId: string;
  runDir: string;
  events: EventWriter;
  logger: Logger;
  /** Mutable ref holder for the test plan — populated after crawl,
   *  consumed by the event tap. */
  testPlanRef: { current: TestPlan | undefined };
  /** Remove the unhandledRejection listener when the run ends. */
  removeUnhandledRejectionListener: () => void;
}

export async function setupRun(
  cfg: Config,
  opts: { outputDir?: string; logger?: Logger },
): Promise<SetupResult> {
  // Run ID + output directory.
  const runId = randomUUID();
  const outputDir = opts.outputDir ?? cfg.run.output_dir;
  const runDir = path.resolve(outputDir, runId);
  await mkdir(runDir, { recursive: true });

  // Event writer — append-only JSONL for the full run trace.
  const eventsPath = path.join(runDir, 'events.jsonl');
  const events = new EventWriter(eventsPath, runId);
  await events.open();

  const wantPretty =
    process.env.LOG_FORMAT === 'pretty' ||
    (process.env.LOG_FORMAT !== 'json' && process.stdout.isTTY === true);
  if (wantPretty) {
    events.consoleTap = (e) => {
      const line = formatEventLine(e);
      if (line) process.stderr.write(`${line}\n`);
    };
  }

  // Mutable ref for test plan — populated after crawl, consumed by event tap.
  const testPlanRef: { current: TestPlan | undefined } = { current: undefined };
  const prettyTap = events.consoleTap;
  events.consoleTap = (e) => {
    prettyTap?.(e);
    if (
      testPlanRef.current &&
      'type' in e &&
      (e as { type: string }).type === 'playbook.outcome'
    ) {
      matchEventToTestPlan(
        testPlanRef.current,
        e as {
          type: string;
          agentId?: string;
          playbookName?: string;
          route?: string;
          targetId?: string;
        },
      );
    }
  };

  // Logger.
  const logger = opts.logger ?? createLogger({ runId });

  // unhandledRejection handler.
  const onUnhandledRejection = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/EBADF|bad file descriptor/i.test(msg)) {
      logger.warn('run.ebadf.swallowed', { error: msg });
      return;
    }
    if (/cannot be parsed as a URL/i.test(msg)) {
      logger.debug('run.url-parse.swallowed', { error: msg });
      return;
    }
    logger.error('run.unhandledRejection', { error: msg });
  };
  process.on('unhandledRejection', onUnhandledRejection);

  // Best-effort `last` symlink.
  try {
    const lastLink = path.resolve(outputDir, 'last');
    await unlink(lastLink).catch(() => undefined);
    await symlink(runId, lastLink);
  } catch {
    // Some filesystems don't support symlinks — silently degrade.
  }

  // Early pre-run manifest stub.
  await writeRunManifest(runDir, {
    runId,
    startedAt: new Date().toISOString(),
    endedAt: '',
    targetUrl: cfg.target.url,
    agentIds: [],
    totalCostUsd: 0,
    totalFindings: 0,
    terminationReasons: {},
  });

  logger.info('run.start', {
    runId,
    runDir,
    targetUrl: cfg.target.url,
    agentCount: 'pending',
    version: 'v2',
  });

  await events.write({
    type: 'run.start',
    targetUrl: cfg.target.url,
    agentIds: ['pending'],
  });

  return {
    runId,
    runDir,
    events,
    logger,
    testPlanRef,
    removeUnhandledRejectionListener: () => {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    },
  };
}
