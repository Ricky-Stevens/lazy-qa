/**
 * File playbooks — file_upload_valid, file_upload_invalid, file_download.
 *
 * Uploads use Playwright's setInputFiles with an in-memory buffer (no disk
 * fixtures required). Downloads listen on the page's `download` event for the
 * filename + suggestedFilename + content-disposition response header.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { NetworkAnomaly } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const ACTION_TIMEOUT_MS = 5_000;

interface AttemptResult {
  ok: boolean;
  detail?: string;
}

async function attempt(fn: () => Promise<void>): Promise<AttemptResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function record(steps: PlaybookStep[], label: string, result: AttemptResult): boolean {
  steps.push({ label, ok: result.ok, detail: result.detail });
  return result.ok;
}

async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

async function firstAvailableLocator(
  factories: Array<() => Locator>,
): Promise<Locator | null> {
  for (const factory of factories) {
    try {
      const loc = factory().first();
      if ((await safeCount(loc)) > 0) return loc;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveFileInput(page: Page): Promise<Locator | null> {
  return firstAvailableLocator([
    () => page.locator('input[type="file"]'),
    () => page.locator('[data-testid*="upload"] input'),
    () => page.locator('[role=button][aria-label*=upload i]'),
  ]);
}

async function resolveSubmit(page: Page): Promise<Locator | null> {
  return firstAvailableLocator([
    () => page.locator('button[type="submit"]'),
    () => page.getByRole('button', { name: 'Save' }),
    () => page.getByRole('button', { name: 'Submit' }),
    () => page.getByRole('button', { name: 'Upload' }),
  ]);
}

function isAnomalous(a: NetworkAnomaly): boolean {
  return a.status >= 400 && a.status < 600;
}

async function freshAnomalies(
  ctx: PlaybookContext,
  sinceMs: number,
): Promise<NetworkAnomaly[]> {
  try {
    const model = await ctx.pageModel();
    return model.network.filter((a) => a.ts >= sinceMs && isAnomalous(a));
  } catch {
    return [];
  }
}

function decide(
  playbookName: string,
  summary: string,
  steps: PlaybookStep[],
  evidence: Record<string, unknown>,
  anomalies: NetworkAnomaly[],
): PlaybookOutcome {
  const anyFail = steps.some((s) => !s.ok);
  if (anyFail) {
    const out = fail(playbookName, summary, evidence, steps);
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  if (anomalies.length > 0) {
    const out = suspicious(
      playbookName,
      `${summary} — ${anomalies.length} HTTP error(s) fired during the run`,
      { ...evidence, anomalies },
      steps,
    );
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  return ok(playbookName, summary, evidence, steps);
}

// ─── file_upload_valid ───────────────────────────────────────────────────────

export interface FileUploadValidInput {
  formId: string;
  fileFixture: { content: string; name: string; mime: string };
}

const fileUploadValidShape = {
  formId: z.string(),
  fileFixture: z.object({
    content: z.string(),
    name: z.string(),
    mime: z.string(),
  }),
} satisfies z.ZodRawShape;

export const fileUploadValid: Playbook<FileUploadValidInput> = {
  name: 'file_upload_valid',
  description:
    'Upload a known-good file (in-memory buffer) into the form\'s file input, submit, and verify a success state. Inputs: formId, fileFixture {content, name, mime}.',
  categories: ['file', 'form'],
  estimatedDurationMs: 6_000,
  inputShape: fileUploadValidShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      formId: input.formId,
      fileName: input.fileFixture.name,
      fileMime: input.fileFixture.mime,
      fileBytes: Buffer.byteLength(input.fileFixture.content, 'utf8'),
    };

    const fileInput = await resolveFileInput(ctx.page);
    if (!fileInput) {
      record(steps, 'locate file input', {
        ok: false,
        detail: 'no input[type=file] found',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        fileUploadValid.name,
        `No file input found on form ${input.formId}`,
        steps,
        evidence,
        anomalies,
      );
    }
    record(steps, 'locate file input', { ok: true });

    const setResult = await attempt(async () => {
      await fileInput.setInputFiles({
        name: input.fileFixture.name,
        mimeType: input.fileFixture.mime,
        buffer: Buffer.from(input.fileFixture.content, 'utf8'),
      });
    });
    record(steps, `attach file ${input.fileFixture.name}`, setResult);

    const submit = await resolveSubmit(ctx.page);
    if (submit) {
      const r = await attempt(async () => {
        await submit.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'click submit', r);
    } else {
      // Some upload widgets fire on attach with no separate submit.
      steps.push({ label: 'click submit', ok: true, detail: 'no submit button (auto-upload assumed)' });
    }

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      fileUploadValid.name,
      `Uploaded ${input.fileFixture.name} (${input.fileFixture.mime}) to form ${input.formId}`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── file_upload_invalid ─────────────────────────────────────────────────────

export interface FileUploadInvalidInput {
  formId: string;
}

const fileUploadInvalidShape = {
  formId: z.string(),
} satisfies z.ZodRawShape;

interface BadFixture {
  name: string;
  mime: string;
  content: Buffer;
  description: string;
}

function buildBadFixtures(): BadFixture[] {
  return [
    // 0-byte file.
    {
      name: 'empty.txt',
      mime: 'text/plain',
      content: Buffer.alloc(0),
      description: '0-byte file',
    },
    // Wrong extension renamed: PNG bytes named .pdf.
    {
      name: 'fake.pdf',
      mime: 'application/pdf',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      description: 'PNG bytes renamed to .pdf',
    },
    // Oversized — 5 MB of zeros. Real apps usually cap well below this.
    {
      name: 'oversized.bin',
      mime: 'application/octet-stream',
      content: Buffer.alloc(5 * 1024 * 1024),
      description: '5 MB file',
    },
  ];
}

export const fileUploadInvalid: Playbook<FileUploadInvalidInput> = {
  name: 'file_upload_invalid',
  description:
    'Try uploading a 0-byte file, a wrong-extension renamed file, and an oversized file. Records the form\'s reaction to each. Inputs: formId.',
  categories: ['file', 'form'],
  estimatedDurationMs: 12_000,
  inputShape: fileUploadInvalidShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      formId: input.formId,
      attempts: [] as Array<{ name: string; description: string; rejected: boolean }>,
    };
    const attempts = evidence.attempts as Array<{
      name: string;
      description: string;
      rejected: boolean;
    }>;

    for (const fx of buildBadFixtures()) {
      const fileInput = await resolveFileInput(ctx.page);
      if (!fileInput) {
        record(steps, `attach ${fx.description}`, {
          ok: false,
          detail: 'no input[type=file] found',
        });
        attempts.push({ name: fx.name, description: fx.description, rejected: false });
        continue;
      }
      const setResult = await attempt(async () => {
        await fileInput.setInputFiles({
          name: fx.name,
          mimeType: fx.mime,
          buffer: fx.content,
        });
      });
      record(steps, `attach ${fx.description}`, setResult);

      // Try to submit; capture whether a rejection error/banner appears.
      const submit = await resolveSubmit(ctx.page);
      if (submit) {
        await attempt(async () => {
          await submit.click({ timeout: ACTION_TIMEOUT_MS });
        });
      }
      await ctx.page.waitForTimeout(150).catch(() => {});

      const rejection =
        (await safeCount(
          ctx.page.locator(
            '[role=alert], [aria-invalid="true"], .error, [data-testid*=error], text=/invalid|too large|wrong type|not allowed/i',
          ),
        )) > 0;
      attempts.push({ name: fx.name, description: fx.description, rejected: rejection });
    }

    const allRejected = attempts.every((a) => a.rejected);
    evidence.allRejected = allRejected;

    const anomalies = await freshAnomalies(ctx, startedAt);
    if (!allRejected) {
      const out = suspicious(
        fileUploadInvalid.name,
        `Invalid uploads on ${input.formId}: ${attempts.filter((a) => !a.rejected).length} of ${attempts.length} were not rejected`,
        evidence,
        steps,
      );
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(
      fileUploadInvalid.name,
      `Invalid uploads on ${input.formId}: all ${attempts.length} were rejected`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── file_download ───────────────────────────────────────────────────────────

export interface FileDownloadInput {
  actionLocator: string;
}

const fileDownloadShape = {
  actionLocator: z.string(),
} satisfies z.ZodRawShape;

export const fileDownload: Playbook<FileDownloadInput> = {
  name: 'file_download',
  description:
    'Click the given action locator and listen for a download. Records filename, suggestedFilename, and content-disposition. Inputs: actionLocator (Playwright locator string).',
  categories: ['file'],
  estimatedDurationMs: 8_000,
  inputShape: fileDownloadShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { actionLocator: input.actionLocator };

    let contentDisposition: string | undefined;
    const responseHandler = (
      res: { headers(): Record<string, string>; url(): string },
    ) => {
      const cd =
        res.headers()['content-disposition'] ?? res.headers()['Content-Disposition'];
      if (cd && !contentDisposition) {
        contentDisposition = cd;
        evidence.contentDispositionUrl = res.url();
      }
    };
    ctx.page.on('response', responseHandler);

    try {
      const downloadPromise = ctx.page
        .waitForEvent('download', { timeout: ACTION_TIMEOUT_MS })
        .catch(() => null);

      const target = ctx.page.locator(input.actionLocator).first();
      if ((await safeCount(target)) === 0) {
        record(steps, 'locate download action', {
          ok: false,
          detail: 'action locator did not resolve',
        });
        const anomalies = await freshAnomalies(ctx, startedAt);
        return decide(
          fileDownload.name,
          `Download action ${input.actionLocator} did not resolve`,
          steps,
          evidence,
          anomalies,
        );
      }
      record(steps, 'locate download action', { ok: true });

      const clickResult = await attempt(async () => {
        await target.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'click download', clickResult);

      const download = await downloadPromise;
      if (download) {
        evidence.filename = download.url();
        evidence.suggestedFilename = download.suggestedFilename();
      }
      if (contentDisposition) evidence.contentDisposition = contentDisposition;
      evidence.downloadObserved = !!download;

      const anomalies = await freshAnomalies(ctx, startedAt);
      if (!download) {
        const out = suspicious(
          fileDownload.name,
          `Clicked ${input.actionLocator} but no download event fired within ${ACTION_TIMEOUT_MS}ms`,
          evidence,
          steps,
        );
        out.signals.networkAnomalies = anomalies;
        return out;
      }
      return decide(
        fileDownload.name,
        `Download "${download.suggestedFilename()}" observed`,
        steps,
        evidence,
        anomalies,
      );
    } finally {
      ctx.page.off('response', responseHandler);
    }
  },
};

// ─── Registration ───────────────────────────────────────────────────────────

export function registerFilePlaybooks(r: PlaybookRegistry): void {
  r.register(fileUploadValid);
  r.register(fileUploadInvalid);
  r.register(fileDownload);
}
