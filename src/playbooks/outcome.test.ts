import { describe, expect, it } from 'vitest';
import { fail, ok, suspicious } from './outcome.ts';

describe('PlaybookOutcome constructors', () => {
  describe('ok', () => {
    it('creates an OK outcome with required fields', () => {
      const result = ok('fill_and_verify', 'Form filled successfully');
      expect(result.playbookName).toBe('fill_and_verify');
      expect(result.status).toBe('ok');
      expect(result.summary).toBe('Form filled successfully');
      expect(result.evidence).toEqual({});
      expect(result.steps).toEqual([]);
      expect(result.signals.networkAnomalies).toEqual([]);
      expect(result.signals.consoleErrors).toEqual([]);
      expect(result.durationMs).toBe(0);
    });

    it('accepts evidence and steps', () => {
      const result = ok(
        'form_test',
        'Done',
        { formId: 'f1' },
        [{ label: 'fill', ok: true }],
      );
      expect(result.evidence).toEqual({ formId: 'f1' });
      expect(result.steps).toHaveLength(1);
    });
  });

  describe('fail', () => {
    it('creates a failed outcome', () => {
      const result = fail('walk_wizard', 'Wizard not found');
      expect(result.status).toBe('failed');
      expect(result.summary).toBe('Wizard not found');
    });

    it('accepts evidence and steps', () => {
      const result = fail(
        'test',
        'Error occurred',
        { error: 'timeout' },
        [{ label: 'navigate', ok: false, detail: 'timed out' }],
      );
      expect(result.evidence.error).toBe('timeout');
      expect(result.steps[0]?.ok).toBe(false);
    });
  });

  describe('suspicious', () => {
    it('creates a suspicious outcome', () => {
      const result = suspicious(
        'idor_probe',
        'Guessed ID returned 200',
        { guessedId: '99999', status: 200 },
      );
      expect(result.status).toBe('suspicious');
      expect(result.evidence.guessedId).toBe('99999');
    });

    it('includes empty signals', () => {
      const result = suspicious('test', 'found issue', {});
      expect(result.signals.networkAnomalies).toEqual([]);
      expect(result.signals.consoleErrors).toEqual([]);
    });
  });
});
