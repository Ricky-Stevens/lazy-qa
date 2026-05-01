/**
 * Tests for WP3.C — batch mode selection logic in reviewRun.
 *
 * We do NOT call the real Anthropic API. All tests use mock LlmBackend
 * instances passed directly to reviewRun, matching the new backend-first API.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmBackend, LlmCallResult } from '../llm/backend.ts';
import type { Finding } from '../types/finding.ts';

// Import after we've set up our mocks below.
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

const REVIEW_JSON_TEXT = JSON.stringify({
  reviews: [{ id: 'f1', classification: 'confirmed_bug', reasoning: 'Clear evidence.' }],
  clusters: [],
  overallNotes: 'Overall OK.',
});

/** Minimal LlmCallResult that reviewRun can parse. */
function makeLlmCallResult(): LlmCallResult {
  // Cast through unknown to satisfy the Anthropic ContentBlock shape in tests
  // (which requires a `citations` field not needed by this stub).
  const content = [{ type: 'text', text: REVIEW_JSON_TEXT }] as unknown as LlmCallResult['content'];
  return {
    content,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

/** Mock inline-only LlmBackend (kind='api' but no getRawClient — batch won't
 *  be invoked for inline tests). */
function makeInlineBackend(): LlmBackend & { call: ReturnType<typeof vi.fn> } {
  // biome-ignore lint/suspicious/noExplicitAny: vi.fn return type simplification for test stub
  const call = (vi.fn() as any).mockResolvedValue(makeLlmCallResult());
  return { kind: 'api' as const, call };
}

/** Mock ApiLlmBackend for batch tests: kind='api', getRawClient() returns a
 *  stub with messages.batches.{create,retrieve,results}. */
function makeBatchBackend(batchStubs: {
  create: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  results: ReturnType<typeof vi.fn>;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: vi.fn return type simplification for test stub
  const call = vi.fn() as any;
  return {
    kind: 'api' as const,
    call,
    getRawClient: () => ({
      messages: {
        batches: batchStubs,
      },
    }),
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
    const backend = makeInlineBackend();

    await reviewRun({
      runDir,
      backend,
      batchMode: 'inline',
      logger: makeLogger(),
    });

    expect(backend.call).toHaveBeenCalledOnce();
  });

  it('uses batch path when batchMode is "force_batch", regardless of payload size', async () => {
    const findings = [makeMinimalFinding('f1')];
    const runDir = await writeRunFixture(findings);

    const batchCreate = vi.fn().mockResolvedValue({ id: 'batch_abc' });
    const batchRetrieve = vi.fn().mockResolvedValue({ processing_status: 'ended' });
    const batchResultItem = {
      custom_id: 'critic',
      result: {
        type: 'succeeded',
        message: {
          content: [{ type: 'text', text: REVIEW_JSON_TEXT }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    };
    const batchResults = vi.fn().mockResolvedValue(
      (async function* () {
        yield batchResultItem;
      })(),
    );

    const backend = makeBatchBackend({
      create: batchCreate,
      retrieve: batchRetrieve,
      results: batchResults,
    });

    // Stub globalThis.setTimeout to resolve immediately so the 30s poll delay
    // doesn't block the test. We restore it in the finally block.
    const realSetTimeout = globalThis.setTimeout;
    // biome-ignore lint/suspicious/noExplicitAny: deliberate stub for test isolation
    (globalThis as any).setTimeout = (fn: () => void, _delay?: number) => realSetTimeout(fn, 0);
    try {
      await reviewRun({
        runDir,
        // biome-ignore lint/suspicious/noExplicitAny: test stub satisfies the subset of ApiLlmBackend needed
        backend: backend as any,
        batchMode: 'force_batch',
        logger: makeLogger(),
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The batch path was entered: create was called, inline backend.call was not.
    expect(batchCreate).toHaveBeenCalledOnce();
    expect(backend.call).not.toHaveBeenCalled();
  });

  it('uses inline path when batchMode is "auto" and payload is small (< 16 000 chars)', async () => {
    // Single finding with a short description will produce a small payload.
    const findings = [makeMinimalFinding('f1')];
    const runDir = await writeRunFixture(findings);
    const backend = makeInlineBackend();

    await reviewRun({
      runDir,
      backend,
      batchMode: 'auto',
      logger: makeLogger(),
    });

    expect(backend.call).toHaveBeenCalledOnce();
  });
});
