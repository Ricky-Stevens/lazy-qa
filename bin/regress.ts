#!/usr/bin/env tsx
/**
 * regress — top-level CLI. Runs a parallel-persona QA regression scan.
 */

export {};

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const configPath = positional[0];
const isDryRun = flags.includes('--dry-run');

if (!configPath || args.includes('--help') || args.includes('-h')) {
  process.stderr.write(`Usage: regress <config.yaml> [--dry-run]

Run a parallel-persona QA regression scan using the provided YAML config.
See config/example.yaml for the schema.

Options:
  --dry-run   Crawl and estimate cost without spawning agents
  --help      Show this help message
`);
  process.exit(configPath ? 0 : 1);
}

if (isDryRun) {
  const { dryRun } = await import('../src/orchestrator/dry-run.ts');
  try {
    const result = await dryRun(configPath);
    process.stdout.write('\n══════════════════════════════════════════════════\n');
    process.stdout.write('  DRY RUN SUMMARY\n');
    process.stdout.write('══════════════════════════════════════════════════\n\n');
    process.stdout.write(`Target:       ${result.targetUrl}\n`);
    process.stdout.write(`Site shape:   ${result.siteShape}\n`);
    process.stdout.write(`Routes found: ${result.routeCount}\n`);
    process.stdout.write(`Test items:   ${result.testPlanItems}\n`);
    process.stdout.write(`Agents:       ${result.agents.length}\n\n`);
    process.stdout.write('── Agents ────────────────────────────────────────\n');
    for (const a of result.agents) {
      process.stdout.write(`  ${a.id.padEnd(24)} ${a.profile.padEnd(20)} ${a.model.padEnd(30)} $${a.budgetUsd.toFixed(2)} max\n`);
    }
    process.stdout.write('\n── Cost Estimate ─────────────────────────────────\n');
    process.stdout.write(`  Low:  $${result.estimatedCostUsd.low.toFixed(2)}\n`);
    process.stdout.write(`  Mid:  $${result.estimatedCostUsd.mid.toFixed(2)}\n`);
    process.stdout.write(`  High: $${result.estimatedCostUsd.high.toFixed(2)}\n\n`);
    process.stdout.write(`Site summary:\n${result.siteSummary}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Dry run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
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
