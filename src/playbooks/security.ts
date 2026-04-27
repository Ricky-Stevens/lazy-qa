/**
 * Security playbooks — 3 probes:
 *   - `idor_probe`: walk a numeric resource ID range and detect access to records the agent shouldn't see.
 *   - `header_audit`: fetch paths and inspect security-related response headers.
 *   - `sensitive_path_audit`: probe well-known sensitive paths (e.g. /admin, /.env, /api/keys) with the agent's session and flag 200 OK responses.
 *
 * All probes resolve candidate URLs via `resolveOnOrigin(candidate, currentUrl, allowedHosts)` so they cannot drift to off-allowlist hosts even if a redirect lands the agent there.
 */

import { z } from 'zod';
import { isHostAllowed } from '../safety/guards.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUMERIC_ID_RE = /\/\d+(\/|$)/;

const DEFAULT_IDOR_CANDIDATES = [
  '1',
  '0',
  '-1',
  '99999',
  'abc',
  'admin',
  '00000000-0000-0000-0000-000000000001',
];

const DEFAULT_SENSITIVE_PATHS = [
  '/admin',
  '/internal',
  '/debug',
  '/api/users',
  '/api/swagger',
  '/.git/HEAD',
  '/robots.txt',
  '/sitemap.xml',
  '/api/admin',
  '/.env',
  '/backup',
];

/** Resolve a candidate URL/path against the run's allowed hosts. Returns
 * the resolved absolute URL when on-allowlist, or `null` when the
 * resolved URL would land off-allowlist. The `currentUrl` argument is
 * used only as the base for relative-path resolution — it does NOT
 * define the allowlist. */
function resolveOnOrigin(
  candidate: string,
  currentUrl: string,
  allowedHosts: string[],
): string | null {
  let absolute: URL;
  try {
    absolute = new URL(candidate, currentUrl);
  } catch {
    return null;
  }
  return isHostAllowed(absolute.toString(), allowedHosts) ? absolute.toString() : null;
}

/** Replace the id segment in a route. UUID match takes precedence; falls back
 * to first numeric segment. Returns null if no recognisable id segment. */
function replaceIdSegment(routeWithId: string, candidate: string): string | null {
  const uuidMatch = routeWithId.match(UUID_RE);
  if (uuidMatch) {
    return routeWithId.replace(UUID_RE, candidate);
  }
  const numMatch = routeWithId.match(NUMERIC_ID_RE);
  if (numMatch) {
    // Replace just the digits, preserve trailing slash if present.
    const trail = numMatch[1];
    return routeWithId.replace(NUMERIC_ID_RE, `/${candidate}${trail}`);
  }
  return null;
}

/** Heuristic: does the page text look like a real (non-error) page? */
function looksLikeRealContent(headingText: string | null, bodyText: string): boolean {
  const heading = (headingText ?? '').trim();
  if (!heading) return false;
  const lower = heading.toLowerCase();
  if (lower.includes('not found') || lower.includes('error') || lower.includes('forbidden')) {
    return false;
  }
  // Defensive: consider body content too — pages with only "Error" body are not real.
  const bodyLower = bodyText.toLowerCase();
  if (bodyLower.length < 20 && (bodyLower.includes('error') || bodyLower.includes('not found'))) {
    return false;
  }
  return true;
}

function buildOutcome(
  name: string,
  steps: PlaybookStep[],
  evidence: Record<string, unknown>,
): PlaybookOutcome {
  const suspiciousSteps = steps.filter((s) => !s.ok);
  if (suspiciousSteps.length > 0) {
    return suspicious(
      name,
      `${suspiciousSteps.length} suspicious result(s) of ${steps.length}`,
      evidence,
      steps,
    );
  }
  return {
    playbookName: name,
    status: 'ok',
    summary: `No issues detected across ${steps.length} probe(s)`,
    evidence,
    signals: { networkAnomalies: [], consoleErrors: [] },
    steps,
    durationMs: 0,
  };
}

// -----------------------------------------------------------------------------
// Header audit helpers
// -----------------------------------------------------------------------------

const CRITICAL_HEADERS = [
  {
    name: 'anti-clickjacking',
    satisfiers: ['x-frame-options', 'content-security-policy'],
    cspToken: 'frame-ancestors' as const,
  },
  { name: 'hsts', satisfiers: ['strict-transport-security'], httpsOnly: true as const },
];

const NICE_TO_HAVE_HEADERS = [
  'x-content-type-options',
  'referrer-policy',
  'content-security-policy',
];

