#!/usr/bin/env tsx
/**
 * regress-replay — replay a run from its events.jsonl trace.
 *
 * Usage:
 *   regress-replay <runId> [--diff]
 *
 * Reads `runs/<runId>/events.jsonl`, calls replayRun, writes
 * `runs/<runId>/findings.replayed.json`.
 *
 * With --diff: deepStrictEqual against the original findings.json and
 * exits 1 on divergence.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readEvents, replayRun } from '../src/orchestrator/events.ts';

const args = process.argv.slice(2);
const runIdArg = args[0];
const diffMode = args.includes('--diff');

if (!runIdArg || runIdArg === '--help' || runIdArg === '-h') {
  process.stderr.write(`Usage: regress-replay <runId> [--diff]

Replays a past scan run from its events.jsonl trace.

  <runId>   The UUID of the run (a directory under the configured runs/ output dir).
            Resolves against runs/ relative to the current working directory.

  --diff    After writing findings.replayed.json, compare it against the
            original findings.json using deepStrictEqual (modulo timestamps).
            Exits 1 if the finding sets diverge (different IDs or content).

Outputs:
  runs/<runId>/findings.replayed.json — replayed findings array
\n`);
  process.exit(runIdArg ? 0 : 1);
}

// Resolve the run directory. Handles both:
//   - bare runId (e.g. "abc123") → resolves against ./runs/<runId>
//   - absolute path (e.g. /home/.../runs/abc123)
const runDir = path.isAbsolute(runIdArg) ? runIdArg : path.resolve(process.cwd(), 'runs', runIdArg);

const eventsPath = path.join(runDir, 'events.jsonl');
const replayedPath = path.join(runDir, 'findings.replayed.json');
const originalPath = path.join(runDir, 'findings.json');

try {
  // Read + replay.
  const events = await readEvents(eventsPath);
  if (events.length === 0) {
    process.stderr.write(`Warning: events.jsonl is empty in ${runDir}\n`);
  }

  const result = replayRun(events);

  // Write the replayed findings.
  await writeFile(replayedPath, JSON.stringify(result.findings, null, 2), 'utf8');
  process.stdout.write(
    `Replay complete: ${result.runId}\n` +
      `  Events:   ${events.length}\n` +
      `  Journeys: ${result.journeys.length}\n` +
      `  Findings: ${result.findings.length}\n` +
      `  Written:  ${replayedPath}\n`,
  );

  if (diffMode) {
    // Load the original findings.json for comparison.
    let originalFindings: unknown;
    try {
      const raw = await readFile(originalPath, 'utf8');
      originalFindings = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(
        `--diff: cannot read original findings.json: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }

    // Compare finding IDs and content. We compare by id-sorted arrays to be
    // order-independent. Timestamps (ts) may differ between live run and
    // replay so we strip them before comparison.
    type PlainFinding = Record<string, unknown>;
    const stripTs = (f: PlainFinding): PlainFinding => {
      const { ts: _ts, ...rest } = f;
      void _ts;
      return rest;
    };
    const sortById = (arr: PlainFinding[]): PlainFinding[] =>
      [...arr].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

    const replayedNorm = sortById(
      result.findings.map((f) => stripTs(f as unknown as PlainFinding)),
    );
    const originalNorm = sortById((originalFindings as PlainFinding[]).map((f) => stripTs(f)));

    try {
      assert.deepStrictEqual(replayedNorm, originalNorm);
      process.stdout.write('--diff: findings match ✓\n');
    } catch (err) {
      process.stderr.write(
        `--diff: findings DIVERGE\n${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`Replay failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
