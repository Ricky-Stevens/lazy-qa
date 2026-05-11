import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { persistFindings, writeRunManifest, writeSummaryMarkdown } from './persist.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    ts: new Date().toISOString(),
    severity: 'major',
    category: 'broken-feature',
    title: 'Test finding with sk-live_1234567890abcdef',
    description: 'A test with JWT eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.abc123',
    stepsToReproduce: ['Step 1'],
    expected: 'Expected',
    actual: 'Actual',
    confidence: 'likely',
    source: 'agent',
    ...overrides,
  };
}

let tmpDir: string;

describe('persist', () => {
  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('persists findings with redaction applied', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'persist-test-'));
    const findings = [makeFinding()];
    await persistFindings(tmpDir, findings);

    const raw = readFileSync(path.join(tmpDir, 'findings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    // Secrets should be redacted
    expect(parsed[0].title).not.toContain('sk-live_1234567890abcdef');
    expect(parsed[0].description).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('uses atomic write (no .tmp files left behind)', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'persist-test-'));
    await persistFindings(tmpDir, [makeFinding()]);

    const files = readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('writes manifest atomically', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'persist-test-'));
    await writeRunManifest(tmpDir, {
      runId: 'test-run',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      targetUrl: 'http://localhost:3000',
      agentIds: ['agent-1'],
      totalCostUsd: 1.23,
      totalFindings: 1,
      terminationReasons: { 'agent-1': 'max-turns' },
    });

    const raw = readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.runId).toBe('test-run');
    expect(parsed.totalCostUsd).toBe(1.23);
  });

  it('writes summary markdown with severity ordering', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'persist-test-'));
    const journey: Journey = {
      runId: 'test-run',
      agentId: 'agent-1',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      startUrl: 'http://localhost:3000',
      turns: 10,
      findings: [makeFinding()],
      tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.05,
      terminationReason: 'max-turns',
    };
    await writeSummaryMarkdown(tmpDir, [journey], [makeFinding()]);

    const md = readFileSync(path.join(tmpDir, 'summary.md'), 'utf8');
    expect(md).toContain('# Run summary');
    expect(md).toContain('agent-1');
    expect(md).toContain('major');
  });
});
