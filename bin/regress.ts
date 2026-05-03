#!/usr/bin/env tsx
/**
 * regress — top-level CLI. Runs a parallel-persona QA regression scan.
 */

export {};

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const configPath = positional[0];

if (!configPath || args.includes('--help') || args.includes('-h')) {
  process.stderr.write(`Usage: regress <config.yaml>

Run a parallel-persona QA regression scan using the provided YAML config.
See config/example.yaml for the schema.
`);
  process.exit(configPath ? 0 : 1);
}

const { runScan } = await import('../src/orchestrator/run.ts');

// Global wall-clock backstop. If runScan hangs at any tear-down stage past
// this — SDK transport leak, leaked timer, blocked Playwright client — we
// force-exit with a non-zero code so CI / wrappers can notice. The natural
// path is process.exit(0) below, which fires as soon as runScan returns.
const GLOBAL_BACKSTOP_MS = 60 * 60 * 1000; // 1 h
const backstop = setTimeout(() => {
  process.stderr.write(
    `[regress] global backstop fired after ${GLOBAL_BACKSTOP_MS / 1000}s — forcing exit\n`,
  );
  process.exit(124);
}, GLOBAL_BACKSTOP_MS);
backstop.unref();

try {
  const result = await runScan({ configPath });
  process.stdout.write(
    `\nRun complete: ${result.runId}\nOutput dir: ${result.runDir}\nFindings: ${result.findings.length}\nTotal cost (USD): ${result.totalCostUsd.toFixed(2)}\n`,
  );
  process.exit(0);
} catch (err) {
  process.stderr.write(`Scan failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
}
