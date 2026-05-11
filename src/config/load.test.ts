import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveAgentCredentials, resolveApiKey, resolveTargetCredentials } from './load.ts';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'config-load-test-'));
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  const validYaml = `
target:
  url: http://localhost:3000
  allowed_hosts:
    - localhost:3000
  auth:
    type: none
anthropic:
  default_model: claude-haiku-4-5-20251001
run:
  output_dir: ./runs
agents: auto
`;

  it('loads and parses a valid YAML config', async () => {
    await writeFile(path.join(tmpDir, 'config.yaml'), validYaml);
    const cfg = await loadConfig('config.yaml');
    expect(cfg.target.url).toBe('http://localhost:3000');
    expect(cfg.target.allowed_hosts).toEqual(['localhost:3000']);
  });

  it('rejects config path that escapes cwd', async () => {
    await writeFile(path.join(tmpDir, 'config.yaml'), validYaml);
    await expect(loadConfig('../../../etc/passwd')).rejects.toThrow(/escapes project directory/);
  });

  it('rejects output_dir that escapes cwd', async () => {
    const badYaml = validYaml.replace('./runs', '../../tmp/evil');
    await writeFile(path.join(tmpDir, 'bad-output.yaml'), badYaml);
    await expect(loadConfig('bad-output.yaml')).rejects.toThrow(/escapes project directory/);
  });

  it('throws clear error for missing file', async () => {
    await expect(loadConfig('nonexistent.yaml')).rejects.toThrow(/Failed to read config/);
  });

  it('throws clear error for invalid YAML', async () => {
    await writeFile(path.join(tmpDir, 'bad.yaml'), '{ not: valid: yaml: {{');
    await expect(loadConfig('bad.yaml')).rejects.toThrow(/Failed to parse YAML/);
  });
});

describe('resolveApiKey', () => {
  it('returns the env var value when configured and set', () => {
    const original = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = 'sk-test-123';
    try {
      const result = resolveApiKey({
        anthropic: { api_key_env: 'TEST_API_KEY' },
      } as never);
      expect(result).toBe('sk-test-123');
    } finally {
      if (original === undefined) delete process.env.TEST_API_KEY;
      else process.env.TEST_API_KEY = original;
    }
  });

  it('returns null when api_key_env is not configured', () => {
    const result = resolveApiKey({ anthropic: {} } as never);
    expect(result).toBeNull();
  });

  it('returns null when the env var is empty', () => {
    const original = process.env.TEST_EMPTY_KEY;
    process.env.TEST_EMPTY_KEY = '   ';
    try {
      const result = resolveApiKey({
        anthropic: { api_key_env: 'TEST_EMPTY_KEY' },
      } as never);
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.TEST_EMPTY_KEY;
      else process.env.TEST_EMPTY_KEY = original;
    }
  });

  it('returns null when the env var is not set', () => {
    delete process.env.TEST_UNSET_KEY;
    const result = resolveApiKey({
      anthropic: { api_key_env: 'TEST_UNSET_KEY' },
    } as never);
    expect(result).toBeNull();
  });
});

describe('resolveAgentCredentials', () => {
  it('returns null when agent has no credentials config', () => {
    const result = resolveAgentCredentials({ id: 'a1' } as never);
    expect(result).toBeNull();
  });

  it('resolves credentials from env vars', () => {
    const origUser = process.env.TEST_AGENT_USER;
    const origPass = process.env.TEST_AGENT_PASS;
    process.env.TEST_AGENT_USER = 'admin';
    process.env.TEST_AGENT_PASS = 'secret';
    try {
      const result = resolveAgentCredentials({
        id: 'a1',
        credentials: { username_env: 'TEST_AGENT_USER', password_env: 'TEST_AGENT_PASS' },
      } as never);
      expect(result).toEqual({ username: 'admin', password: 'secret' });
    } finally {
      if (origUser === undefined) delete process.env.TEST_AGENT_USER;
      else process.env.TEST_AGENT_USER = origUser;
      if (origPass === undefined) delete process.env.TEST_AGENT_PASS;
      else process.env.TEST_AGENT_PASS = origPass;
    }
  });

  it('throws when username env var is missing', () => {
    delete process.env.TEST_MISSING_USER;
    process.env.TEST_AGENT_PASS_2 = 'secret';
    try {
      expect(() =>
        resolveAgentCredentials({
          id: 'a1',
          credentials: { username_env: 'TEST_MISSING_USER', password_env: 'TEST_AGENT_PASS_2' },
        } as never),
      ).toThrow(/Missing env var.*TEST_MISSING_USER/);
    } finally {
      delete process.env.TEST_AGENT_PASS_2;
    }
  });

  it('throws when password env var is empty', () => {
    process.env.TEST_AGENT_USER_3 = 'admin';
    process.env.TEST_AGENT_PASS_3 = '   ';
    try {
      expect(() =>
        resolveAgentCredentials({
          id: 'a1',
          credentials: { username_env: 'TEST_AGENT_USER_3', password_env: 'TEST_AGENT_PASS_3' },
        } as never),
      ).toThrow(/Missing env var.*TEST_AGENT_PASS_3/);
    } finally {
      delete process.env.TEST_AGENT_USER_3;
      delete process.env.TEST_AGENT_PASS_3;
    }
  });
});

describe('resolveTargetCredentials', () => {
  it('returns null when no target credentials configured', () => {
    const result = resolveTargetCredentials({
      target: { auth: {} },
    } as never);
    expect(result).toBeNull();
  });

  it('resolves target credentials from env vars', () => {
    process.env.TEST_TARGET_USER = 'root';
    process.env.TEST_TARGET_PASS = 'toor';
    try {
      const result = resolveTargetCredentials({
        target: {
          auth: {
            credentials: {
              username_env: 'TEST_TARGET_USER',
              password_env: 'TEST_TARGET_PASS',
            },
          },
        },
      } as never);
      expect(result).toEqual({ username: 'root', password: 'toor' });
    } finally {
      delete process.env.TEST_TARGET_USER;
      delete process.env.TEST_TARGET_PASS;
    }
  });

  it('throws when target username env var is missing', () => {
    delete process.env.TEST_NOTHERE;
    process.env.TEST_TARGET_PASS_2 = 'pw';
    try {
      expect(() =>
        resolveTargetCredentials({
          target: {
            auth: {
              credentials: {
                username_env: 'TEST_NOTHERE',
                password_env: 'TEST_TARGET_PASS_2',
              },
            },
          },
        } as never),
      ).toThrow(/Missing env var.*TEST_NOTHERE/);
    } finally {
      delete process.env.TEST_TARGET_PASS_2;
    }
  });
});
