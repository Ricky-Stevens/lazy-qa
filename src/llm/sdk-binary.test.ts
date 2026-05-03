import { describe, expect, it } from 'vitest';
import {
  _resetClaudeBinaryPathCacheForTests,
  binaryCandidates,
  detectLibcKind,
  resolveClaudeBinaryPath,
} from './sdk-binary.ts';

describe('binaryCandidates', () => {
  it('linux glibc — prefers glibc variant, falls back to musl', () => {
    expect(binaryCandidates('linux', 'x64', 'glibc')).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
    ]);
  });

  it('linux musl — prefers musl variant, falls back to glibc', () => {
    expect(binaryCandidates('linux', 'x64', 'musl')).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
      '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    ]);
  });

  it('linux arm64 glibc — same ordering with arm64 paths', () => {
    expect(binaryCandidates('linux', 'arm64', 'glibc')).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
      '@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude',
    ]);
  });

  it('darwin — single platform-arch entry, no libc fork', () => {
    expect(binaryCandidates('darwin', 'arm64', 'glibc')).toEqual([
      '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    ]);
  });

  it('win32 — single entry with .exe extension', () => {
    expect(binaryCandidates('win32', 'x64', 'glibc')).toEqual([
      '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    ]);
  });
});

describe('detectLibcKind', () => {
  it('returns glibc or musl on Linux; both are valid', () => {
    const result = detectLibcKind();
    expect(['glibc', 'musl']).toContain(result);
  });
});

describe('resolveClaudeBinaryPath', () => {
  it('resolves to an existing absolute file path', () => {
    _resetClaudeBinaryPathCacheForTests();
    const resolved = resolveClaudeBinaryPath();
    expect(resolved).toMatch(/\/claude(\.exe)?$/);
    // Second call returns the same memoised value without re-resolving.
    expect(resolveClaudeBinaryPath()).toBe(resolved);
  });
});
