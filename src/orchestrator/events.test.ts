import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capString,
  capToolCallInput,
  capToolResultContent,
  type Event,
  type EventPayload,
  EventWriter,
  readEvents,
  replayRun,
} from './events.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

const TEST_RUN_ID = 'test-run-00000000-0000-0000-0000-000000000001';
const AGENT_A = 'agent-aaa';
const AGENT_B = 'agent-bbb';

/** Synthesise a minimal set of events covering every event type. */
function buildTestEvents(): EventPayload[] {
  return [
    {
      type: 'run.start',
      targetUrl: 'https://example.com',
      agentIds: [AGENT_A, AGENT_B],
    },
    {
      type: 'crawl.probe.submit',
      probeId: 'probe-1',
      route: '/dashboard',
      kind: 'http',
    },
    {
      type: 'crawl.probe.result',
      probeId: 'probe-1',
      status: 200,
      ok: true,
      durationMs: 42,
    },
    {
      type: 'crawl.probe.submit',
      probeId: 'probe-2',
      route: '/settings',
      kind: 'affordance',
    },
    {
      type: 'crawl.probe.result',
      probeId: 'probe-2',
      status: null,
      ok: false,
      durationMs: 600,
    },
    {
      type: 'crawl.complete',
      routeCount: 2,
      durationMs: 700,
    },
    {
      type: 'agent.start',
      agentId: AGENT_A,
      profileName: 'curious-newcomer',
      model: 'claude-haiku-4-5',
      budget: { max_turns: 40, max_minutes: 10, max_usd: 1.0 },
    },
    {
      type: 'agent.start',
      agentId: AGENT_B,
      profileName: 'stress-tester',
      model: 'claude-haiku-4-5',
      plannerModel: 'claude-sonnet-4-6',
      budget: { max_turns: 40, max_minutes: 10, max_usd: 1.0 },
    },
    {
      type: 'agent.turn.start',
      agentId: AGENT_A,
      turn: 1,
      modelUsed: 'claude-haiku-4-5',
    },
    {
      type: 'tool.call',
      agentId: AGENT_A,
      turn: 1,
      name: 'mcp__browser__navigate',
      input: { url: 'https://example.com/dashboard' },
    },
    {
      type: 'tool.result',
      agentId: AGENT_A,
      turn: 1,
      name: 'mcp__browser__navigate',
      ok: true,
      content: 'OK navigate(https://example.com/dashboard)',
    },
    {
      type: 'navigate',
      agentId: AGENT_A,
      fromUrl: 'https://example.com',
      toUrl: 'https://example.com/dashboard',
      refused: false,
    },
    {
      type: 'agent.turn.end',
      agentId: AGENT_A,
      turn: 1,
      tokenUsage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      costUsdDelta: 0.0005,
      stopReason: 'tool_use',
    },
    {
      type: 'playbook.outcome',
      agentId: AGENT_A,
      playbookName: 'crud_create_form',
      status: 'ok',
      durationMs: 1200,
      evidence: { formId: 'create-user-form', route: '/dashboard' },
    },
    {
      type: 'finding.report',
      agentId: AGENT_A,
      finding: {
        id: 'finding-001',
        ts: new Date().toISOString(),
        severity: 'major',
        category: 'broken-feature',
        title: '[/dashboard] Save button does nothing',
        description: 'Clicking Save on the create form produces no feedback.',
        stepsToReproduce: ['Open /dashboard', 'Fill form', 'Click Save'],
        expected: 'Record saved and success toast shown',
        actual: 'No visible response',
        route: '/dashboard',
        confidence: 'certain',
        source: 'agent',
      },
    },
    {
      type: 'supervisor.intervention',
      kind: 'no-progress',
      detail: 'Agent agent-bbb has not acted in 65s',
    },
    {
      type: 'agent.end',
      agentId: AGENT_A,
      terminationReason: 'max-turns',
      turns: 1,
      costUsd: 0.0005,
      findingCount: 1,
    },
    {
      type: 'agent.end',
      agentId: AGENT_B,
      terminationReason: 'max-turns',
      turns: 0,
      costUsd: 0,
      findingCount: 0,
    },
    {
      type: 'critic.start',
      findingCount: 1,
      model: 'claude-sonnet-4-6',
    },
    {
      type: 'critic.verdict',
      findingId: 'finding-001',
      verdict: 'confirmed_bug',
    },
    {
      type: 'critic.end',
      totalCostUsd: 0.02,
      durationMs: 3500,
    },
    {
      type: 'run.end',
      totalCostUsd: 0.0205,
      terminationReasons: { [AGENT_A]: 'max-turns', [AGENT_B]: 'max-turns' },
      totalFindings: 1,
    },
  ];
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'regress-events-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('EventWriter + readEvents — round-trip', () => {
  it('writes events and reads them back with monotonic seq', async () => {
    const filepath = path.join(tmpDir, 'events.jsonl');
    const writer = new EventWriter(filepath, TEST_RUN_ID);
    await writer.open();

    const rawEvents = buildTestEvents();
    for (const ev of rawEvents) {
      await writer.write(ev);
    }
    await writer.close();

    const events = await readEvents(filepath);
    expect(events).toHaveLength(rawEvents.length);

    // Sequence numbers must be monotonically increasing starting at 0.
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.seq).toBe(i);
    }

    // Every event must carry the runId.
    for (const ev of events) {
      expect(ev.runId).toBe(TEST_RUN_ID);
    }

    // Every event must have a valid ISO ts.
    for (const ev of events) {
      expect(() => new Date(ev.ts)).not.toThrow();
      expect(new Date(ev.ts).getTime()).toBeGreaterThan(0);
    }
  });

  it('preserves seq order under concurrent writes', async () => {
    const filepath = path.join(tmpDir, 'concurrent.jsonl');
    const writer = new EventWriter(filepath, TEST_RUN_ID);
    await writer.open();

    // Fire 10 writes concurrently — the serial queue must still produce
    // seq 0..9 in the correct order on disk.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writer.write({
          type: 'agent.turn.start',
          agentId: `agent-${i}`,
          turn: i,
          modelUsed: 'claude-haiku-4-5',
        }),
      ),
    );
    await writer.close();

    const events = await readEvents(filepath);
    expect(events).toHaveLength(10);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.seq).toBe(i);
    }
  });

  it('appends to an existing file (open with "a")', async () => {
    const filepath = path.join(tmpDir, 'append.jsonl');

    // First writer — writes 3 events.
    const w1 = new EventWriter(filepath, TEST_RUN_ID);
    await w1.open();
    await w1.write({ type: 'run.start', targetUrl: 'https://x.com', agentIds: ['a'] });
    await w1.write({
      type: 'agent.start',
      agentId: 'a',
      profileName: 'p',
      model: 'm',
      budget: { max_turns: 1, max_minutes: 1, max_usd: 1 },
    });
    await w1.write({
      type: 'agent.end',
      agentId: 'a',
      terminationReason: 'max-turns',
      turns: 0,
      costUsd: 0,
      findingCount: 0,
    });
    await w1.close();

    // Second writer starting at seq 0 again — appended lines will have their
    // own seq but are still readable as JSONL.
    const w2 = new EventWriter(filepath, TEST_RUN_ID);
    await w2.open();
    await w2.write({
      type: 'run.end',
      totalCostUsd: 0,
      terminationReasons: { a: 'max-turns' },
      totalFindings: 0,
    });
    await w2.close();

    const events = await readEvents(filepath);
    expect(events).toHaveLength(4);
    // All are valid JSON objects.
    for (const ev of events) {
      expect(ev.type).toBeTruthy();
    }
  });
});

