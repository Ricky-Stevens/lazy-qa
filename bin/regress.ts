#!/usr/bin/env tsx
/**
 * regress — top-level CLI.
 *
 * Defaults to the v2 architecture (Crawler + Playbooks + persona agents).
 * Pass `--legacy` to fall back to the v1 path while v2 stabilises.
 */

const args = process.argv.slice(2);
const useLegacy = args.includes('--legacy');
const positional = args.filter((a) => !a.startsWith('--'));
const configPath = positional[0];

if (!configPath || args.includes('--help') || args.includes('-h')) {
  process.stderr.write(`Usage: regress <config.yaml> [--legacy]

Run a parallel-persona QA regression scan using the provided YAML config.
See config/example.yaml for the schema.

Flags:
  --legacy   Use the v1 orchestrator (no crawler, no playbooks). Kept for one
             release while the v2 path stabilises.
`);
  process.exit(configPath ? 0 : 1);
}

const runScan = useLegacy
  ? (await import('../src/orchestrator/run.ts')).runScan
  : (await import('../src/orchestrator/run-v2.ts')).runScanV2;

export {};

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