function auditHeaders(
  headers: Record<string, string>,
  isHttps: boolean,
): { missingCritical: string[]; missingNiceToHave: string[] } {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;

  const missingCritical: string[] = [];
  for (const c of CRITICAL_HEADERS) {
    if ('httpsOnly' in c && c.httpsOnly && !isHttps) continue;
    let satisfied = false;
    for (const sat of c.satisfiers) {
      const v = lc[sat];
      if (!v) continue;
      if ('cspToken' in c && c.cspToken && sat === 'content-security-policy') {
        if (v.toLowerCase().includes(c.cspToken)) {
          satisfied = true;
          break;
        }
      } else {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) missingCritical.push(c.name);
  }

  const missingNiceToHave = NICE_TO_HAVE_HEADERS.filter((h) => !lc[h]);
  return { missingCritical, missingNiceToHave };
}

// -----------------------------------------------------------------------------
// 1. idor_probe
// -----------------------------------------------------------------------------

interface IdorProbeInput {
  routeWithId: string;
  candidates?: string[];
}

const idorProbe: Playbook<IdorProbeInput> = {
  name: 'idor_probe',
  description:
    'Probe a route containing an id segment (numeric or UUID) by navigating to ' +
    'common guessed ids and recording the response status + page heading. ' +
    'Flags any 200 that returns non-error content as suspicious (likely IDOR).',
  categories: ['security'],
  estimatedDurationMs: 8000,
  inputShape: {
    routeWithId: z.string(),
    candidates: z.array(z.string()).optional(),
  },
  async run(input, ctx) {
    const candidates = input.candidates ?? DEFAULT_IDOR_CANDIDATES;
    const steps: PlaybookStep[] = [];
    const perCandidate: Array<Record<string, unknown>> = [];

    if (!UUID_RE.test(input.routeWithId) && !NUMERIC_ID_RE.test(input.routeWithId)) {
      steps.push({
        label: `no id segment found in ${input.routeWithId}`,
        ok: true,
        detail: 'skipping — route does not contain a recognisable id segment',
      });
      return buildOutcome(idorProbe.name, steps, { candidates: perCandidate });
    }

    for (const candidate of candidates) {
      const probedRoute = replaceIdSegment(input.routeWithId, candidate);
      if (!probedRoute) {
        steps.push({
          label: `skip ${candidate}`,
          ok: true,
          detail: 'could not substitute id segment',
        });
        continue;
      }
      const targetUrl = resolveOnOrigin(probedRoute, ctx.page.url(), ctx.allowedHosts);
      if (!targetUrl) {
        steps.push({
          label: `skip ${candidate}`,
          ok: true,
          detail: 'off-origin — refused',
        });
        continue;
      }
      let status: number | null = null;
      let heading: string | null = null;
      let bodyText = '';
      try {
        const resp = await ctx.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        status = resp?.status() ?? null;
        heading = await ctx.page
          .locator('h1, h2')
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => null);
        bodyText =
          (await ctx.page
            .locator('body')
            .textContent({ timeout: 1000 })
            .catch(() => '')) ?? '';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          label: `probe ${candidate}`,
          ok: true,
          detail: `navigation failed: ${message}`,
        });
        perCandidate.push({ candidate, error: message });
        continue;
      }
      const isReal = status === 200 && looksLikeRealContent(heading, bodyText);
      steps.push({
        label: `probe ${candidate}`,
        ok: !isReal,
        detail: `status=${status ?? 'unknown'} heading=${(heading ?? '').slice(0, 60)}`,
      });
      perCandidate.push({
        candidate,
        url: targetUrl,
        status,
        heading: heading ?? null,
      });
    }

    return buildOutcome(idorProbe.name, steps, {
      routeWithId: input.routeWithId,
      candidates: perCandidate,
    });
  },
};

// -----------------------------------------------------------------------------
// 2. header_audit
// -----------------------------------------------------------------------------

const headerAuditShape = {
  paths: z.array(z.string()).min(1),
} satisfies z.ZodRawShape;

export interface HeaderAuditInput {
  paths: string[];
}

