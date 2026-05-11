/**
 * Authentication phase — AI-driven form login that captures storageState
 * for the crawler and all agent sessions.
 */

import path from 'node:path';
import type { Config } from '../../config/types.ts';
import type { LlmBackend } from '../../llm/backend.ts';
import type { Logger } from '../../logging/logger.ts';
import type { EventWriter } from '../events.ts';
import { runAuthAgent } from '../auth-agent.ts';

export interface AuthPhaseResult {
  sessionInfo: { username: string; role?: string } | undefined;
  authCostUsd: number;
}

export async function runAuthPhase(
  cfg: Config,
  backend: LlmBackend,
  runDir: string,
  runCredentials: { username: string; password: string } | null,
  logger: Logger,
  events: EventWriter,
  abortSignal: AbortSignal,
): Promise<AuthPhaseResult> {
  let sessionInfo: { username: string; role?: string } | undefined;
  let authCostUsd = 0;

  if (cfg.target.auth.type === 'form' && runCredentials) {
    const authStatePath = path.join(runDir, 'auth-state.json');
    const authResult = await runAuthAgent({
      targetUrl: cfg.target.url,
      loginUrl: cfg.target.auth.login_url,
      credentials: runCredentials,
      allowedHosts: cfg.target.allowed_hosts,
      backend,
      model: 'claude-haiku-4-5-20251001',
      storageStatePath: authStatePath,
      logger: logger.child({ phase: 'auth-agent' }),
      events,
      stealth: cfg.target.stealth,
      abortSignal,
    });
    authCostUsd = authResult.costUsd;
    if (!authResult.ok) {
      logger.warn('auth-agent.unsuccessful', {
        detail: authResult.detail,
        turns: authResult.turns,
        costUsd: authResult.costUsd.toFixed(4),
      });
    } else {
      sessionInfo = authResult.sessionInfo;
    }
  }

  return { sessionInfo, authCostUsd };
}
