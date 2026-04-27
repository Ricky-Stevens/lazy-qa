/**
 * Tests for WP3.C — batch mode selection logic in reviewRun.
 *
 * We do NOT call the real Anthropic API. All tests use stubbed clients or
 * test the exported helper logic directly via the reviewRun function with a
 * mocked client injected via vi.mock.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finding } from '../types/finding.ts';

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK before importing review.ts so the module picks it up.
// ---------------------------------------------------------------------------

const mockInlineCreate = vi.fn();
const mockBatchCreate = vi.fn();
const mockBatchRetrieve = vi.fn();
const mockBatchResults = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockInlineCreate,
        batches: {
          create: mockBatchCreate,
          retrieve: mockBatchRetrieve,
          results: mockBatchResults,
        },
      },
    })),
  };
});

// Import after mocking.
import { reviewRun } from './review.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalFinding(id: string): Finding {
  return {
    id,
    ts: new Date().toISOString(),
    severity: 'minor',
    category: 'other',
    title: `Finding ${id}`,
    description: `Description for ${id}`,
    expected: 'Expected behaviour',
    actual: 'Actual behaviour',
    route: '/test',
    confidence: 'likely',
    stepsToReproduce: ['Step 1'],
    source: 'agent',
  };
}

/** Minimal message response shape (matches Anthropic.Message). */
function makeMessageResponse(): object {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          reviews: [{ id: 'f1', classification: 'confirmed_bug', reasoning: 'Clear evidence.' }],
          clusters: [],
          overallNotes: 'Overall OK.',
        }),
      },
    ],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as never;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'review-test-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeRunFixture(findings: Finding[]): Promise<string> {
  await writeFile(path.join(tmpDir, 'findings.json'), JSON.stringify(findings));
  await mkdir(path.join(tmpDir, 'journeys'), { recursive: true });
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reviewRun — mode selection', () => {
  it('uses inline path when batchMode is "inline", regardless of payload size', async () => {
    const findings = [makeMinimalFinding('f1')];
    const runDir = await writeRunFixture(findings);

    mockInlineCreate.mockResolvedValue(makeMessageResponse());

    await reviewRun({
      runDir,
      apiKey: 'test-key',
      batchMode: 'inline',
      logger: makeLogger(),
    });

    expect(mockInlineCreate).toHaveBeenCalledOnce();
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  it('uses batch path when batchMode is "force_batch", regardless of payload size', async () => {
    const findings = [makeMinimalFinding('f1')];
    const runDir = await writeRunFixture(findings);

    mockBatchCreate.mockResolvedValue({ id: 'batch_abc' });
    mockBatchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    const mockResult = {
      custom_id: 'critic',
      result: { type: 'succeeded', message: makeMessageResponse() },
    };
    mockBatchResults.mockResolvedValue(
      (async function* () {
        yield mockResult;
      })(),
    );

    // Stub globalThis.setTimeout to resolve immediately so the 30s poll delay
    // doesn't block the test. We restore it in the finally block.
    const realSetTimeout = globalThis.setTimeout;
    // biome-ignore lint/suspicious/noExplicitAny: deliberate stub for test isolation
    (globalThis as any).setTimeout = (fn: () => void, _delay?: number) => realSetTimeout(fn, 0);
    try {
      await reviewRun({
        runDir,
        apiKey: 'test-key',
        batchMode: 'force_batch',
        logger: makeLogger(),
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The batch path was entered: create was called, inline was not.
    expect(mockBatchCreate).toHaveBeenCalledOnce();
    expect(mockInlineCreate).not.toHaveBeenCalled();
  });

  it('uses inline path when batchMode is "auto" and payload is small (< 16 000 chars)', async () => {
    // Single finding with a short description will produce a small payload.
    const findings = [makeMinimalFinding('f1')];
    const runDir = await writeRunFixture(findings);

    mockInlineCreate.mockResolvedValue(makeMessageResponse());

    await reviewRun({
      runDir,
      apiKey: 'test-key',
      batchMode: 'auto',
      logger: makeLogger(),
    });

    expect(mockInlineCreate).toHaveBeenCalledOnce();
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });
});