const headerAudit: Playbook<HeaderAuditInput> = {
  name: 'header_audit',
  description:
    'Fetch a list of paths and inspect their response headers for hardening posture: X-Frame-Options OR CSP `frame-ancestors`, Strict-Transport-Security, X-Content-Type-Options=nosniff, Referrer-Policy, basic CSP presence. Status: `suspicious` if any path is missing critical headers; `ok` otherwise. Probes paths under `target.allowed_hosts` only; off-allowlist paths are skipped (recorded as evidence).',
  categories: ['security'],
  estimatedDurationMs: 4000,
  inputShape: headerAuditShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { paths: input.paths, results: [] as unknown[] };
    const results = evidence.results as Array<{
      path: string;
      url: string | null;
      status: number | null;
      missingCritical: string[];
      missingNiceToHave: string[];
      skipped?: 'off-allowlist' | 'fetch-failed';
    }>;

    const currentUrl = ctx.page.url();

    for (const path of input.paths) {
      const url = resolveOnOrigin(path, currentUrl, ctx.allowedHosts);
      if (url === null) {
        results.push({
          path,
          url: null,
          status: null,
          missingCritical: [],
          missingNiceToHave: [],
          skipped: 'off-allowlist',
        });
        steps.push({ label: `${path} → skipped (off-allowlist)`, ok: true });
        continue;
      }
      try {
        const resp = await ctx.page.request.get(url, { timeout: 5_000, failOnStatusCode: false });
        const headers = resp.headers();
        const isHttps = url.startsWith('https://');
        const { missingCritical, missingNiceToHave } = auditHeaders(headers, isHttps);
        results.push({ path, url, status: resp.status(), missingCritical, missingNiceToHave });
        steps.push({
          label: `${path} → ${resp.status()}; missing critical: [${missingCritical.join(', ') || 'none'}]`,
          ok: missingCritical.length === 0,
        });
      } catch (err) {
        results.push({
          path,
          url,
          status: null,
          missingCritical: [],
          missingNiceToHave: [],
          skipped: 'fetch-failed',
        });
        steps.push({
          label: `${path} → fetch failed`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const anyMissing = results.some((r) => r.missingCritical.length > 0);
    if (anyMissing) {
      return suspicious(
        headerAudit.name,
        `Missing critical security headers on ${results.filter((r) => r.missingCritical.length > 0).length}/${results.length} path(s).`,
        evidence,
        steps,
      );
    }
    return ok(
      headerAudit.name,
      `All ${results.filter((r) => !r.skipped).length} path(s) carry the audited critical headers.`,
      evidence,
      steps,
    );
  },
};

// -----------------------------------------------------------------------------
// 3. sensitive_path_audit
// -----------------------------------------------------------------------------

interface SensitiveAuditInput {
  paths?: string[];
}

const sensitivePathAudit: Playbook<SensitiveAuditInput> = {
  name: 'sensitive_path_audit',
  description:
    'Probe a broader list of often-forgotten sensitive paths (.git, .env, /backup, /api/swagger, ' +
    '/robots.txt, /sitemap.xml, etc.) and flag any that return 200 with non-error content.',
  categories: ['security'],
  estimatedDurationMs: 10000,
  inputShape: {
    paths: z.array(z.string()).optional(),
  },
  async run(input, ctx) {
    const paths = input.paths ?? DEFAULT_SENSITIVE_PATHS;
    const steps: PlaybookStep[] = [];
    const probed: Array<Record<string, unknown>> = [];
    for (const p of paths) {
      const target = resolveOnOrigin(p, ctx.page.url(), ctx.allowedHosts);
      if (!target) {
        steps.push({ label: `skip ${p}`, ok: true, detail: 'off-origin — refused' });
        continue;
      }
      let status: number | null = null;
      let heading: string | null = null;
      let bodyText = '';
      try {
        const resp = await ctx.page.goto(target, { waitUntil: 'domcontentloaded' });
        status = resp?.status() ?? null;
        heading = await ctx.page
          .locator('h1, h2')
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => null);
        bodyText =
          (await ctx.page
            .locator('body')
            .textContent({ timeout: 1000 })
            .catch(() => '')) ?? '';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({ label: `probe ${p}`, ok: true, detail: `navigation failed: ${message}` });
        probed.push({ path: p, error: message });
        continue;
      }
      // For non-HTML resources (.git/HEAD, robots.txt, .env), heading is rarely
      // populated. Treat any 200 on the explicit "leaky" paths as suspicious
      // even without heading content.
      const explicitlyLeaky =
        p.includes('.git') || p.includes('.env') || p === '/backup' || p.includes('swagger');
      const isReal = status === 200 && (looksLikeRealContent(heading, bodyText) || explicitlyLeaky);
      steps.push({
        label: `probe ${p}`,
        ok: !isReal,
        detail: `status=${status ?? 'unknown'}`,
      });
      probed.push({ path: p, url: target, status, heading: heading ?? null });
    }
    return buildOutcome(sensitivePathAudit.name, steps, { probed });
  },
};

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export { headerAudit, idorProbe, resolveOnOrigin, sensitivePathAudit };

/** Internal helpers exported only for tests. */
export const __internal = {
  resolveOnOrigin,
  auditHeaders,
  replaceIdSegment,
  looksLikeRealContent,
  UUID_RE,
  NUMERIC_ID_RE,
};

export function registerSecurityPlaybooks(r: PlaybookRegistry): void {
  r.register(idorProbe);
  r.register(headerAudit);
  r.register(sensitivePathAudit);
}

// Suppress unused-warning for context type by re-exporting nothing — but we
// keep the type imported so downstream code that imports from this module via
// the Playbook generic gets PlaybookContext.
export type { PlaybookContext };