describe('replayRun — state machine', () => {
  it('round-trips: findings produced by replay match the original input', async () => {
    const filepath = path.join(tmpDir, 'replay.jsonl');
    const writer = new EventWriter(filepath, TEST_RUN_ID);
    await writer.open();
    for (const ev of buildTestEvents()) {
      await writer.write(ev);
    }
    await writer.close();

    const events = await readEvents(filepath);
    const result = replayRun(events);

    expect(result.runId).toBe(TEST_RUN_ID);

    // Should reconstruct both agents.
    expect(result.journeys).toHaveLength(2);

    const journeyA = result.journeys.find((j) => j.agentId === AGENT_A);
    const journeyB = result.journeys.find((j) => j.agentId === AGENT_B);
    expect(journeyA).toBeDefined();
    expect(journeyB).toBeDefined();

    // Agent A had 1 turn, 1 finding, max-turns termination.
    expect(journeyA!.turns).toBe(1);
    expect(journeyA!.terminationReason).toBe('max-turns');
    expect(journeyA!.costUsd).toBe(0.0005);
    expect(journeyA!.findings).toHaveLength(1);
    expect(journeyA!.findings[0]!.id).toBe('finding-001');

    // Global findings list.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.id).toBe('finding-001');
    expect(result.findings[0]!.title).toBe('[/dashboard] Save button does nothing');
  });

  it('handles out-of-order seq by sorting', () => {
    // Build a minimal event set with reversed seq order.
    const events: Event[] = [
      {
        type: 'agent.end',
        ts: new Date().toISOString(),
        seq: 2,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        terminationReason: 'max-turns',
        turns: 1,
        costUsd: 0.001,
        findingCount: 0,
      },
      {
        type: 'agent.start',
        ts: new Date().toISOString(),
        seq: 0,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        profileName: 'p',
        model: 'm',
        budget: { max_turns: 1, max_minutes: 1, max_usd: 1 },
      },
      {
        type: 'run.start',
        ts: new Date().toISOString(),
        seq: 1,
        runId: TEST_RUN_ID,
        targetUrl: 'https://x.com',
        agentIds: [AGENT_A],
      },
    ];

    const result = replayRun(events);
    expect(result.journeys).toHaveLength(1);
    expect(result.journeys[0]!.turns).toBe(1);
    expect(result.journeys[0]!.terminationReason).toBe('max-turns');
  });

  it('deduplicates findings reported multiple times', () => {
    const finding: Event['type'] extends 'finding.report' ? never : never = undefined as never;
    void finding;

    const findingObj = {
      id: 'dup-001',
      ts: new Date().toISOString(),
      severity: 'minor' as const,
      category: 'ux-confusion' as const,
      title: 'Dup finding',
      description: 'desc',
      stepsToReproduce: ['step'],
      expected: 'x',
      actual: 'y',
      confidence: 'likely' as const,
      source: 'agent' as const,
    };

    const events: Event[] = [
      {
        type: 'agent.start',
        ts: new Date().toISOString(),
        seq: 0,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        profileName: 'p',
        model: 'm',
        budget: { max_turns: 1, max_minutes: 1, max_usd: 1 },
      },
      {
        type: 'finding.report',
        ts: new Date().toISOString(),
        seq: 1,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        finding: findingObj,
      },
      {
        type: 'finding.report',
        ts: new Date().toISOString(),
        seq: 2,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        finding: findingObj,
      },
    ];

    const result = replayRun(events);
    // Even though emitted twice, the global findings list has one entry.
    expect(result.findings).toHaveLength(1);
    // Journey.findings also deduped.
    expect(result.journeys[0]!.findings).toHaveLength(1);
  });
});

