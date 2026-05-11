/**
 * Tests for webhook.ts — webhook payload construction, severity filtering,
 * classification filtering, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finding } from '../types/finding.ts';
import { sendFindingsWebhook, type WebhookConfig } from './webhook.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    ts: new Date().toISOString(),
    severity: 'major',
    category: 'broken-feature',
    title: 'Button does not work',
    description: 'The submit button is non-functional',
    stepsToReproduce: ['Navigate to /form', 'Click Submit'],
    expected: 'Form submits',
    actual: 'Nothing happens',
    route: '/form',
    confidence: 'certain',
    source: 'agent',
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Parameters<typeof sendFindingsWebhook>[0]['logger'];
}

function makeClassification(title: string, classification: string) {
  return { title, classification };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendFindingsWebhook', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseWebhook: WebhookConfig = {
    url: 'https://hooks.example.com/findings',
  };

  describe('filtering', () => {
    it('sends only confirmed_bug and likely_bug findings', async () => {
      const findings = [
        makeFinding({ id: 'f1', title: 'Bug A' }),
        makeFinding({ id: 'f2', title: 'Bug B' }),
        makeFinding({ id: 'f3', title: 'Not a bug' }),
      ];
      const classifications = [
        makeClassification('Bug A', 'confirmed_bug'),
        makeClassification('Bug B', 'likely_bug'),
        makeClassification('Not a bug', 'false_positive'),
      ];

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('filters by severity using default minSeverity of major', async () => {
      const findings = [
        makeFinding({ id: 'f1', title: 'Critical bug', severity: 'critical' }),
        makeFinding({ id: 'f2', title: 'Major bug', severity: 'major' }),
        makeFinding({ id: 'f3', title: 'Minor bug', severity: 'minor' }),
        makeFinding({ id: 'f4', title: 'Cosmetic bug', severity: 'cosmetic' }),
      ];
      const classifications = findings.map((f) =>
        makeClassification(f.title, 'confirmed_bug'),
      );

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      // critical (0) <= major (1), major (1) <= major (1) => both sent
      // minor (2) > major (1), cosmetic (3) > major (1) => filtered out
      expect(result.sent).toBe(2);
    });

    it('respects custom minSeverity of cosmetic', async () => {
      const findings = [
        makeFinding({ id: 'f1', title: 'Cosmetic bug', severity: 'cosmetic' }),
      ];
      const classifications = [makeClassification('Cosmetic bug', 'confirmed_bug')];

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: { ...baseWebhook, minSeverity: 'cosmetic' },
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(1);
    });

    it('respects custom minSeverity of critical', async () => {
      const findings = [
        makeFinding({ id: 'f1', title: 'Critical', severity: 'critical' }),
        makeFinding({ id: 'f2', title: 'Major', severity: 'major' }),
      ];
      const classifications = findings.map((f) =>
        makeClassification(f.title, 'confirmed_bug'),
      );

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: { ...baseWebhook, minSeverity: 'critical' },
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(1);
    });

    it('sends nothing when no findings match classification', async () => {
      const findings = [makeFinding({ id: 'f1', title: 'Some finding' })];
      const classifications = [makeClassification('Some finding', 'false_positive')];

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sends nothing when findings list is empty', async () => {
      const result = await sendFindingsWebhook({
        findings: [],
        classifications: [],
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('excludes findings without classification match', async () => {
      const findings = [makeFinding({ id: 'f1', title: 'Unclassified finding' })];
      // classifications list is empty — no match
      const classifications: Array<{ title: string; classification: string }> = [];

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(0);
    });
  });

  describe('payload construction', () => {
    it('sends correct JSON payload shape', async () => {
      const finding = makeFinding({
        id: 'f1',
        title: 'XSS in search',
        description: 'Reflected XSS found',
        severity: 'critical',
        category: 'validation',
        route: '/search',
        stepsToReproduce: ['Navigate to /search', 'Enter <script>alert(1)</script>'],
        expected: 'Input sanitized',
        actual: 'Script executed',
        confidence: 'certain',
      });
      const classifications = [makeClassification('XSS in search', 'confirmed_bug')];

      await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: baseWebhook,
        runId: 'run-42',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://hooks.example.com/findings');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        source: 'lazy-qa',
        runId: 'run-42',
        targetUrl: 'http://localhost:3000',
        title: 'XSS in search',
        description: 'Reflected XSS found',
        severity: 'critical',
        category: 'validation',
        route: '/search',
        stepsToReproduce: ['Navigate to /search', 'Enter <script>alert(1)</script>'],
        expected: 'Input sanitized',
        actual: 'Script executed',
        confidence: 'certain',
      });
    });

    it('sends Content-Type application/json header', async () => {
      const finding = makeFinding({ title: 'Test' });
      const classifications = [makeClassification('Test', 'confirmed_bug')];

      await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      const [, opts] = fetchSpy.mock.calls[0]!;
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('merges custom headers', async () => {
      const finding = makeFinding({ title: 'Test' });
      const classifications = [makeClassification('Test', 'confirmed_bug')];

      await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: {
          ...baseWebhook,
          headers: { Authorization: 'Bearer secret', 'X-Custom': 'value' },
        },
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      const [, opts] = fetchSpy.mock.calls[0]!;
      expect(opts.headers.Authorization).toBe('Bearer secret');
      expect(opts.headers['X-Custom']).toBe('value');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('error handling', () => {
    it('counts non-ok responses as failed', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });
      const finding = makeFinding({ title: 'Test' });
      const classifications = [makeClassification('Test', 'confirmed_bug')];
      const logger = makeLogger();

      const result = await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger,
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith('webhook.response.error', {
        status: 500,
        title: 'Test',
      });
    });

    it('counts fetch exceptions as failed', async () => {
      fetchSpy.mockRejectedValue(new Error('Network timeout'));
      const finding = makeFinding({ title: 'Test' });
      const classifications = [makeClassification('Test', 'confirmed_bug')];
      const logger = makeLogger();

      const result = await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger,
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith('webhook.send.failed', {
        title: 'Test',
        error: 'Network timeout',
      });
    });

    it('handles non-Error exceptions', async () => {
      fetchSpy.mockRejectedValue('string error');
      const finding = makeFinding({ title: 'Test' });
      const classifications = [makeClassification('Test', 'confirmed_bug')];
      const logger = makeLogger();

      const result = await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger,
      });

      expect(result.failed).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith('webhook.send.failed', {
        title: 'Test',
        error: 'string error',
      });
    });

    it('continues sending after individual failures', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const findings = [
        makeFinding({ id: 'f1', title: 'A', severity: 'critical' }),
        makeFinding({ id: 'f2', title: 'B', severity: 'critical' }),
        makeFinding({ id: 'f3', title: 'C', severity: 'critical' }),
      ];
      const classifications = findings.map((f) =>
        makeClassification(f.title, 'confirmed_bug'),
      );

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('never throws, even when all requests fail', async () => {
      fetchSpy.mockRejectedValue(new Error('total failure'));
      const findings = [
        makeFinding({ id: 'f1', title: 'A' }),
        makeFinding({ id: 'f2', title: 'B' }),
      ];
      const classifications = findings.map((f) =>
        makeClassification(f.title, 'confirmed_bug'),
      );

      const result = await sendFindingsWebhook({
        findings,
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger: makeLogger(),
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(2);
    });
  });

  describe('logging', () => {
    it('logs completion summary', async () => {
      const finding = makeFinding({ title: 'Test' });
      const classifications = [makeClassification('Test', 'confirmed_bug')];
      const logger = makeLogger();

      await sendFindingsWebhook({
        findings: [finding],
        classifications,
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger,
      });

      expect(logger.info).toHaveBeenCalledWith('webhook.complete', {
        sent: 1,
        failed: 0,
        eligible: 1,
      });
    });

    it('logs zero eligible when no findings pass filters', async () => {
      const logger = makeLogger();

      await sendFindingsWebhook({
        findings: [],
        classifications: [],
        webhook: baseWebhook,
        runId: 'run-1',
        targetUrl: 'http://localhost:3000',
        logger,
      });

      expect(logger.info).toHaveBeenCalledWith('webhook.complete', {
        sent: 0,
        failed: 0,
        eligible: 0,
      });
    });
  });
});
