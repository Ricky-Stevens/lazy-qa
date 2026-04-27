#!/usr/bin/env tsx
import path from 'node:path';
import { writeReviewArtefacts } from '../src/findings/report.ts';
import { reviewRun } from '../src/findings/review.ts';
import { createLogger } from '../src/logging/logger.ts';

const args = process.argv.slice(2);
const runDirArg = args[0];

if (!runDirArg || runDirArg === '--help' || runDirArg === '-h') {
  process.stderr.write(`Usage: regress-review <runDir> [--model <model>] [--inline-critic]

Re-reviews a past scan: reads findings.json + journeys/*.meta.json from runDir,
calls a critic LLM to triage each finding, writes review.md and review.json
into the same dir.

Requires ANTHROPIC_API_KEY in the environment (this path uses the direct
Anthropic SDK, not the Claude Code subprocess).

  --model          Override reviewer model (default: claude-sonnet-4-6).
  --inline-critic  Force synchronous messages.create instead of Batch API
                   (default: auto-selects batch for payloads > 16 000 chars).
\n`);
  process.exit(runDirArg ? 0 : 1);
}

let model: string | undefined;
let batchMode: 'auto' | 'inline' | 'force_batch' = 'auto';
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--model') {
    const next = args[i + 1];
    if (!next) {
      process.stderr.write('--model requires a value\n');
      process.exit(1);
    }
    model = next;
    i += 1;
  } else if (a === '--inline-critic') {
    batchMode = 'inline';
  } else {
    process.stderr.write(`Unknown argument: ${a}\n`);
    process.exit(1);
  }
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey || apiKey.trim() === '') {
  process.stderr.write(
    'ANTHROPIC_API_KEY is required for the reviewer. Set it in .env (the reviewer uses the direct Anthropic SDK).\n',
  );
  process.exit(1);
}

const runDir = path.resolve(process.cwd(), runDirArg);
const logger = createLogger({ bindings: { tool: 'regress-review' } });

try {
  const review = await reviewRun({
    runDir,
    apiKey,
    model,
    batchMode,
    logger,
  });
  await writeReviewArtefacts(runDir, review);

  const reportPath = path.join(runDir, 'review.md');
  process.stdout.write(
    `\nReview complete: ${review.runId}\n` +
      `Reviewed: ${review.reviews.length} | Missing: ${review.missing.length}\n` +
      `  confirmed_bug: ${review.counts.confirmed_bug}\n` +
      `  likely_bug:    ${review.counts.likely_bug}\n` +
      `  duplicate:     ${review.counts.duplicate}\n` +
      `  environmental: ${review.counts.environmental}\n` +
      `  not_a_bug:     ${review.counts.not_a_bug}\n` +
      `Themes: ${review.clusters.length}\n` +
      `Cost (USD): ${review.reviewCostUsd.toFixed(4)}\n` +
      `\nReport: ${reportPath}\n`,
  );
  process.exit(0);
} catch (err) {
  process.stderr.write(`Review failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