describe('content size caps', () => {
  it('capString: short strings pass through unchanged', () => {
    const s = 'hello world';
    expect(capString(s, 100)).toBe(s);
  });

  it('capString: truncated strings get the elided suffix', () => {
    const s = 'a'.repeat(200);
    const capped = capString(s, 100);
    expect(capped).toHaveLength('a'.repeat(100).length + '[…100 bytes elided]'.length);
    expect(capped.endsWith('[…100 bytes elided]')).toBe(true);
  });

  it('capToolResultContent: applies 8 KB cap', () => {
    const big = 'x'.repeat(10_000);
    const capped = capToolResultContent(big);
    expect(capped.length).toBeLessThan(10_000);
    expect(capped.includes('[…')).toBe(true);
  });

  it('capToolCallInput: serialises and caps at 4 KB', () => {
    const big = { data: 'y'.repeat(5_000) };
    const capped = capToolCallInput(big);
    expect(capped.length).toBeLessThan(5_100); // 4 KB + suffix
    expect(capped.includes('[…')).toBe(true);
  });

  it('capToolCallInput: handles non-serialisable input gracefully', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = capToolCallInput(circular);
    expect(result).toBe('[unserializable]');
  });

  it('tool.result content is capped when written via EventWriter', async () => {
    const filepath = path.join(tmpDir, 'cap.jsonl');
    const writer = new EventWriter(filepath, TEST_RUN_ID);
    await writer.open();
    const bigContent = 'z'.repeat(20_000);
    await writer.write({
      type: 'tool.result',
      agentId: AGENT_A,
      turn: 1,
      name: 'mcp__browser__snapshot',
      ok: true,
      // Caller is expected to cap before writing; verify cap helper works
      content: capToolResultContent(bigContent),
    });
    await writer.close();

    const events = await readEvents(filepath);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.type !== 'tool.result') throw new Error('wrong type');
    expect(ev.content.length).toBeLessThan(20_000);
    expect(ev.content.includes('[…')).toBe(true);
  });
});

