import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import type { LoopInput } from './loop.ts';
import { runAgentLoopSdk } from './loop-sdk.ts';

// Test-controlled list of assistant messages the mock query() will yield, in
// order, pulling one user message from the streaming-input generator before
// each. Set this in each test before calling runAgentLoopSdk.
let mockTurns: Array<{
  content: Array<{ type: string; text: string }>;
  stopReason: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  async function* fakeQuery({ prompt }: { prompt: AsyncIterable<unknown> }) {
    const it = prompt[Symbol.asyncIterator]();
    for (const turn of mockTurns) {
      // Pull a user message from the streaming prompt — same as the real SDK
      // does before each assistant turn. This exercises the streaming-input
      // pump: a single test turn proves nothing about multi-turn behaviour.
      const next = await it.next();
      if (next.done) break;
      yield {
        type: 'assistant',
        message: {
          content: turn.content,
          stop_reason: turn.stopReason,
          usage: {
            input_tokens: turn.usage.input,
            output_tokens: turn.usage.output,
            cache_read_input_tokens: turn.usage.cacheRead,
            cache_creation_input_tokens: turn.usage.cacheWrite,
          },
        },
      };
    }
    yield {
      type: 'result',
      subtype: 'success',
      result: 'done',
    };
  }
  return {
    query: vi
      .fn()
      .mockImplementation((args: { prompt: AsyncIterable<unknown> }) => fakeQuery(args)),
    createSdkMcpServer: vi.fn().mockReturnValue({ name: 'mock', version: '1.0.0', tools: [] }),
    tool: vi.fn().mockImplementation((name, description, shape, handler) => ({
      name,
      description,
      shape,
      handler,
    })),
  };
});

function makeJourney(): Journey {
  return {
    runId: 'r1',
    agentId: 'a1',
    startUrl: 'http://localhost:3000',
    startedAt: new Date().toISOString(),
    turns: 0,
    findings: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  } as Journey;
}

function makeAgent(): ResolvedAgent {
  return {
    id: 'a1',
    profileName: 'tester',
    model: 'claude-haiku-4-5-20251001',
    personality: 'a tester',
    budget: { max_turns: 5, max_minutes: 5, max_usd: 1 },
    credentials: null,
  } as ResolvedAgent;
}

function makeLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeBaseInput(journey: Journey, events?: { write: ReturnType<typeof vi.fn> }): LoopInput {
  return {
    agent: makeAgent(),
    targetUrl: 'http://localhost:3000',
    systemPrompt: 'you are a tester',
    apiKey: '',
    rawTools: [],
    journey,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    siteMap: {
      listAllRoutes: () => [],
      listUnvisitedRoutes: () => [],
      listFormsUntested: () => [],
      listTablesUntested: () => [],
      listModalsUntested: () => [],
      getPageModel: () => null,
    } as unknown,
    summaryMemory: { add: vi.fn(), serialize: () => '' } as unknown,
    memoryEnabled: false,
    memoryPath: '/tmp',
    events: events as unknown,
  } as unknown as LoopInput;
}

describe('runAgentLoopSdk', () => {
  it('runs a single-turn query and accumulates token usage on the journey', async () => {
    mockTurns = [
      {
        content: [{ type: 'text', text: 'hello' }],
        stopReason: 'end_turn',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    const journey = makeJourney();
    const input = makeBaseInput(journey);

    await runAgentLoopSdk(input);

    expect(journey.tokenUsage.input).toBe(100);
    expect(journey.tokenUsage.output).toBe(50);
    expect(journey.terminationReason).toBeDefined();
  });

  it('emits agent.turn.start AND agent.turn.end per turn', async () => {
    mockTurns = [
      {
        content: [{ type: 'text', text: 'turn 1' }],
        stopReason: 'end_turn',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    const journey = makeJourney();
    const events = { write: vi.fn().mockResolvedValue(undefined) };
    const input = makeBaseInput(journey, events);

    await runAgentLoopSdk(input);

    const types = events.write.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('agent.turn.start');
    expect(types).toContain('agent.turn.end');
    // Exactly one of each for the single mocked assistant turn — proves we
    // emit per-turn (not just once outside the loop).
    expect(types.filter((t) => t === 'agent.turn.start')).toHaveLength(1);
    expect(types.filter((t) => t === 'agent.turn.end')).toHaveLength(1);
  });

  it('pumps the streaming-input generator for multi-turn runs', async () => {
    // Three turns. The async-generator `prompts()` in loop-sdk must be pulled
    // three times by the SDK; if the generator returned early after turn 1
    // (a regression we want to catch), only one assistant message would
    // process and journey.turns would be 1, not 3.
    mockTurns = [
      {
        content: [{ type: 'text', text: 'turn 1' }],
        stopReason: 'tool_use',
        usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 },
      },
      {
        content: [{ type: 'text', text: 'turn 2' }],
        stopReason: 'tool_use',
        usage: { input: 110, output: 35, cacheRead: 50, cacheWrite: 0 },
      },
      {
        content: [{ type: 'text', text: 'turn 3' }],
        stopReason: 'end_turn',
        usage: { input: 120, output: 40, cacheRead: 100, cacheWrite: 0 },
      },
    ];
    const journey = makeJourney();
    const events = { write: vi.fn().mockResolvedValue(undefined) };
    const input = makeBaseInput(journey, events);

    await runAgentLoopSdk(input);

    expect(journey.turns).toBe(3);
    expect(journey.tokenUsage.input).toBe(330); // 100 + 110 + 120
    expect(journey.tokenUsage.output).toBe(105); // 30 + 35 + 40
    expect(journey.tokenUsage.cacheRead).toBe(150); // 0 + 50 + 100

    // Three start events, three end events — proves per-turn emission.
    const types = events.write.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types.filter((t) => t === 'agent.turn.start')).toHaveLength(3);
    expect(types.filter((t) => t === 'agent.turn.end')).toHaveLength(3);
  });
});
