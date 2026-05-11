import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetRegistry,
  registerAgent,
  updateOnAction,
  updateOnTurn,
  setStatus,
  pushNudge,
  consumeNudge,
  getAgentState,
  snapshotAll,
  recordHttpStatus,
  count4xxIn,
  count5xxIn,
  enterProbeMode,
  exitProbeMode,
  isProbing,
  withProbeMode,
  setAgentPause,
  setGlobalPause,
  getEffectivePauseUntil,
} from './registry.ts';

describe('registry', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  describe('registerAgent', () => {
    it('creates an agent with initial state', () => {
      registerAgent('agent-1', 'sheldon');
      const state = getAgentState('agent-1');
      expect(state).toBeDefined();
      expect(state!.agentId).toBe('agent-1');
      expect(state!.profileName).toBe('sheldon');
      expect(state!.status).toBe('starting');
      expect(state!.findingsCount).toBe(0);
    });
  });

  describe('updateOnAction', () => {
    it('transitions from starting to active', () => {
      registerAgent('a1', 'sheldon');
      updateOnAction('a1', { toolName: 'navigate' });
      expect(getAgentState('a1')!.status).toBe('active');
    });

    it('tracks recent tools with ring buffer', () => {
      registerAgent('a1', 'sheldon');
      for (let i = 0; i < 12; i++) {
        updateOnAction('a1', { toolName: `tool-${i}` });
      }
      const state = getAgentState('a1')!;
      expect(state.recentTools.length).toBeLessThanOrEqual(8);
      expect(state.recentTools[state.recentTools.length - 1]).toBe('tool-11');
    });

    it('tracks auth-walled status', () => {
      registerAgent('a1', 'sheldon');
      updateOnAction('a1', { authWalled: true });
      expect(getAgentState('a1')!.authWalled).toBe(true);
      expect(getAgentState('a1')!.status).toBe('auth_walled');
      updateOnAction('a1', { authWalled: false });
      expect(getAgentState('a1')!.authWalled).toBe(false);
      expect(getAgentState('a1')!.status).toBe('active');
    });
  });

  describe('nudge push/consume', () => {
    it('push then consume returns the message', () => {
      registerAgent('a1', 'sheldon');
      pushNudge('a1', 'do something');
      expect(consumeNudge('a1')).toBe('do something');
    });

    it('consume clears the nudge', () => {
      registerAgent('a1', 'sheldon');
      pushNudge('a1', 'msg1');
      consumeNudge('a1');
      expect(consumeNudge('a1')).toBeNull();
    });

    it('second push overwrites first', () => {
      registerAgent('a1', 'sheldon');
      pushNudge('a1', 'msg1');
      pushNudge('a1', 'msg2');
      expect(consumeNudge('a1')).toBe('msg2');
    });

    it('tracks nudge count', () => {
      registerAgent('a1', 'sheldon');
      pushNudge('a1', 'msg1');
      pushNudge('a1', 'msg2');
      expect(getAgentState('a1')!.nudgesReceived).toBe(2);
    });
  });

  describe('probe mode', () => {
    it('enters and exits probe mode', () => {
      registerAgent('a1', 'sheldon');
      expect(isProbing('a1')).toBe(false);
      enterProbeMode('a1');
      expect(isProbing('a1')).toBe(true);
      exitProbeMode('a1');
      expect(isProbing('a1')).toBe(false);
    });

    it('supports nested probe mode', () => {
      registerAgent('a1', 'sheldon');
      enterProbeMode('a1');
      enterProbeMode('a1');
      expect(getAgentState('a1')!.probeDepth).toBe(2);
      exitProbeMode('a1');
      expect(isProbing('a1')).toBe(true);
      exitProbeMode('a1');
      expect(isProbing('a1')).toBe(false);
    });

    it('withProbeMode cleans up on throw', async () => {
      registerAgent('a1', 'sheldon');
      try {
        await withProbeMode('a1', async () => {
          expect(isProbing('a1')).toBe(true);
          throw new Error('boom');
        });
      } catch {
        // expected
      }
      expect(isProbing('a1')).toBe(false);
    });
  });

  describe('HTTP status counting', () => {
    it('excludes speculative statuses from count', () => {
      registerAgent('a1', 'sheldon');
      enterProbeMode('a1');
      recordHttpStatus('a1', 404);
      recordHttpStatus('a1', 500);
      exitProbeMode('a1');
      recordHttpStatus('a1', 500);

      expect(count4xxIn('a1', 60_000)).toBe(0);
      expect(count5xxIn('a1', 60_000)).toBe(1);
      expect(count5xxIn('a1', 60_000, { includeSpeculative: true })).toBe(2);
    });
  });

  describe('snapshotAll', () => {
    it('returns defensive copies', () => {
      registerAgent('a1', 'sheldon');
      updateOnAction('a1', { toolName: 'click' });
      const snap = snapshotAll();
      snap[0]!.recentTools.push('injected');
      expect(getAgentState('a1')!.recentTools).not.toContain('injected');
    });
  });

  describe('pause', () => {
    it('per-agent pause takes the larger value', () => {
      registerAgent('a1', 'sheldon');
      const t1 = Date.now() + 10_000;
      const t2 = Date.now() + 5_000;
      setAgentPause('a1', t1);
      setAgentPause('a1', t2);
      expect(getEffectivePauseUntil('a1').until).toBe(t1);
    });

    it('global pause overrides per-agent when larger', () => {
      registerAgent('a1', 'sheldon');
      const agentPause = Date.now() + 5_000;
      const globalPause = Date.now() + 30_000;
      setAgentPause('a1', agentPause);
      setGlobalPause(globalPause, 'test');
      const result = getEffectivePauseUntil('a1');
      expect(result.until).toBe(globalPause);
      expect(result.reason).toBe('test');
    });
  });
});