describe('readEvents — edge cases', () => {
  it('returns empty array for empty file', async () => {
    const filepath = path.join(tmpDir, 'empty.jsonl');
    await writeFile(filepath, '', 'utf8');
    const events = await readEvents(filepath);
    expect(events).toHaveLength(0);
  });

  it('skips blank lines', async () => {
    const filepath = path.join(tmpDir, 'blanks.jsonl');
    const line = JSON.stringify({
      type: 'run.start',
      ts: new Date().toISOString(),
      seq: 0,
      runId: TEST_RUN_ID,
      targetUrl: 'https://x.com',
      agentIds: [],
    });
    await writeFile(filepath, `${line}\n\n`, 'utf8');
    const events = await readEvents(filepath);
    expect(events).toHaveLength(1);
  });
});

describe('EventWriter — error handling', () => {
  it('throws on write before open', async () => {
    const filepath = path.join(tmpDir, 'not-opened.jsonl');
    const writer = new EventWriter(filepath, TEST_RUN_ID);
    // Do NOT call open(). The queue promise should reject.
    await expect(writer.write({ type: 'run.start', targetUrl: 'x', agentIds: [] })).rejects.toThrow(
      'EventWriter not open',
    );
  });
});

describe('replayRun — token usage accumulation', () => {
  it('accumulates token usage from agent.turn.end events', () => {
    const events: Event[] = [
      {
        type: 'agent.start',
        ts: new Date().toISOString(),
        seq: 0,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        profileName: 'p',
        model: 'm',
        budget: { max_turns: 5, max_minutes: 5, max_usd: 1 },
      },
      {
        type: 'agent.turn.end',
        ts: new Date().toISOString(),
        seq: 1,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        turn: 1,
        tokenUsage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        costUsdDelta: 0.001,
        stopReason: 'tool_use',
      },
      {
        type: 'agent.turn.end',
        ts: new Date().toISOString(),
        seq: 2,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        turn: 2,
        tokenUsage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 8 },
        costUsdDelta: 0.002,
        stopReason: 'end_turn',
      },
      {
        type: 'agent.end',
        ts: new Date().toISOString(),
        seq: 3,
        runId: TEST_RUN_ID,
        agentId: AGENT_A,
        terminationReason: 'max-turns',
        turns: 2,
        costUsd: 0.003,
        findingCount: 0,
      },
    ];

    const result = replayRun(events);
    const j = result.journeys[0]!;
    expect(j.tokenUsage.input).toBe(300);
    expect(j.tokenUsage.output).toBe(130);
    expect(j.tokenUsage.cacheRead).toBe(30);
    expect(j.tokenUsage.cacheWrite).toBe(13);
  });
});
