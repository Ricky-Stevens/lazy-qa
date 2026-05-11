import { describe, expect, it } from 'vitest';
import {
  assertAbsoluteWithinRoot,
  assertUuid,
  assertWithinRoot,
  SENSITIVE_PATH_PATTERNS,
  SENSITIVE_PATHS,
} from './paths.ts';

describe('assertUuid', () => {
  it('accepts a valid UUID', () => {
    expect(() => assertUuid('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
  });

  it('accepts uppercase UUID', () => {
    expect(() => assertUuid('550E8400-E29B-41D4-A716-446655440000')).not.toThrow();
  });

  it('rejects a non-UUID string', () => {
    expect(() => assertUuid('not-a-uuid')).toThrow(/not a valid UUID/);
  });

  it('rejects an empty string', () => {
    expect(() => assertUuid('')).toThrow(/not a valid UUID/);
  });

  it('rejects a UUID with extra characters', () => {
    expect(() => assertUuid('550e8400-e29b-41d4-a716-446655440000x')).toThrow(/not a valid UUID/);
  });

  it('uses the custom label in error message', () => {
    expect(() => assertUuid('bad', 'runId')).toThrow(/runId is not a valid UUID/);
  });
});

describe('assertWithinRoot', () => {
  it('allows a relative path within root', () => {
    const result = assertWithinRoot('subdir/file.txt', '/home/user/project');
    expect(result).toBe('/home/user/project/subdir/file.txt');
  });

  it('allows the root itself', () => {
    const result = assertWithinRoot('.', '/home/user/project');
    expect(result).toBe('/home/user/project');
  });

  it('rejects path traversal with ../', () => {
    expect(() => assertWithinRoot('../../../etc/passwd', '/home/user/project')).toThrow(
      /escapes allowed root/,
    );
  });

  it('rejects absolute paths outside root', () => {
    expect(() => assertWithinRoot('/etc/passwd', '/home/user/project')).toThrow(
      /escapes allowed root/,
    );
  });

  it('uses the custom label in error message', () => {
    expect(() => assertWithinRoot('../../x', '/root', 'configPath')).toThrow(
      /configPath escapes allowed root/,
    );
  });
});

describe('assertAbsoluteWithinRoot', () => {
  it('accepts an absolute path within root', () => {
    const result = assertAbsoluteWithinRoot('/home/user/project/file.txt', '/home/user/project');
    expect(result).toBe('/home/user/project/file.txt');
  });

  it('rejects relative paths', () => {
    expect(() => assertAbsoluteWithinRoot('relative/path', '/home/user/project')).toThrow(
      /must be absolute/,
    );
  });

  it('rejects absolute paths outside root', () => {
    expect(() => assertAbsoluteWithinRoot('/etc/passwd', '/home/user/project')).toThrow(
      /escapes allowed root/,
    );
  });

  it('accepts the root directory itself', () => {
    const result = assertAbsoluteWithinRoot('/home/user/project', '/home/user/project');
    expect(result).toBe('/home/user/project');
  });
});

describe('SENSITIVE_PATH_PATTERNS', () => {
  const testCases: Array<{ path: string; shouldMatch: boolean }> = [
    { path: '/.git/HEAD', shouldMatch: true },
    { path: '/.git/config', shouldMatch: true },
    { path: '/.env', shouldMatch: true },
    { path: '/.env?x=1', shouldMatch: true },
    { path: '/.htaccess', shouldMatch: true },
    { path: '/web.config', shouldMatch: true },
    { path: '/WEB-INF/web.xml', shouldMatch: true },
    { path: '/server-status', shouldMatch: true },
    { path: '/server-info', shouldMatch: true },
    { path: '/api-docs', shouldMatch: true },
    { path: '/swagger.json', shouldMatch: true },
    { path: '/swagger-ui', shouldMatch: true },
    { path: '/metrics', shouldMatch: true },
    { path: '/actuator/env', shouldMatch: true },
    { path: '/actuator/heapdump', shouldMatch: true },
    { path: '/ftp', shouldMatch: true },
    { path: '/ftp/', shouldMatch: true },
    // These should NOT match
    { path: '/dashboard', shouldMatch: false },
    { path: '/api/users', shouldMatch: false },
    { path: '/login', shouldMatch: false },
  ];

  for (const { path, shouldMatch } of testCases) {
    it(`${shouldMatch ? 'matches' : 'does not match'} ${path}`, () => {
      const matched = SENSITIVE_PATH_PATTERNS.some((p) => p.test(path));
      expect(matched).toBe(shouldMatch);
    });
  }
});

describe('SENSITIVE_PATHS', () => {
  it('contains expected paths', () => {
    expect(SENSITIVE_PATHS).toContain('/.git/HEAD');
    expect(SENSITIVE_PATHS).toContain('/.env');
    expect(SENSITIVE_PATHS).toContain('/swagger.json');
    expect(SENSITIVE_PATHS).toContain('/ftp');
  });

  it('does not contain non-sensitive paths', () => {
    expect(SENSITIVE_PATHS).not.toContain('/login');
    expect(SENSITIVE_PATHS).not.toContain('/dashboard');
  });
});
