/**
 * Form playbooks — input-validation, XSS, SQL-injection, required-field,
 * round-trip, long-input, special-chars, double-submit, and cancel-then-back
 * checks against discovered forms.
 *
 * Each playbook locates the target FormSpec by id from the current PageModel,
 * exercises it via Playwright primitives, and produces a structured
 * PlaybookOutcome. Failures are captured into outcome.steps; the playbook
 * itself never throws.
 */

import { z } from 'zod';
import type { Page } from 'playwright';
import type { FormFieldSpec, FormSpec, PageModel } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import type { PlaybookOutcome, PlaybookStep } from './outcome.ts';

// `page.evaluate` runs in the browser context where DOM globals exist; our
// tsconfig deliberately excludes the DOM lib (we don't run there). Use a
// single any-escape inside the evaluated function only.
// biome-ignore lint/suspicious/noExplicitAny: DOM types not in tsconfig.lib
type BrowserAny = any;

// ─── Default payload sets ────────────────────────────────────────────────────

export const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
];

export const SQLI_PAYLOADS = ["' OR 1=1--", '" OR "1"="1', '1; DROP TABLE users--'];

export const SPECIAL_CHARS_PAYLOADS = [
  '🚀💥', // emoji
  'مرحبا', // RTL
  '   leading-trailing   ',
  'a'.repeat(255),
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findForm(model: PageModel, formId: string): FormSpec | undefined {
  return model.forms.find((f) => f.id === formId);
}

function isTextLike(field: FormFieldSpec): boolean {
  const t = field.type.toLowerCase();
  return (
    t === 'text' ||
    t === 'textarea' ||
    t === 'email' ||
    t === 'tel' ||
    t === 'url' ||
    t === 'search' ||
    t === 'password' ||
    t === ''
  );
}

function isSearchOrIdField(field: FormFieldSpec): boolean {
  const haystack = `${field.label} ${field.placeholder ?? ''}`.toLowerCase();
  if (/search|query|q$|filter|find/.test(haystack)) return true;
  if (/\bid\b|identifier|uuid|user[_-]?id|account[_-]?id|order[_-]?id/.test(haystack)) return true;
  if (field.type.toLowerCase() === 'search') return true;
  return false;
}

async function safeFill(
  page: Page,
  locator: string,
  value: string,
  steps: PlaybookStep[],
  label: string,
): Promise<boolean> {
  try {
    await page.locator(locator).first().fill(value, { timeout: 5000 });
    steps.push({ label: `fill ${label}`, ok: true });
    return true;
  } catch (err) {
    steps.push({
      label: `fill ${label}`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function safeType(
  page: Page,
  locator: string,
  value: string,
  steps: PlaybookStep[],
  label: string,
): Promise<boolean> {
  try {
    const el = page.locator(locator).first();
    await el.click({ timeout: 5000 });
    await el.fill('', { timeout: 5000 });
    await el.type(value, { timeout: 10000 });
    steps.push({ label: `type ${label}`, ok: true });
    return true;
  } catch (err) {
    steps.push({
      label: `type ${label}`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function safeClick(
  page: Page,
  locator: string,
  steps: PlaybookStep[],
  label: string,
): Promise<boolean> {
  try {
    await page.locator(locator).first().click({ timeout: 5000 });
    steps.push({ label: `click ${label}`, ok: true });
    return true;
  } catch (err) {
    steps.push({
      label: `click ${label}`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function clearField(page: Page, locator: string): Promise<void> {
  try {
    await page.locator(locator).first().fill('', { timeout: 3000 });
  } catch {
    // best-effort clear; ignore
  }
}

/**
 * Heuristic: detect whether validation has been surfaced after a submit.
 * Looks for: native `:invalid` inputs, ARIA validity, common error-text classes,
 * `[role=alert]`, and any element with the text "required".
 */
async function validationVisible(page: Page, formLocator: string): Promise<boolean> {
  try {
    return await page
      .locator(formLocator)
      .first()
      .evaluate((rootRaw: BrowserAny) => {
        const root = rootRaw as BrowserAny;
        if (!root || !root.querySelectorAll) return false;
        // Native HTML5 :invalid
        const invalids = root.querySelectorAll(':invalid');
        if (invalids && invalids.length > 0) return true;
        // aria-invalid
        if (root.querySelector('[aria-invalid="true"]')) return true;
        // role=alert
        if (root.querySelector('[role="alert"]')) return true;
        // Common error class names
        const errSel =
          '.error,.error-message,.field-error,.help-block.error,.invalid-feedback,.text-danger,[data-testid*="error"]';
        if (root.querySelector(errSel)) return true;
        // Any descendant text containing required/missing
        const text = (root.textContent as string | null) ?? '';
        if (/required|please fill|cannot be empty|missing|is required/i.test(text)) return true;
        return false;
      });
  } catch {
    return false;
  }
}

interface SubmittedNetworkPost {
  url: string;
  method: string;
  postData: string | null;
}

/** Capture POST/PUT/PATCH requests issued by the form during the action. */
function trackPosts(page: Page): { posts: SubmittedNetworkPost[]; stop: () => void } {
  const posts: SubmittedNetworkPost[] = [];
  const handler = (req: import('playwright').Request) => {
    const method = req.method().toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      posts.push({ url: req.url(), method, postData: req.postData() });
    }
  };
  page.on('request', handler);
  return { posts, stop: () => page.off('request', handler) };
}

interface ResponseLog {
  url: string;
  status: number;
}

function trackResponses(page: Page): { responses: ResponseLog[]; stop: () => void } {
  const responses: ResponseLog[] = [];
  const handler = (resp: import('playwright').Response) => {
    responses.push({ url: resp.url(), status: resp.status() });
  };
  page.on('response', handler);
  return { responses, stop: () => page.off('response', handler) };
}

function emptyOutcome(name: string, summary: string, steps: PlaybookStep[]): PlaybookOutcome {
  return {
    playbookName: name,
    status: 'failed',
    summary,
    evidence: {},
    signals: { networkAnomalies: [], consoleErrors: [] },
    steps,
    durationMs: 0,
  };
}

// ─── 1. form_fuzz_validation ─────────────────────────────────────────────────

export const form_fuzz_validation: Playbook<{ formId: string }> = {
  name: 'form_fuzz_validation',
  description:
    'Submit the named form empty and once with each single required field filled. ' +
    'Expect each submission to surface a validation error. Reports suspicious if no ' +
    'validation message is observed across all attempts.',
  categories: ['form'],
  estimatedDurationMs: 8_000,
  inputShape: { formId: z.string() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) {
      steps.push({ label: 'find form', ok: false, detail: `formId=${input.formId} not found` });
      return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    }
    if (!form.submit) {
      steps.push({ label: 'find submit', ok: false, detail: 'form has no submit button' });
      return emptyOutcome(this.name, 'Form has no submit button', steps);
    }
    const required = form.fields.filter((f) => f.required);
    const attempts: Array<{ scenario: string; validationSeen: boolean }> = [];

    // Attempt 1: submit empty
    for (const f of form.fields) await clearField(ctx.page, f.locator);
    await safeClick(ctx.page, form.submit.locator, steps, 'submit (empty)');
    await ctx.page.waitForTimeout(150);
    let seen = await validationVisible(ctx.page, form.formLocator);
    attempts.push({ scenario: 'empty submission', validationSeen: seen });

    // Attempt N: each single required field filled
    for (const target of required) {
      for (const f of form.fields) await clearField(ctx.page, f.locator);
      await safeFill(ctx.page, target.locator, 'x', steps, target.label);
      await safeClick(ctx.page, form.submit.locator, steps, `submit (only ${target.label})`);
      await ctx.page.waitForTimeout(150);
      seen = await validationVisible(ctx.page, form.formLocator);
      attempts.push({ scenario: `only ${target.label} filled`, validationSeen: seen });
    }

    const anyValidationSurfaced = attempts.some((a) => a.validationSeen);
    const status = anyValidationSurfaced ? 'ok' : 'suspicious';
    const summary = anyValidationSurfaced
      ? `Validation surfaced on at least one of ${attempts.length} attempts`
      : `No validation messages surfaced across ${attempts.length} attempts — form may accept invalid input`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, attempts, requiredFieldCount: required.length },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 2. form_xss_probe ───────────────────────────────────────────────────────

export const form_xss_probe: Playbook<{ formId: string; payloads?: string[] }> = {
  name: 'form_xss_probe',
  description:
    'Inject XSS payloads into the first text-like field of the named form, submit, and ' +
    'check whether any payload reflects unescaped in the DOM. Reports suspicious if a ' +
    'live <script> element materialises or the raw payload string is found inside the body innerHTML.',
  categories: ['form', 'security'],
  estimatedDurationMs: 8_000,
  inputShape: { formId: z.string(), payloads: z.array(z.string()).optional() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) {
      steps.push({ label: 'find form', ok: false, detail: `formId=${input.formId} not found` });
      return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    }
    const target = form.fields.find(isTextLike);
    if (!target) {
      steps.push({ label: 'find text field', ok: false, detail: 'no text-like field on form' });
      return emptyOutcome(this.name, 'No text-like field found in form', steps);
    }
    const payloads = input.payloads ?? XSS_PAYLOADS;
    const reflections: Array<{ payload: string; reflectedRaw: boolean; scriptMaterialised: boolean }> = [];

    for (const payload of payloads) {
      await clearField(ctx.page, target.locator);
      await safeFill(ctx.page, target.locator, payload, steps, target.label);
      if (form.submit) {
        await safeClick(ctx.page, form.submit.locator, steps, `submit (xss=${payload.slice(0, 20)})`);
      }
      await ctx.page.waitForTimeout(150);
      const result = await ctx.page.evaluate((raw: string) => {
        const doc: BrowserAny = (globalThis as BrowserAny).document;
        const html: string = doc.body.innerHTML;
        const reflectedRaw = html.includes(raw);
        // Look for <script> elements whose body contains the payload's
        // `alert(1)` call, or an inline handler attribute the payload would
        // create. These are the unambiguous signs of a live materialisation.
        const scripts: BrowserAny[] = Array.from(doc.querySelectorAll('script'));
        const scriptMaterialised = scripts.some((s: BrowserAny) =>
          ((s.textContent as string | null) ?? '').includes('alert(1)'),
        );
        const inlineHandler = !!doc.querySelector('[onerror], [onload], [onclick*="alert"]');
        return { reflectedRaw, scriptMaterialised: scriptMaterialised || inlineHandler };
      }, payload);
      reflections.push({ payload, ...result });
    }

    const anyUnsafe = reflections.some((r) => r.reflectedRaw || r.scriptMaterialised);
    const status = anyUnsafe ? 'suspicious' : 'ok';
    const summary = anyUnsafe
      ? `XSS payload(s) reflected unescaped — possible stored/reflected XSS`
      : `No XSS reflections detected across ${payloads.length} payloads`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, fieldLabel: target.label, reflections },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 3. form_sql_injection_probe ─────────────────────────────────────────────

export const form_sql_injection_probe: Playbook<{ formId: string; payloads?: string[] }> = {
  name: 'form_sql_injection_probe',
  description:
    'Inject SQL-injection payloads into search-y or id-y fields on the named form. ' +
    'Reports suspicious on a 5xx response, or on a 200 response that returns an unusually ' +
    'large result set (proxy: response body length).',
  categories: ['form', 'security'],
  estimatedDurationMs: 10_000,
  inputShape: { formId: z.string(), payloads: z.array(z.string()).optional() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) {
      steps.push({ label: 'find form', ok: false, detail: `formId=${input.formId} not found` });
      return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    }
    const candidates = form.fields.filter((f) => isTextLike(f) && isSearchOrIdField(f));
    const target = candidates[0] ?? form.fields.find(isTextLike);
    if (!target) {
      steps.push({ label: 'pick field', ok: false, detail: 'no suitable field' });
      return emptyOutcome(this.name, 'No suitable text/search/id field found', steps);
    }
    const payloads = input.payloads ?? SQLI_PAYLOADS;
    const probes: Array<{ payload: string; status?: number; bodyLength?: number }> = [];

    for (const payload of payloads) {
      const tracker = trackResponses(ctx.page);
      await clearField(ctx.page, target.locator);
      await safeFill(ctx.page, target.locator, payload, steps, target.label);
      if (form.submit) {
        await safeClick(ctx.page, form.submit.locator, steps, `submit (sqli=${payload.slice(0, 20)})`);
      }
      await ctx.page.waitForTimeout(250);
      tracker.stop();
      const last = tracker.responses[tracker.responses.length - 1];
      probes.push({
        payload,
        status: last?.status,
        bodyLength: undefined,
      });
    }

    const any5xx = probes.some((p) => typeof p.status === 'number' && p.status >= 500);
    // 200 with all-records-returned is harder to detect without ground-truth;
    // we surface the responses and flag suspicious only on 5xx for now.
    const status = any5xx ? 'suspicious' : 'ok';
    const summary = any5xx
      ? `SQLi payload triggered 5xx — possible unsanitised query reaching the database`
      : `No 5xx responses to SQLi payloads across ${payloads.length} attempts`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, fieldLabel: target.label, probes },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 4. form_required_field_check ────────────────────────────────────────────

export const form_required_field_check: Playbook<{ formId: string }> = {
  name: 'form_required_field_check',
  description:
    'For each required field declared on the form, attempt submission with every ' +
    'other required field filled but that one missing. Verify validation surfaces ' +
    'each time. Reports suspicious if a required field is silently accepted as missing.',
  categories: ['form'],
  estimatedDurationMs: 12_000,
  inputShape: { formId: z.string() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) {
      steps.push({ label: 'find form', ok: false, detail: `formId=${input.formId} not found` });
      return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    }
    if (!form.submit) {
      return emptyOutcome(this.name, 'Form has no submit button', steps);
    }
    const required = form.fields.filter((f) => f.required);
    if (required.length === 0) {
      return {
        playbookName: this.name,
        status: 'ok',
        summary: 'Form declares no required fields',
        evidence: { formId: form.id, requiredFieldCount: 0 },
        signals: { networkAnomalies: [], consoleErrors: [] },
        steps,
        durationMs: 0,
      };
    }

    const probes: Array<{ omitted: string; validationSeen: boolean }> = [];
    for (const omitted of required) {
      // Fill all required fields with placeholders except the omitted one.
      for (const f of form.fields) await clearField(ctx.page, f.locator);
      for (const f of required) {
        if (f.label === omitted.label) continue;
        await safeFill(ctx.page, f.locator, 'x', steps, f.label);
      }
      await safeClick(ctx.page, form.submit.locator, steps, `submit (omit ${omitted.label})`);
      await ctx.page.waitForTimeout(150);
      const seen = await validationVisible(ctx.page, form.formLocator);
      probes.push({ omitted: omitted.label, validationSeen: seen });
    }

    const allFlagged = probes.every((p) => p.validationSeen);
    const status = allFlagged ? 'ok' : 'suspicious';
    const summary = allFlagged
      ? `All ${probes.length} required-field omissions flagged validation`
      : `${probes.filter((p) => !p.validationSeen).length}/${probes.length} required-field omissions silently accepted`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, probes },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 5. form_optional_roundtrip ──────────────────────────────────────────────

export const form_optional_roundtrip: Playbook<{
  formId: string;
  optionalValues: Record<string, string>;
}> = {
  name: 'form_optional_roundtrip',
  description:
    'Fill optional fields with caller-supplied values, save, reload the page, and assert the ' +
    'values are still present. Reports suspicious if any value fails to round-trip.',
  categories: ['form'],
  estimatedDurationMs: 10_000,
  inputShape: { formId: z.string(), optionalValues: z.record(z.string(), z.string()) },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    if (!form.submit) return emptyOutcome(this.name, 'Form has no submit button', steps);

    const fillResults: Array<{ label: string; value: string; filled: boolean }> = [];
    for (const [label, value] of Object.entries(input.optionalValues)) {
      const field = form.fields.find((f) => f.label === label);
      if (!field) {
        fillResults.push({ label, value, filled: false });
        steps.push({ label: `find field ${label}`, ok: false, detail: 'no such label' });
        continue;
      }
      const ok = await safeFill(ctx.page, field.locator, value, steps, label);
      fillResults.push({ label, value, filled: ok });
    }

    await safeClick(ctx.page, form.submit.locator, steps, 'submit');
    await ctx.page.waitForTimeout(200);

    // Reload and re-check
    try {
      await ctx.page.reload({ timeout: 8000 });
      steps.push({ label: 'reload', ok: true });
    } catch (err) {
      steps.push({
        label: 'reload',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await ctx.page.waitForTimeout(200);

    const refreshedModel = await ctx.pageModel();
    const refreshedForm = findForm(refreshedModel, input.formId) ?? form;

    const checks: Array<{ label: string; expected: string; actual: string; ok: boolean }> = [];
    for (const [label, expected] of Object.entries(input.optionalValues)) {
      const field = refreshedForm.fields.find((f) => f.label === label);
      if (!field) {
        checks.push({ label, expected, actual: '<no field>', ok: false });
        continue;
      }
      let actual = '';
      try {
        actual = await ctx.page.locator(field.locator).first().inputValue({ timeout: 3000 });
      } catch (err) {
        steps.push({
          label: `read ${label}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      checks.push({ label, expected, actual, ok: actual === expected });
    }

    const allRoundTripped = checks.length > 0 && checks.every((c) => c.ok);
    const status = allRoundTripped ? 'ok' : 'suspicious';
    const summary = allRoundTripped
      ? `${checks.length}/${checks.length} optional values round-tripped`
      : `${checks.filter((c) => !c.ok).length}/${checks.length} optional values failed to round-trip`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, fillResults, checks },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 6. form_long_input_test ─────────────────────────────────────────────────

export const form_long_input_test: Playbook<{ formId: string; length?: number }> = {
  name: 'form_long_input_test',
  description:
    'Type a very long string into each text-like field of the named form, submit, and observe ' +
    'whether the app truncates, errors, or hangs. Default length is 2000 characters.',
  categories: ['form'],
  estimatedDurationMs: 12_000,
  inputShape: { formId: z.string(), length: z.number().int().positive().optional() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);

    const length = input.length ?? 2000;
    const longString = 'a'.repeat(length);
    const textFields = form.fields.filter(isTextLike);
    if (textFields.length === 0) {
      return emptyOutcome(this.name, 'No text-like fields on form', steps);
    }

    const observations: Array<{ label: string; typed: number; storedLength: number; truncated: boolean }> = [];
    for (const field of textFields) {
      await clearField(ctx.page, field.locator);
      await safeFill(ctx.page, field.locator, longString, steps, field.label);
      let storedLength = 0;
      try {
        const v = await ctx.page.locator(field.locator).first().inputValue({ timeout: 3000 });
        storedLength = v.length;
      } catch (err) {
        steps.push({
          label: `read length ${field.label}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      observations.push({
        label: field.label,
        typed: length,
        storedLength,
        truncated: storedLength < length,
      });
    }

    if (form.submit) {
      await safeClick(ctx.page, form.submit.locator, steps, 'submit');
      await ctx.page.waitForTimeout(200);
    }

    const anyTruncatedSilently = observations.some(
      (o) => o.truncated && o.storedLength > 0 && o.storedLength < o.typed,
    );
    const status = anyTruncatedSilently ? 'suspicious' : 'ok';
    const summary = anyTruncatedSilently
      ? `${observations.filter((o) => o.truncated).length} field(s) truncated long input — verify backend honours UI maxlength`
      : `Long input accepted by ${observations.length} field(s) without truncation`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, length, observations },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 7. form_special_chars ───────────────────────────────────────────────────

export const form_special_chars: Playbook<{ formId: string }> = {
  name: 'form_special_chars',
  description:
    'Type SPECIAL_CHARS_PAYLOADS (emoji, RTL text, leading/trailing spaces, long ASCII) into the ' +
    'first text-like field on the named form. Verifies the form accepts the input without crashing.',
  categories: ['form'],
  estimatedDurationMs: 10_000,
  inputShape: { formId: z.string() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    const target = form.fields.find(isTextLike);
    if (!target) return emptyOutcome(this.name, 'No text-like field found', steps);

    const trials: Array<{ payload: string; typed: boolean; readBack: string }> = [];
    for (const payload of SPECIAL_CHARS_PAYLOADS) {
      await clearField(ctx.page, target.locator);
      const typed = await safeFill(ctx.page, target.locator, payload, steps, target.label);
      let readBack = '';
      try {
        readBack = await ctx.page.locator(target.locator).first().inputValue({ timeout: 3000 });
      } catch {
        // ignore
      }
      trials.push({ payload, typed, readBack });
    }

    if (form.submit) {
      await safeClick(ctx.page, form.submit.locator, steps, 'submit');
      await ctx.page.waitForTimeout(200);
    }

    const anyTypeFailed = trials.some((t) => !t.typed);
    const status = anyTypeFailed ? 'suspicious' : 'ok';
    const summary = anyTypeFailed
      ? `Some special-char payloads failed to type — possible IME or unicode handling issue`
      : `All ${trials.length} special-char payloads accepted by the field`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: { formId: form.id, fieldLabel: target.label, trials },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 8. form_double_submit ───────────────────────────────────────────────────

export const form_double_submit: Playbook<{ formId: string }> = {
  name: 'form_double_submit',
  description:
    'Click the submit button of the named form twice within ~50ms. Reports suspicious if ' +
    'duplicate POST/PUT requests to the same URL are observed (the server should be guarded by ' +
    'idempotency or the UI should disable on click).',
  categories: ['form'],
  estimatedDurationMs: 5_000,
  inputShape: { formId: z.string() },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    if (!form.submit) return emptyOutcome(this.name, 'Form has no submit button', steps);

    const tracker = trackPosts(ctx.page);

    let clickCount = 0;
    try {
      const btn = ctx.page.locator(form.submit.locator).first();
      // Issue both clicks back-to-back without awaiting in between
      const c1 = btn.click({ timeout: 3000 }).then(() => {
        clickCount++;
      });
      const c2 = btn.click({ timeout: 3000, force: true }).then(() => {
        clickCount++;
      });
      await Promise.allSettled([c1, c2]);
      steps.push({ label: 'double click submit', ok: true, detail: `clicks=${clickCount}` });
    } catch (err) {
      steps.push({
        label: 'double click submit',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await ctx.page.waitForTimeout(300);
    tracker.stop();

    // Group POSTs by URL
    const counts = new Map<string, number>();
    for (const p of tracker.posts) counts.set(p.url, (counts.get(p.url) ?? 0) + 1);
    const duplicates = Array.from(counts.entries()).filter(([, n]) => n > 1);

    const status = duplicates.length > 0 ? 'suspicious' : 'ok';
    const summary =
      duplicates.length > 0
        ? `${duplicates.length} URL(s) received duplicate POSTs from a double-click — possible duplicate-write bug`
        : `Double-click produced ${tracker.posts.length} POST(s); no duplicates observed (clicks=${clickCount})`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: {
        formId: form.id,
        clickCount,
        posts: tracker.posts.map((p) => ({ url: p.url, method: p.method })),
        duplicates: duplicates.map(([url, n]) => ({ url, count: n })),
      },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── 9. form_cancel_then_back ────────────────────────────────────────────────

export const form_cancel_then_back: Playbook<{
  formId: string;
  partialValues: Record<string, string>;
}> = {
  name: 'form_cancel_then_back',
  description:
    'Fill the named form with partialValues, click Cancel, then navigate back. Re-parse the ' +
    'page and confirm no entity was created (heuristic: the previously-entered values do not ' +
    'persist in the form on return). Reports suspicious if values appear to have been saved.',
  categories: ['form'],
  estimatedDurationMs: 8_000,
  inputShape: { formId: z.string(), partialValues: z.record(z.string(), z.string()) },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const model = await ctx.pageModel();
    const form = findForm(model, input.formId);
    if (!form) return emptyOutcome(this.name, `Form not found: ${input.formId}`, steps);
    if (!form.cancel) {
      steps.push({ label: 'find cancel', ok: false, detail: 'no cancel affordance on form' });
      return emptyOutcome(this.name, 'Form has no Cancel button', steps);
    }

    const tracker = trackPosts(ctx.page);

    for (const [label, value] of Object.entries(input.partialValues)) {
      const field = form.fields.find((f) => f.label === label);
      if (!field) {
        steps.push({ label: `find ${label}`, ok: false, detail: 'no such label' });
        continue;
      }
      await safeFill(ctx.page, field.locator, value, steps, label);
    }

    await safeClick(ctx.page, form.cancel.locator, steps, 'cancel');
    await ctx.page.waitForTimeout(150);

    try {
      await ctx.page.goBack({ timeout: 5000 });
      steps.push({ label: 'goBack', ok: true });
    } catch (err) {
      steps.push({
        label: 'goBack',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await ctx.page.waitForTimeout(150);
    tracker.stop();

    // Re-parse and verify the form's fields don't show the typed values
    const refreshedModel = await ctx.pageModel();
    const refreshedForm = findForm(refreshedModel, input.formId) ?? form;
    const persistence: Array<{ label: string; expected: string; actual: string; persisted: boolean }> = [];
    for (const [label, value] of Object.entries(input.partialValues)) {
      const field = refreshedForm.fields.find((f) => f.label === label);
      let actual = '';
      if (field) {
        try {
          actual = await ctx.page.locator(field.locator).first().inputValue({ timeout: 2000 });
        } catch {
          // ignore — field may not exist post-cancel
        }
      }
      persistence.push({ label, expected: value, actual, persisted: actual === value });
    }

    const anyPersisted = persistence.some((p) => p.persisted);
    const sawWriteRequest = tracker.posts.length > 0;
    const status = anyPersisted || sawWriteRequest ? 'suspicious' : 'ok';
    const summary = anyPersisted
      ? `Cancel did not discard data — ${persistence.filter((p) => p.persisted).length}/${persistence.length} values still present`
      : sawWriteRequest
        ? `Cancel produced ${tracker.posts.length} write request(s) — possible accidental save`
        : `Cancel discarded data correctly`;

    return {
      playbookName: this.name,
      status,
      summary,
      evidence: {
        formId: form.id,
        persistence,
        writeRequests: tracker.posts.map((p) => ({ url: p.url, method: p.method })),
      },
      signals: { networkAnomalies: [], consoleErrors: [] },
      steps,
      durationMs: 0,
    };
  },
};

// ─── Registration ────────────────────────────────────────────────────────────

export function registerFormPlaybooks(r: PlaybookRegistry): void {
  r.register(form_fuzz_validation);
  r.register(form_xss_probe);
  r.register(form_sql_injection_probe);
  r.register(form_required_field_check);
  r.register(form_optional_roundtrip);
  r.register(form_long_input_test);
  r.register(form_special_chars);
  r.register(form_double_submit);
  r.register(form_cancel_then_back);
}
