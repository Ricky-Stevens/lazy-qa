/**
 * Resolves the absolute path of the `claude` native binary that ships with
 * `@anthropic-ai/claude-agent-sdk`'s platform-specific optional dependencies,
 * and exposes it for use as `query()`'s `pathToClaudeCodeExecutable` option.
 *
 * Why this exists:
 *
 *   The SDK's built-in resolver tries `linux-${arch}-musl` BEFORE
 *   `linux-${arch}` on Linux. npm/yarn/pnpm honour the `libc` field on each
 *   sub-package's `package.json` and only install the variant matching the
 *   host's libc, so the SDK's order works for them. Bun (>=1.x) does not
 *   filter optionalDependencies by `libc`: it installs both variants. On a
 *   glibc system the SDK then picks the musl binary first; spawn fails
 *   because the musl dynamic loader (`libc.musl-x86_64.so.1`) is missing,
 *   and the SDK reports the misleading "Claude Code native binary not
 *   found" error.
 *
 * Fix: detect the host libc via `process.report.getReport().header
 * .glibcVersionRuntime` (set when the running Node was linked against
 * glibc, falsy on musl), enumerate candidates in the correct order, and
 * pass the resolved absolute path to `query()`.
 *
 * The result is memoised — resolution is filesystem-bound and the answer
 * cannot change within a single process.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export type LibcKind = 'glibc' | 'musl';

export type Platform = NodeJS.Platform;
export type Arch = NodeJS.Architecture;

/** Detect the host's C library. `glibcVersionRuntime` is populated on a
 *  glibc-linked Node and absent (empty / undefined) on a musl-linked Node
 *  (Alpine). On non-Linux platforms the value is meaningless; callers should
 *  only use this on Linux. */
export function detectLibcKind(): LibcKind {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    const v = report.header?.glibcVersionRuntime;
    return v ? 'glibc' : 'musl';
  } catch {
    return 'glibc';
  }
}

/** Pure: produce the candidate package-relative paths in preference order
 *  for a given (platform, arch, libc). Linux gets two entries — preferred
 *  libc first, then the other as a defensive fallback in case the host
 *  somehow reports the wrong libc. macOS / Windows have a single variant.
 *  Exported for unit testing. */
export function binaryCandidates(platform: Platform, arch: Arch, libc: LibcKind): string[] {
  const ext = platform === 'win32' ? '.exe' : '';
  if (platform === 'linux') {
    const glibc = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`;
    const musl = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`;
    return libc === 'glibc' ? [glibc, musl] : [musl, glibc];
  }
  return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`];
}

let cached: string | undefined;

/** Resolve the absolute path of the SDK's native `claude` binary for this
 *  host. Memoised. Throws if no compatible binary is installed — that
 *  indicates a broken dependency tree, not a runtime condition the caller
 *  can recover from. */
export function resolveClaudeBinaryPath(): string {
  if (cached) return cached;
  const libc = process.platform === 'linux' ? detectLibcKind() : 'glibc';
  const candidates = binaryCandidates(process.platform, process.arch, libc);
  const require = createRequire(import.meta.url);
  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate);
      if (existsSync(resolved)) {
        cached = resolved;
        return resolved;
      }
      tried.push(`${candidate} (resolved but missing on disk: ${resolved})`);
    } catch (err) {
      tried.push(
        `${candidate} (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
      );
    }
  }
  throw new Error(
    `Could not locate a compatible @anthropic-ai/claude-agent-sdk native binary for ${process.platform}-${process.arch}` +
      `${process.platform === 'linux' ? `/${libc}` : ''}. Tried: ${tried.join('; ')}`,
  );
}

/** Test-only: drop the memoised path so a subsequent call re-resolves. */
export function _resetClaudeBinaryPathCacheForTests(): void {
  cached = undefined;
}
