import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '../types/finding.ts';
import type { ReviewItem, ReviewResult } from './review.ts';
import { renderReviewMarkdown, writeReviewArtefacts } from './report.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    ts: new Date().toISOString(),
    severity: 'major',
    category: 'broken-feature',
    title: 'Save button does nothing',
    description: 'Clicking Save does not persist.',
    stepsToReproduce: ['Open /admin', 'Click Save'],
    expected: 'Record saved',
    actual: 'Nothing happens',
    route: '/admin',
    confidence: 'likely',
    source: 'agent',
    ...overrides,
  };
}

function makeReviewItem(
  finding: Finding,
  overrides: Partial<ReviewItem> = {},
): { finding: Finding; review: ReviewItem } {
  return {
    finding,
    review: {
      id: finding.id,
      classification: 'confirmed_bug',
      reasoning: 'Clear evidence.',
      ...overrides,
    },
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  const f1 = makeFinding({ id: 'f-1', severity: 'critical', title: 'Critical bug' });
  const f2 = makeFinding({
    id: 'f-2',
    severity: 'minor',
    title: 'Minor cosmetic issue',
    category: 'ux-confusion',
  });
  return {
    runId: 'test-run',
    model: 'claude-sonnet-4-6',
    reviewedAt: new Date().toISOString(),
    reviewCostUsd: 0.05,
    reviewTokenUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    reviews: [
      makeReviewItem(f1, { classification: 'confirmed_bug' }),
      makeReviewItem(f2, { classification: 'not_a_bug', reasoning: 'Works as designed.' }),
    ],
    clusters: [
      {
        label: 'Theme 1',
        note: 'All in /admin',
        findingIds: ['f-1'],
      },
    ],
    counts: {
      confirmed_bug: 1,
      likely_bug: 0,
      duplicate: 0,
      environmental: 0,
      not_a_bug: 1,
    },
    overallNotes: 'The app has some real issues.',
    verifyCostUsd: 0,
    missing: [],
    ...overrides,
  };
}

describe('renderReviewMarkdown', () => {
  it('renders a markdown string with title and sections', () => {
    const md = renderReviewMarkdown(makeReviewResult());
    expect(md).toContain('# Review — test-run');
    expect(md).toContain('## Triage summary');
    expect(md).toContain('confirmed bug');
    expect(md).toContain('not a bug');
  });

  it('includes overall notes', () => {
    const md = renderReviewMarkdown(
      makeReviewResult({ overallNotes: 'The app needs work.' }),
    );
    expect(md).toContain('## Overall');
    expect(md).toContain('The app needs work.');
  });

  it('renders findings grouped by classification', () => {
    const md = renderReviewMarkdown(makeReviewResult());
    expect(md).toContain('## confirmed bug (1)');
    expect(md).toContain('## not a bug (1)');
    expect(md).toContain('Critical bug');
    expect(md).toContain('Minor cosmetic issue');
  });

  it('renders clusters / themes', () => {
    const md = renderReviewMarkdown(makeReviewResult());
    expect(md).toContain('## Themes (1)');
    expect(md).toContain('Theme 1');
    expect(md).toContain('All in /admin');
  });

  it('renders severity adjustments when reviewer suggests different severity', () => {
    const f = makeFinding({ id: 'f-adj', severity: 'minor', title: 'Adjusted finding' });
    const result = makeReviewResult({
      reviews: [
        makeReviewItem(f, { suggestedSeverity: 'major', reasoning: 'Impact is higher' }),
      ],
    });
    const md = renderReviewMarkdown(result);
    expect(md).toContain('## Severity adjustments');
    expect(md).toContain('minor');
    expect(md).toContain('**major**');
  });

  it('renders missing findings section', () => {
    const missing = makeFinding({ id: 'f-miss', title: 'Untriaged bug' });
    const md = renderReviewMarkdown(makeReviewResult({ missing: [missing] }));
    expect(md).toContain('## Reviewer missed (1)');
    expect(md).toContain('Untriaged bug');
  });

  it('includes review cost and model', () => {
    const md = renderReviewMarkdown(makeReviewResult());
    expect(md).toContain('claude-sonnet-4-6');
    expect(md).toContain('$0.0500');
  });
});

describe('writeReviewArtefacts', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'report-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes review.md and review.json', async () => {
    const result = makeReviewResult();
    await writeReviewArtefacts(tmpDir, result);

    const md = await readFile(path.join(tmpDir, 'review.md'), 'utf8');
    expect(md).toContain('# Review — test-run');

    const json = await readFile(path.join(tmpDir, 'review.json'), 'utf8');
    const parsed = JSON.parse(json);
    expect(parsed.runId).toBe('test-run');
    expect(parsed.reviews).toHaveLength(2);
  });
});
