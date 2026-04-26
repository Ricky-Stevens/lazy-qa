import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from '../types/finding.ts';
import type { ReviewItem, ReviewResult } from './review.ts';

/**
 * Writes the post-run review to `<runDir>/review.md` and `<runDir>/review.json`.
 * The markdown is the human-facing artefact; the JSON is for downstream tooling.
 */

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'cosmetic'] as const;
const CLASSIFICATION_ORDER: Array<ReviewItem['classification']> = [
  'confirmed_bug',
  'likely_bug',
  'duplicate',
  'environmental',
  'not_a_bug',
];

function effectiveSeverity(f: Finding, r: ReviewItem): Finding['severity'] {
  return r.suggestedSeverity ?? f.severity;
}

function bySeverityThenTitle(
  a: { finding: Finding; review: ReviewItem },
  b: { finding: Finding; review: ReviewItem },
): number {
  const sa = SEVERITY_ORDER.indexOf(effectiveSeverity(a.finding, a.review));
  const sb = SEVERITY_ORDER.indexOf(effectiveSeverity(b.finding, b.review));
  if (sa !== sb) return sa - sb;
  return a.finding.title.localeCompare(b.finding.title);
}

function findingBlock(
  entry: { finding: Finding; review: ReviewItem },
  findingsById: Map<string, Finding>,
): string[] {
  const { finding: f, review: r } = entry;
  const lines: string[] = [];
  const sevNote =
    r.suggestedSeverity && r.suggestedSeverity !== f.severity
      ? ` (originally **${f.severity}**, reviewer suggests **${r.suggestedSeverity}**)`
      : '';
  lines.push(`#### \`${effectiveSeverity(f, r)}\` ${f.title}${sevNote}`);
  if (f.route) lines.push(`Route: \`${f.route}\``);
  lines.push('');
  lines.push(`**Reviewer (${r.classification}):** ${r.reasoning}`);
  if (r.duplicateOf) {
    const dup = findingsById.get(r.duplicateOf);
    lines.push('');
    lines.push(`**Duplicate of:** \`${r.duplicateOf}\`${dup ? ` — "${dup.title}"` : ''}`);
  }
  lines.push('');
  lines.push(`**Description:** ${f.description}`);
  if (f.expected) lines.push('');
  if (f.expected) lines.push(`**Expected:** ${f.expected}`);
  if (f.actual) lines.push(`**Actual:** ${f.actual}`);
  if (f.stepsToReproduce.length) {
    lines.push('');
    lines.push('**Steps to reproduce:**');
    for (const s of f.stepsToReproduce) lines.push(`1. ${s}`);
  }
  lines.push('');
  lines.push(`*id: \`${f.id}\` · category: ${f.category} · agent confidence: ${f.confidence}*`);
  if (f.screenshotPath) {
    lines.push('');
    lines.push(`![](./${f.screenshotPath})`);
  }
  lines.push('');
  return lines;
}

export function renderReviewMarkdown(review: ReviewResult): string {
  const lines: string[] = [];
  const findingsById = new Map(review.reviews.map((r) => [r.finding.id, r.finding]));

  lines.push(`# Review — ${review.runId}`);
  lines.push('');
  lines.push(
    `Reviewed at: ${review.reviewedAt} · Model: \`${review.model}\` · Review cost: $${review.reviewCostUsd.toFixed(4)}`,
  );
  lines.push('');

  if (review.overallNotes) {
    lines.push('## Overall');
    lines.push('');
    lines.push(review.overallNotes);
    lines.push('');
  }

  // Summary counts
  lines.push('## Triage summary');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|---|---|');
  for (const c of CLASSIFICATION_ORDER) {
    lines.push(`| ${c.replace('_', ' ')} | ${review.counts[c]} |`);
  }
  if (review.missing.length > 0) {
    lines.push(`| _missing from reviewer output_ | ${review.missing.length} |`);
  }
  lines.push('');

  // Severity rebalance summary
  const reSeveritied = review.reviews.filter(
    ({ finding, review: r }) => r.suggestedSeverity && r.suggestedSeverity !== finding.severity,
  );
  if (reSeveritied.length > 0) {
    lines.push(`## Severity adjustments (${reSeveritied.length})`);
    lines.push('');
    lines.push('| Finding | Original | Reviewer | Reasoning |');
    lines.push('|---|---|---|---|');
    for (const { finding, review: r } of reSeveritied) {
      lines.push(
        `| ${finding.title} | ${finding.severity} | **${r.suggestedSeverity}** | ${r.reasoning.replace(/\|/g, '\\|').slice(0, 140)} |`,
      );
    }
    lines.push('');
  }

  // Clusters
  if (review.clusters.length > 0) {
    lines.push(`## Themes (${review.clusters.length})`);
    lines.push('');
    for (const c of review.clusters) {
      lines.push(`### ${c.label}`);
      lines.push('');
      lines.push(c.note);
      lines.push('');
      lines.push(`Findings: ${c.findingIds.length}`);
      for (const id of c.findingIds) {
        const f = findingsById.get(id);
        if (f) lines.push(`- ${f.title}${f.route ? ` \`${f.route}\`` : ''} (\`${id}\`)`);
      }
      lines.push('');
    }
  }

  // Per-classification sections, ordered by severity inside each.
  for (const cls of CLASSIFICATION_ORDER) {
    const entries = review.reviews
      .filter(({ review: r }) => r.classification === cls)
      .sort(bySeverityThenTitle);
    if (entries.length === 0) continue;
    lines.push(`## ${cls.replace('_', ' ')} (${entries.length})`);
    lines.push('');
    for (const entry of entries) {
      lines.push(...findingBlock(entry, findingsById));
    }
  }

  if (review.missing.length > 0) {
    lines.push(`## Reviewer missed (${review.missing.length})`);
    lines.push('');
    lines.push(
      'These findings were submitted but the reviewer did not return a classification for them. Treat as untriaged.',
    );
    lines.push('');
    for (const f of review.missing) {
      lines.push(
        `- \`${f.severity}\` ${f.title}${f.route ? ` \`${f.route}\`` : ''} (id: \`${f.id}\`)`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeReviewArtefacts(runDir: string, review: ReviewResult): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const md = renderReviewMarkdown(review);
  await writeFile(path.join(runDir, 'review.md'), md, 'utf8');
  await writeFile(path.join(runDir, 'review.json'), JSON.stringify(review, null, 2), 'utf8');
}
