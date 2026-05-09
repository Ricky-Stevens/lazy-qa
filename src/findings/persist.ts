import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactFinding } from '../safety/redact.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';

export interface RunManifest {
  runId: string;
  startedAt: string;
  endedAt: string;
  targetUrl: string;
  agentIds: string[];
  totalCostUsd: number;
  totalFindings: number;
  terminationReasons: Record<string, string>;
}

export async function persistJourney(runDir: string, journey: Journey): Promise<void> {
  const journeysDir = path.join(runDir, 'journeys');
  await mkdir(journeysDir, { recursive: true });
  await writeFile(
    path.join(journeysDir, `${journey.agentId}.meta.json`),
    JSON.stringify(journey, null, 2),
    'utf8',
  );
}

export async function persistFindings(runDir: string, findings: Finding[]): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const redacted = findings.map(redactFinding);
  await writeFile(path.join(runDir, 'findings.json'), JSON.stringify(redacted, null, 2), 'utf8');
}

export async function writeRunManifest(runDir: string, manifest: RunManifest): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

export async function writeSummaryMarkdown(
  runDir: string,
  journeys: Journey[],
  findings: Finding[],
): Promise<void> {
  const sevOrder = ['critical', 'major', 'minor', 'cosmetic'] as const;
  const redacted = findings.map(redactFinding);
  const bySev: Record<string, Finding[]> = Object.fromEntries(sevOrder.map((s) => [s, []]));
  for (const f of redacted) bySev[f.severity]?.push(f);

  const lines: string[] = [];
  lines.push(`# Run summary`);
  lines.push('');
  const runId = journeys[0]?.runId ?? 'unknown';
  lines.push(`Run: ${runId}`);
  lines.push('');
  lines.push(`## Agents`);
  lines.push('');
  lines.push(`| id | turns | findings | cost (USD) | termination |`);
  lines.push(`|---|---|---|---|---|`);
  for (const j of journeys) {
    lines.push(
      `| ${j.agentId} | ${j.turns} | ${j.findings.length} | ${j.costUsd.toFixed(2)} | ${j.terminationReason ?? '?'} |`,
    );
  }
  lines.push('');
  lines.push(`## Findings (${findings.length})`);
  lines.push('');
  for (const sev of sevOrder) {
    const list = bySev[sev];
    if (!list || list.length === 0) continue;
    lines.push(`### ${sev} (${list.length})`);
    lines.push('');
    for (const f of list) {
      lines.push(`- **${f.title}** ${f.route ? `\`${f.route}\`` : ''} — ${f.description}`);
      if (f.stepsToReproduce.length) {
        lines.push(`  - Steps:`);
        for (const s of f.stepsToReproduce) lines.push(`    - ${s}`);
      }
      if (f.expected) lines.push(`  - Expected: ${f.expected}`);
      if (f.actual) lines.push(`  - Actual: ${f.actual}`);
      lines.push(
        `  - Confidence: ${f.confidence} | Source: ${f.source}${f.ruleName ? ` (${f.ruleName})` : ''}`,
      );
    }
    lines.push('');
  }
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'summary.md'), lines.join('\n'), 'utf8');
}
