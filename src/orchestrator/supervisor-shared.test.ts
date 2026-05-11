/**
 * Tests for supervisor-shared.ts — system prompt construction,
 * SupervisorTracker, and shared handler functions.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildSystemPrompt,
  SupervisorTracker,
  handleWait,
  handleEndSession,
  handleNudge,
  handlePause,
  handleBroadcast,
  type SupervisorInput,
} from './supervisor-shared.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeInput(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    backend: {} as SupervisorInput['backend'],
    model: 'claude-sonnet-4-6',
    maxMinutes: 30,
    maxUsd: 5,
    maxTurns: 100,
    abortSignal: new AbortController().signal,
    logger: makeLogger() as unknown as SupervisorInput['logger'],
    authType: 'form',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('includes relogin_session tactic for form auth', () => {
    const prompt = buildSystemPrompt('form');
    expect(prompt).toContain('relogin_session');
  });

  it('excludes relogin_session tactic for none auth', () => {
    const prompt = buildSystemPrompt('none');
    expect(prompt).toContain('relogin_session tactic is unavailable');
  });

  it('includes supervisor role description', () => {
    const prompt = buildSystemPrompt('form');
    expect(prompt).toContain('SUPERVISOR');
  });

  it('includes detection rules', () => {
    const prompt = buildSystemPrompt('form');
    expect(prompt).toContain('AUTH-WALLED');
    expect(prompt).toContain('BACKEND STORM');
    expect(prompt).toContain('NO PROGRESS');
  });

  it('includes stop conditions', () => {
    const prompt = buildSystemPrompt('form');
    expect(prompt).toContain('WHEN TO STOP');
    expect(prompt).toContain('end_session');
  });

  it('includes triangulated storm detection for both auth types', () => {
    const promptForm = buildSystemPrompt('form');
    expect(promptForm).toContain('triangulated');
    expect(promptForm).toContain('TWO OR MORE agents');

    const promptNone = buildSystemPrompt('none');
    expect(promptNone).toContain('triangulated');
    expect(promptNone).toContain('TWO OR MORE agents');
  });
});

// ---------------------------------------------------------------------------
// SupervisorTracker
// ---------------------------------------------------------------------------

describe('SupervisorTracker', () => {
  it('initializes with zero counters', () => {
    const tracker = new SupervisorTracker();
    expect(tracker.reloginCount).toBe(0);
    expect(tracker.nudgeCount).toBe(0);
    expect(tracker.pauseCount).toBe(0);
    expect(tracker.broadcastCount).toBe(0);
    expect(tracker.selfEnded).toBe(false);
  });

  it('defaults endedReason to max-turns', () => {
    const tracker = new SupervisorTracker();
    expect(tracker.endedReason).toBe('max-turns');
  });

  it('toResult produces correct shape', () => {
    const tracker = new SupervisorTracker();
    tracker.reloginCount = 2;
    tracker.nudgeCount = 5;
    tracker.pauseCount = 1;
    tracker.broadcastCount = 3;
    tracker.endedReason = 'all-finished';

    const result = tracker.toResult(10, 0.25);

    expect(result).toEqual({
      turns: 10,
      costUsd: 0.25,
      endedReason: 'all-finished',
      reloginCount: 2,
      nudgeCount: 5,
      pauseCount: 1,
      broadcastCount: 3,
    });
  });

  it('toResult uses passed-in turns and cost', () => {
    const tracker = new SupervisorTracker();
    const result = tracker.toResult(42, 1.23);
    expect(result.turns).toBe(42);
    expect(result.costUsd).toBe(1.23);
  });
});

// ---------------------------------------------------------------------------
// handleWait
// ---------------------------------------------------------------------------

describe('handleWait', () => {
  it('clamps seconds to minimum of 10', async () => {
    const start = Date.now();
    const result = await handleWait({ seconds: 1 });
    expect(result.content[0]!.text).toContain('Waited 10s');
  }, 15_000);

  it('returns text result', async () => {
    const result = await handleWait({ seconds: 10 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// handleEndSession
// ---------------------------------------------------------------------------

describe('handleEndSession', () => {
  it('sets selfEnded on tracker', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    await handleEndSession(input, tracker, { reason: 'all explorers done' });

    expect(tracker.selfEnded).toBe(true);
  });

  it('logs the reason', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    await handleEndSession(input, tracker, { reason: 'all done' });

    expect(input.logger.info).toHaveBeenCalledWith('supervisor.end_session', {
      reason: 'all done',
    });
  });

  it('returns text with reason', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    const result = await handleEndSession(input, tracker, { reason: 'test over' });

    expect(result.content[0]!.text).toContain('test over');
  });
});

// ---------------------------------------------------------------------------
// handleNudge
// ---------------------------------------------------------------------------

describe('handleNudge', () => {
  it('logs the nudge attempt', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    // pushNudge will fail because no agent is registered, but we test logging
    await handleNudge(input, tracker, { agentId: 'agent-1', message: 'try harder' });

    expect(input.logger.info).toHaveBeenCalledWith(
      'supervisor.nudge',
      expect.objectContaining({ agentId: 'agent-1' }),
    );
  });

  it('returns failure message for unregistered agent', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    const result = await handleNudge(input, tracker, {
      agentId: 'nonexistent',
      message: 'hello',
    });

    expect(result.content[0]!.text).toContain('Failed');
    expect(result.content[0]!.text).toContain('nonexistent');
    expect(tracker.nudgeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handlePause
// ---------------------------------------------------------------------------

describe('handlePause', () => {
  it('clamps duration to minimum of 10 seconds', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    const result = await handlePause(input, tracker, { duration_seconds: 1, reason: 'test' });

    expect(result.content[0]!.text).toContain('10s');
    expect(tracker.pauseCount).toBe(1);
  });

  it('clamps duration to maximum of 180 seconds', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    const result = await handlePause(input, tracker, {
      duration_seconds: 999,
      reason: 'test',
    });

    expect(result.content[0]!.text).toContain('180s');
  });

  it('increments pauseCount', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput();

    await handlePause(input, tracker, { duration_seconds: 30, reason: 'storm' });
    await handlePause(input, tracker, { duration_seconds: 30, reason: 'storm 2' });

    expect(tracker.pauseCount).toBe(2);
  });

  it('emits supervisor.intervention event when events writer is provided', async () => {
    const tracker = new SupervisorTracker();
    const events = { write: vi.fn().mockResolvedValue(undefined) };
    const input = makeInput({ events: events as unknown as SupervisorInput['events'] });

    await handlePause(input, tracker, { duration_seconds: 30, reason: 'backend sick' });

    expect(events.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supervisor.intervention',
        kind: 'backend-storm',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleBroadcast
// ---------------------------------------------------------------------------

describe('handleBroadcast', () => {
  it('returns unavailable message when no sharedKnowledge', async () => {
    const tracker = new SupervisorTracker();
    const input = makeInput({ sharedKnowledge: undefined });

    const result = await handleBroadcast(input, tracker, { message: 'hi' });

    expect(result.content[0]!.text).toContain('unavailable');
    expect(tracker.broadcastCount).toBe(0);
  });

  it('increments broadcastCount when sharedKnowledge is available', async () => {
    const tracker = new SupervisorTracker();
    const sharedKnowledge = {
      addBroadcast: vi.fn(),
      snapshot: vi.fn().mockReturnValue({ credentials: [], routes: [], tokens: [], broadcasts: [] }),
    };
    const input = makeInput({
      sharedKnowledge: sharedKnowledge as unknown as SupervisorInput['sharedKnowledge'],
    });

    await handleBroadcast(input, tracker, { message: 'creds found' });

    expect(tracker.broadcastCount).toBe(1);
    expect(sharedKnowledge.addBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'creds found',
        issuedBy: 'supervisor',
      }),
    );
  });

  it('passes forProfile when specified', async () => {
    const tracker = new SupervisorTracker();
    const sharedKnowledge = {
      addBroadcast: vi.fn(),
      snapshot: vi.fn().mockReturnValue({ credentials: [], routes: [], tokens: [], broadcasts: [] }),
    };
    const input = makeInput({
      sharedKnowledge: sharedKnowledge as unknown as SupervisorInput['sharedKnowledge'],
    });

    await handleBroadcast(input, tracker, {
      message: 'special message',
      for_profile: 'bobby-tables',
    });

    expect(sharedKnowledge.addBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        forProfile: 'bobby-tables',
      }),
    );
  });

  it('emits team.broadcast event', async () => {
    const tracker = new SupervisorTracker();
    const events = { write: vi.fn().mockResolvedValue(undefined) };
    const sharedKnowledge = { addBroadcast: vi.fn() };
    const input = makeInput({
      sharedKnowledge: sharedKnowledge as unknown as SupervisorInput['sharedKnowledge'],
      events: events as unknown as SupervisorInput['events'],
    });

    await handleBroadcast(input, tracker, { message: 'intel update' });

    expect(events.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'team.broadcast',
        message: 'intel update',
      }),
    );
  });
});
