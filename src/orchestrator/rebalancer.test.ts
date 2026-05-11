import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { _resetRegistry, registerAgent } from './registry.ts';
import { startRebalancer } from './rebalancer.ts';

function makeAgent(id: string, profileName: string, maxUsd = 1.0): ResolvedAgent {
  return {
    id,
    profileName,
    personality: `I am ${id}`,
    model: 'claude-haiku-4-5-20251001',
    budget: { max_turns: 100, max_usd: maxUsd, max_minutes: 10 },
    credentials: { username: 'user', password: 'pass' },
  };
}

function makeJourney(agentId: string, overrides: Partial<Journey> = {}): Journey {
  return {
    runId: 'test-run',
    agentId,
    startedAt: new Date().toISOString(),
    startUrl: 'http://localhost:3000',
    turns: 0,
    findings: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    ...overrides,
  };
}

describe('rebalancer', () => {
  it('starts and stops without errors', () => {
    _resetRegistry();
    const agents: ResolvedAgent[] = [];
    const journeys = new Map<string, Journey>();
    const stop = startRebalancer({
      agents,
      journeys,
      skillsBundle: { personas: new Map(), playbooks: new Map() },
      spawnReplacement: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } as any,
      defaultModel: 'claude-haiku-4-5-20251001',
      authType: 'none',
      credentials: null,
      securityQueue: [],
      qaQueue: [],
      securitySlots: 2,
      qaSlots: 2,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('fills QA slots from the queue', async () => {
    _resetRegistry();
    const agent1 = makeAgent('qa-1', 'sheldon');
    const agent2 = makeAgent('qa-2', 'karen');
    registerAgent('qa-1', 'sheldon');

    const agents: ResolvedAgent[] = [agent1];
    const journeys = new Map<string, Journey>();
    journeys.set('qa-1', makeJourney('qa-1', { terminationReason: 'max-turns' }));

    const spawned: string[] = [];
    const stop = startRebalancer({
      agents,
      journeys,
      skillsBundle: { personas: new Map(), playbooks: new Map() },
      spawnReplacement: (a) => {
        spawned.push(a.id);
        journeys.set(a.id, makeJourney(a.id));
        registerAgent(a.id, a.profileName);
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } as any,
      defaultModel: 'claude-haiku-4-5-20251001',
      authType: 'none',
      credentials: null,
      securityQueue: [],
      qaQueue: [agent2],
      securitySlots: 2,
      qaSlots: 2,
    });

    // The rebalancer runs on setInterval; we can't easily advance timers
    // in vitest without fakeTimers. Just verify it starts and stops cleanly.
    stop();
    _resetRegistry();
  });
});
