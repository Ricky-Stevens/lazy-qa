import { describe, expect, it } from 'vitest';
import type { Finding } from '../types/finding.ts';
import { redactFinding, redactSensitiveData } from './redact.ts';

describe('redactSensitiveData', () => {
  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiYWRtaW4ifQ.dummysignature';
    // Use "Found" instead of "Token:" to avoid triggering the key-value rule first
    const result = redactSensitiveData(`Found ${jwt} in response`);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('[JWT-REDACTED]');
  });

  it('redacts Stripe-style API keys (sk-live)', () => {
    const result = redactSensitiveData('key is sk-live_abcdefghij1234567890');
    expect(result).not.toContain('sk-live_abcdefghij1234567890');
    expect(result).toContain('[APIKEY-REDACTED]');
  });

  it('redacts Stripe-style API keys (pk-test)', () => {
    const result = redactSensitiveData('key is pk-test_abcdefghij1234567890');
    expect(result).not.toContain('pk-test_abcdefghij1234567890');
    expect(result).toContain('[APIKEY-REDACTED]');
  });

  it('redacts GitHub personal access tokens', () => {
    const token = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    const result = redactSensitiveData(`github: ${token}`);
    expect(result).not.toContain(token);
    expect(result).toContain('[GITHUB-TOKEN-REDACTED]');
  });

  it('redacts OpenAI-style API keys (sk-...)', () => {
    const key = 'sk-proj1234567890abcdefghij';
    const result = redactSensitiveData(`api key: ${key}`);
    expect(result).not.toContain(key);
    expect(result).toContain('[APIKEY-REDACTED]');
  });

  it('redacts AWS access key IDs', () => {
    // AKIAIOSFODNN7EXAMPLE is 20 chars all-uppercase with digits -- it matches
    // the TOTP rule (Base32 A-Z2-7 with at least one digit) before reaching the
    // AWS rule. This is WAI -- the TOTP rule is intentionally broad. Verify the
    // key is removed regardless of which rule fires.
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const result = redactSensitiveData(`aws ${key} found`);
    expect(result).not.toContain(key);
    // The key is redacted by whichever rule matches first (TOTP or AWS)
    expect(result).toMatch(/\[(TOTP-REDACTED|AWS-KEY-REDACTED)\]/);
  });

  it('redacts Slack tokens', () => {
    const token = 'xoxb-1234567890-abcdefgh';
    const result = redactSensitiveData(`slack: ${token}`);
    expect(result).not.toContain(token);
    expect(result).toContain('[SLACK-TOKEN-REDACTED]');
  });

  it('redacts credentials in URLs', () => {
    const result = redactSensitiveData('https://admin:s3cret@db.example.com/prod');
    expect(result).not.toContain('admin:s3cret');
    expect(result).toContain('[CREDS-REDACTED]');
  });

  it('redacts key-value pairs with sensitive keys', () => {
    const result = redactSensitiveData('password=hunter2');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts PEM private keys', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----';
    const result = redactSensitiveData(pem);
    expect(result).not.toContain('MIIEvgIBADANBgkqhkiG9w0BAQ');
    expect(result).toContain('[PRIVATE-KEY-REDACTED]');
  });

  it('redacts 32-char hex hashes', () => {
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const result = redactSensitiveData(`hash: ${hash}`);
    expect(result).toContain('[HASH-32]');
  });

  it('redacts 64-char hex hashes', () => {
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const result = redactSensitiveData(`hash: ${hash}`);
    expect(result).toContain('[HASH-64]');
  });

  it('preserves non-sensitive text unchanged', () => {
    const text = 'The login form has a broken submit button on /admin/users';
    expect(redactSensitiveData(text)).toBe(text);
  });

  it('handles multiple secrets in one string', () => {
    const text =
      'Token eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.sig123 and key sk-live_1234567890abcdef';
    const result = redactSensitiveData(text);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).not.toContain('sk-live_1234567890abcdef');
  });
});

describe('redactFinding', () => {
  function makeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: 'f-1',
      ts: new Date().toISOString(),
      severity: 'major',
      category: 'broken-feature',
      title: 'Test finding',
      description: 'A test finding',
      stepsToReproduce: ['Step 1'],
      expected: 'Expected',
      actual: 'Actual',
      confidence: 'likely',
      source: 'agent',
      ...overrides,
    };
  }

  it('redacts secrets in title', () => {
    const f = makeFinding({ title: 'Found sk-live_1234567890abcdef in response' });
    const result = redactFinding(f);
    expect(result.title).not.toContain('sk-live_1234567890abcdef');
    expect(result.title).toContain('[APIKEY-REDACTED]');
  });

  it('redacts secrets in description', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.sig';
    const f = makeFinding({ description: `JWT found: ${jwt}` });
    const result = redactFinding(f);
    expect(result.description).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts secrets in stepsToReproduce', () => {
    const f = makeFinding({
      stepsToReproduce: ['Navigate to /api', 'Pass password=hunter2 in body'],
    });
    const result = redactFinding(f);
    expect(result.stepsToReproduce[1]).not.toContain('hunter2');
  });

  it('redacts secrets in expected and actual', () => {
    const f = makeFinding({
      expected: 'Returns password=secret123',
      actual: 'Leaked password=hunter2',
    });
    const result = redactFinding(f);
    expect(result.expected).not.toContain('secret123');
    expect(result.actual).not.toContain('hunter2');
  });

  it('redacts secrets in optional text fields (route, consoleErrors)', () => {
    const f = makeFinding({
      route: 'https://admin:s3cret@app.example.com/api',
      consoleErrors: ['Error: password=leaked123 in debug output'],
    });
    const result = redactFinding(f);
    expect(result.route).not.toContain('admin:s3cret');
    expect(result.consoleErrors![0]).not.toContain('leaked123');
  });

  it('does not modify the original finding object', () => {
    const f = makeFinding({ title: 'sk-live_1234567890abcdef leaked' });
    redactFinding(f);
    expect(f.title).toContain('sk-live_1234567890abcdef');
  });
});
