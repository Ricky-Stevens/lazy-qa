import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type AgentConfig, type Config, ConfigSchema } from './types.ts';

/**
 * Load and parse a YAML config file, validating against the schema.
 */
export async function loadConfig(configPath: string): Promise<Config> {
  const cwd = path.resolve(process.cwd());
  const absPath = path.resolve(cwd, configPath);

  // Require config path to resolve within cwd — prevents MCP callers from reading
  // arbitrary files like /proc/self/environ via a crafted configPath.
  const rel = path.relative(cwd, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Config path '${configPath}' escapes project directory (${cwd}). Configs must live under cwd.`,
    );
  }

  let fileContent: string;
  try {
    fileContent = await readFile(absPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read config from '${absPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fileContent);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML in '${absPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const cfg = ConfigSchema.parse(parsed);

  // Constrain run.output_dir to within cwd
  const resolvedOut = path.resolve(cwd, cfg.run.output_dir);
  const outRel = path.relative(cwd, resolvedOut);
  if (outRel.startsWith('..') || path.isAbsolute(outRel)) {
    throw new Error(
      `run.output_dir '${cfg.run.output_dir}' escapes project directory (${cwd}). Must resolve within cwd.`,
    );
  }

  return cfg;
}

/**
 * Resolve the Anthropic API key from environment variables.
 *
 * Returns null when no api_key_env is configured OR when the referenced env var
 * is empty. Callers must treat null as "fall back to claude-CLI subscription
 * auth" — the SDK subprocess inherits whatever the local `claude` CLI has
 * cached, which means free interactive dev runs on a Pro/Max plan.
 */
export function resolveApiKey(cfg: Config): string | null {
  const envVar = cfg.anthropic.api_key_env;
  if (!envVar) return null;
  const value = process.env[envVar];
  if (!value || value.trim() === '') return null;
  return value;
}

/**
 * Resolve agent credentials from environment variables.
 * Returns null if the agent has no credentials (only valid when target.auth.type === 'none').
 */
export function resolveAgentCredentials(
  agent: AgentConfig,
): { username: string; password: string } | null {
  if (!agent.credentials) return null;

  const { username_env, password_env } = agent.credentials;

  const username = process.env[username_env];
  if (!username || username.trim() === '') {
    throw new Error(
      `Missing env var: ${username_env} (referenced by agent '${agent.id}'.credentials.username_env)`,
    );
  }

  const password = process.env[password_env];
  if (!password || password.trim() === '') {
    throw new Error(
      `Missing env var: ${password_env} (referenced by agent '${agent.id}'.credentials.password_env)`,
    );
  }

  return { username, password };
}

/**
 * Resolve credentials from target.auth.credentials (used by auto mode and
 * as fallback for manual agents). Returns null when no credentials configured.
 */
export function resolveTargetCredentials(
  cfg: Config,
): { username: string; password: string } | null {
  const creds = cfg.target.auth.credentials;
  if (!creds) return null;

  const username = process.env[creds.username_env];
  if (!username || username.trim() === '') {
    throw new Error(
      `Missing env var: ${creds.username_env} (referenced by target.auth.credentials.username_env)`,
    );
  }

  const password = process.env[creds.password_env];
  if (!password || password.trim() === '') {
    throw new Error(
      `Missing env var: ${creds.password_env} (referenced by target.auth.credentials.password_env)`,
    );
  }

  return { username, password };
}
