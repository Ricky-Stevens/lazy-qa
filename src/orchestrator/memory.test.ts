/**
 * Tests for memory.ts — resolveMemoryPath determinism, SHA1 hashing,
 * and override behaviour.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMemoryPath } from './memory.ts';

describe('resolveMemoryPath', () => {
  it('returns a path under ~/.lazy-qa/memory/ by default', () => {
    const result = resolveMemoryPath('https://app.example.com');
    expect(result.startsWith(path.join(homedir(), '.lazy-qa', 'memory'))).toBe(true);
  });

  it('produces deterministic output for the same URL', () => {
    const a = resolveMemoryPath('https://app.example.com');
    const b = resolveMemoryPath('https://app.example.com');
    expect(a).toBe(b);
  });

  it('produces different paths for different URLs', () => {
    const a = resolveMemoryPath('https://app.example.com');
    const b = resolveMemoryPath('https://other.example.com');
    expect(a).not.toBe(b);
  });

  it('uses first 16 chars of SHA1 hash as directory name', () => {
    const url = 'https://app.example.com';
    const expectedHash = createHash('sha1').update(url).digest('hex').slice(0, 16);
    const result = resolveMemoryPath(url);
    expect(result).toBe(path.join(homedir(), '.lazy-qa', 'memory', expectedHash));
  });

  it('hash directory name is a 16-character hex string', () => {
    const result = resolveMemoryPath('https://test.local:8080');
    const dirName = path.basename(result);
    expect(dirName).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles URLs with paths and query strings', () => {
    const result = resolveMemoryPath('https://app.example.com/admin?tab=users#section');
    const dirName = path.basename(result);
    expect(dirName).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles empty string URL', () => {
    const result = resolveMemoryPath('');
    const dirName = path.basename(result);
    expect(dirName).toMatch(/^[0-9a-f]{16}$/);
  });

  describe('override', () => {
    it('returns the override path when provided', () => {
      const override = '/custom/memory/path';
      const result = resolveMemoryPath('https://app.example.com', override);
      expect(result).toBe(path.resolve(override));
    });

    it('resolves relative override to absolute path', () => {
      const result = resolveMemoryPath('https://app.example.com', './my-memory');
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('ignores the URL when override is provided', () => {
      const a = resolveMemoryPath('https://a.com', '/override');
      const b = resolveMemoryPath('https://b.com', '/override');
      expect(a).toBe(b);
    });
  });
});
