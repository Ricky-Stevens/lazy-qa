/**
 * Post-run webhook — sends confirmed findings to an external endpoint
 * (Jira, Linear, GitHub Issues, generic webhook) after the review phase.
 *
 * Configuration:
 *   run:
 *     webhook_url: https://hooks.example.com/findings
 *     webhook_min_severity: major  # optional, default: major
 *
 * Each confirmed_bug or likely_bug finding is POSTed as a JSON payload:
 *   { title, description, severity, stepsToReproduce, expected, actual, route, category }
 *
 * Failures are logged but never fail the run.
 */

import type { Logger } from '../logging/logger.ts';
import { redactFinding } from '../safety/redact.ts';
import type { Finding } from '../types/finding.ts';

export interface WebhookConfig {
  url: string;
  minSeverity?: 'critical' | 'major' | 'minor' | 'cosmetic';
  headers?: Record<string, string>;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  cosmetic: 3,
};

export async function sendFindingsWebhook(opts: {
  findings: Finding[];
  classifications: Array<{ title: string; classification: string }>;
  webhook: WebhookConfig;
  runId: string;
  targetUrl: string;
  logger: Logger;
}): Promise<{ sent: number; failed: number }> {
  const { findings, classifications, webhook, runId, targetUrl, logger } = opts;
  const minSev = SEVERITY_ORDER[webhook.minSeverity ?? 'major'] ?? 1;

  const classMap = new Map(classifications.map((c) => [c.title, c.classification]));

  const eligible = findings.filter((f) => {
    const cls = classMap.get(f.title);
    if (cls !== 'confirmed_bug' && cls !== 'likely_bug') return false;
    const sevOrder = SEVERITY_ORDER[f.severity] ?? 3;
    return sevOrder <= minSev;
  });

  let sent = 0;
  let failed = 0;

  for (const finding of eligible) {
    try {
      const safe = redactFinding(finding);
      const payload = {
        source: 'lazy-qa',
        runId,
        targetUrl,
        title: safe.title,
        description: safe.description,
        severity: safe.severity,
        category: safe.category,
        route: safe.route,
        stepsToReproduce: safe.stepsToReproduce,
        expected: safe.expected,
        actual: safe.actual,
        confidence: safe.confidence,
      };

      const resp = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...webhook.headers,
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        sent++;
      } else {
        failed++;
        logger.warn('webhook.response.error', {
          status: resp.status,
          title: finding.title,
        });
      }
    } catch (err) {
      failed++;
      logger.warn('webhook.send.failed', {
        title: finding.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('webhook.complete', { sent, failed, eligible: eligible.length });
  return { sent, failed };
}
