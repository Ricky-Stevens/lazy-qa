/**
 * Security playbooks. Each is a deterministic Playwright probe that checks
 * one OWASP-flavoured concern (IDOR, role escalation, session invalidation,
 * client-side storage hygiene, CSRF, open redirect, clickjacking headers,
 * sensitive URL audit). All probes are non-destructive: GET-only for IDOR /
 * role / sensitive paths; CSRF probe issues a POST but with garbage data.
 *
 * On-origin only: every URL is resolved against the current page origin and
 * any cross-origin candidate is skipped (recorded as a non-suspicious step).
 */

import { z } from 'zod';
import { isHostAllowed } from '../safety/guards.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

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

const DEFAULT_ROLE_PATHS = [
  '/admin',
  '/internal',
  '/debug',
  '/api/users',
  '/api/swagger',
  '/.git/HEAD',
  '/api/admin',
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
// 2. role_escalation_probe
// -----------------------------------------------------------------------------

interface RoleEscalationInput {
  paths?: string[];
}

const roleEscalationProbe: Playbook<RoleEscalationInput> = {
  name: 'role_escalation_probe',
  description:
    'Visit a list of paths typically restricted to admins/internal roles and ' +
    'flag any that return 200 with non-error content as suspicious.',
  categories: ['security'],
  estimatedDurationMs: 8000,
  inputShape: {
    paths: z.array(z.string()).optional(),
  },
  async run(input, ctx) {
    const paths = input.paths ?? DEFAULT_ROLE_PATHS;
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
      const isReal = status === 200 && looksLikeRealContent(heading, bodyText);
      steps.push({
        label: `probe ${p}`,
        ok: !isReal,
        detail: `status=${status ?? 'unknown'}`,
      });
      probed.push({ path: p, url: target, status, heading: heading ?? null });
    }
    return buildOutcome(roleEscalationProbe.name, steps, { probed });
  },
};

// -----------------------------------------------------------------------------
// 3. session_invalidation_probe
// -----------------------------------------------------------------------------

const sessionInvalidationProbe: Playbook<Record<string, never>> = {
  name: 'session_invalidation_probe',
  description:
    'Capture the current authed URL, log out (POST /logout), then re-navigate to it. ' +
    'Suspicious if the previously-authed page still loads with a 200.',
  categories: ['security'],
  estimatedDurationMs: 5000,
  inputShape: {},
  async run(_input, ctx) {
    const authedUrl = ctx.page.url();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { authedUrl };

    const logoutUrl = resolveOnOrigin('/logout', authedUrl, ctx.allowedHosts);
    if (!logoutUrl) {
      steps.push({
        label: 'logout',
        ok: true,
        detail: 'could not resolve /logout on origin — skipping',
      });
      return buildOutcome(sessionInvalidationProbe.name, steps, evidence);
    }

    let logoutStatus: number | null = null;
    try {
      const r = await ctx.page.request.post(logoutUrl, { failOnStatusCode: false });
      logoutStatus = r.status();
      steps.push({
        label: 'POST /logout',
        ok: true,
        detail: `status=${logoutStatus}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ label: 'POST /logout', ok: true, detail: `failed: ${message}` });
      evidence.logoutError = message;
      return buildOutcome(sessionInvalidationProbe.name, steps, evidence);
    }
    evidence.logoutStatus = logoutStatus;

    let revisitStatus: number | null = null;
    let landedUrl = '';
    try {
      const resp = await ctx.page.goto(authedUrl, { waitUntil: 'domcontentloaded' });
      revisitStatus = resp?.status() ?? null;
      landedUrl = ctx.page.url();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        label: 'revisit authed url',
        ok: true,
        detail: `navigation failed: ${message}`,
      });
      evidence.revisitError = message;
      return buildOutcome(sessionInvalidationProbe.name, steps, evidence);
    }
    evidence.revisitStatus = revisitStatus;
    evidence.landedUrl = landedUrl;

    const redirectedToLogin = /login|signin|sign-in/i.test(landedUrl);
    const isUnauthorized = revisitStatus === 401 || revisitStatus === 403;
    const sessionInvalidated = redirectedToLogin || isUnauthorized;

    steps.push({
      label: 'revisit authed url',
      ok: sessionInvalidated,
      detail: `status=${revisitStatus ?? 'unknown'} landed=${landedUrl}`,
    });

    return buildOutcome(sessionInvalidationProbe.name, steps, evidence);
  },
};

// -----------------------------------------------------------------------------
// 4. storage_inspect
// -----------------------------------------------------------------------------

const JWT_RE = /^ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\./;
const API_KEY_RE = /^(sk|pk)_[A-Za-z0-9]{20,}/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

interface StorageEntry {
  store: 'localStorage' | 'sessionStorage';
  key: string;
  value: string;
}

const storageInspect: Playbook<Record<string, never>> = {
  name: 'storage_inspect',
  description:
    'Read localStorage + sessionStorage and flag any value matching JWT, API-key, ' +
    'or email patterns as suspicious (PII / credential leakage in browser storage).',
  categories: ['security'],
  estimatedDurationMs: 1000,
  inputShape: {},
  async run(_input, ctx) {
    type RawEntry = { store: 'localStorage' | 'sessionStorage'; key: string; value: string };
    const raw = (await ctx.page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: DOM globals
      const w = globalThis as any;
      const entries: RawEntry[] = [];
      try {
        for (let i = 0; i < w.localStorage.length; i++) {
          const k = w.localStorage.key(i);
          if (k != null) {
            entries.push({
              store: 'localStorage',
              key: k,
              value: String(w.localStorage.getItem(k) ?? ''),
            });
          }
        }
      } catch {}
      try {
        for (let i = 0; i < w.sessionStorage.length; i++) {
          const k = w.sessionStorage.key(i);
          if (k != null) {
            entries.push({
              store: 'sessionStorage',
              key: k,
              value: String(w.sessionStorage.getItem(k) ?? ''),
            });
          }
        }
      } catch {}
      return entries;
    })) as StorageEntry[];

    const steps: PlaybookStep[] = [];
    const findings: Array<{
      store: string;
      key: string;
      kind: 'jwt' | 'api_key' | 'email';
    }> = [];

    for (const entry of raw) {
      const kinds: Array<'jwt' | 'api_key' | 'email'> = [];
      if (JWT_RE.test(entry.value)) kinds.push('jwt');
      if (API_KEY_RE.test(entry.value)) kinds.push('api_key');
      if (EMAIL_RE.test(entry.value)) kinds.push('email');
      if (kinds.length === 0) {
        steps.push({
          label: `${entry.store}.${entry.key}`,
          ok: true,
          detail: 'no sensitive pattern',
        });
        continue;
      }
      for (const k of kinds) {
        findings.push({ store: entry.store, key: entry.key, kind: k });
        steps.push({
          label: `${entry.store}.${entry.key}`,
          ok: false,
          detail: `matches ${k} pattern`,
        });
      }
    }

    return buildOutcome(storageInspect.name, steps, {
      entryCount: raw.length,
      findings,
    });
  },
};

// -----------------------------------------------------------------------------
// 5. csrf_probe
// -----------------------------------------------------------------------------

interface CsrfProbeInput {
  actionUrl: string;
}

const csrfProbe: Playbook<CsrfProbeInput> = {
  name: 'csrf_probe',
  description:
    'POST to a state-changing endpoint with an attacker Referer and empty body. ' +
    'A correctly-protected endpoint rejects (4xx). 2xx is suspicious.',
  categories: ['security'],
  estimatedDurationMs: 2000,
  inputShape: {
    actionUrl: z.string(),
  },
  async run(input, ctx) {
    const target = resolveOnOrigin(input.actionUrl, ctx.page.url(), ctx.allowedHosts);
    if (!target) {
      return buildOutcome(
        csrfProbe.name,
        [
          {
            label: `csrf ${input.actionUrl}`,
            ok: true,
            detail: 'off-origin — refused',
          },
        ],
        { actionUrl: input.actionUrl },
      );
    }

    let status: number | null = null;
    try {
      const resp = await ctx.page.request.post(target, {
        headers: { Referer: 'https://evil.example.com' },
        data: {},
        failOnStatusCode: false,
      });
      status = resp.status();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildOutcome(
        csrfProbe.name,
        [{ label: `POST ${input.actionUrl}`, ok: true, detail: `request failed: ${message}` }],
        { actionUrl: input.actionUrl, error: message },
      );
    }

    const accepted = status >= 200 && status < 300;
    const step: PlaybookStep = {
      label: `POST ${input.actionUrl}`,
      ok: !accepted,
      detail: `status=${status} (referer=evil.example.com)`,
    };
    return buildOutcome(csrfProbe.name, [step], { actionUrl: input.actionUrl, status });
  },
};

// -----------------------------------------------------------------------------
// 6. open_redirect_probe
// -----------------------------------------------------------------------------

interface OpenRedirectInput {
  routeWithRedirect: string;
}

const openRedirectProbe: Playbook<OpenRedirectInput> = {
  name: 'open_redirect_probe',
  description:
    'Navigate to a route that takes a ?redirect= parameter, set it to evil.example.com, ' +
    'and check whether the final URL lands off-origin.',
  categories: ['security'],
  estimatedDurationMs: 4000,
  inputShape: {
    routeWithRedirect: z.string(),
  },
  async run(input, ctx) {
    const evil = 'https://evil.example.com';
    const base = resolveOnOrigin(input.routeWithRedirect, ctx.page.url(), ctx.allowedHosts);
    if (!base) {
      return buildOutcome(
        openRedirectProbe.name,
        [
          {
            label: `open_redirect ${input.routeWithRedirect}`,
            ok: true,
            detail: 'off-origin — refused',
          },
        ],
        { routeWithRedirect: input.routeWithRedirect },
      );
    }

    // Build the URL with the evil redirect query.
    let probeUrl: string;
    try {
      const u = new URL(base);
      u.searchParams.set('redirect', evil);
      probeUrl = u.toString();
    } catch {
      return buildOutcome(
        openRedirectProbe.name,
        [
          {
            label: `open_redirect ${input.routeWithRedirect}`,
            ok: true,
            detail: 'could not construct probe URL',
          },
        ],
        { routeWithRedirect: input.routeWithRedirect },
      );
    }

    let landedUrl = '';
    try {
      await ctx.page.goto(probeUrl, { waitUntil: 'domcontentloaded' });
      landedUrl = ctx.page.url();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Navigation failures may simply mean the redirect went off-origin and
      // failed (we've often blocked external hosts in tests). Be conservative:
      // if the failure URL contains evil.example.com, treat as suspicious.
      const inferredEvil = message.includes('evil.example.com');
      return buildOutcome(
        openRedirectProbe.name,
        [
          {
            label: `open_redirect ${input.routeWithRedirect}`,
            ok: !inferredEvil,
            detail: `navigation error: ${message}`,
          },
        ],
        { routeWithRedirect: input.routeWithRedirect, error: message },
      );
    }

    let landedOffOrigin = false;
    try {
      const landed = new URL(landedUrl);
      landedOffOrigin = landed.hostname === 'evil.example.com';
    } catch {
      landedOffOrigin = false;
    }

    const step: PlaybookStep = {
      label: `open_redirect ${input.routeWithRedirect}`,
      ok: !landedOffOrigin,
      detail: `landed=${landedUrl}`,
    };
    return buildOutcome(openRedirectProbe.name, [step], {
      routeWithRedirect: input.routeWithRedirect,
      probeUrl,
      landedUrl,
    });
  },
};

// -----------------------------------------------------------------------------
// 7. clickjacking_probe
// -----------------------------------------------------------------------------

interface ClickjackingInput {
  url: string;
}

const clickjackingProbe: Playbook<ClickjackingInput> = {
  name: 'clickjacking_probe',
  description:
    'Fetch the URL and inspect response headers for X-Frame-Options or CSP frame-ancestors. ' +
    'Suspicious if both are missing (no clickjacking protection).',
  categories: ['security'],
  estimatedDurationMs: 2000,
  inputShape: {
    url: z.string(),
  },
  async run(input, ctx) {
    const target = resolveOnOrigin(input.url, ctx.page.url(), ctx.allowedHosts);
    if (!target) {
      return buildOutcome(
        clickjackingProbe.name,
        [{ label: `clickjacking ${input.url}`, ok: true, detail: 'off-origin — refused' }],
        { url: input.url },
      );
    }

    let headers: Record<string, string> = {};
    let status: number | null = null;
    try {
      const resp = await ctx.page.request.fetch(target, { failOnStatusCode: false });
      headers = resp.headers();
      status = resp.status();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildOutcome(
        clickjackingProbe.name,
        [{ label: `clickjacking ${input.url}`, ok: true, detail: `fetch failed: ${message}` }],
        { url: input.url, error: message },
      );
    }

    const xfo = headers['x-frame-options'];
    const csp = headers['content-security-policy'] ?? '';
    const hasFrameAncestors = /frame-ancestors\b/i.test(csp);
    const protected_ = Boolean(xfo) || hasFrameAncestors;

    const step: PlaybookStep = {
      label: `clickjacking ${input.url}`,
      ok: protected_,
      detail: `status=${status} xfo=${xfo ?? 'none'} frame-ancestors=${hasFrameAncestors}`,
    };
    return buildOutcome(clickjackingProbe.name, [step], {
      url: input.url,
      status,
      xFrameOptions: xfo ?? null,
      cspFrameAncestors: hasFrameAncestors,
    });
  },
};

// -----------------------------------------------------------------------------
// 8. sensitive_url_audit
// -----------------------------------------------------------------------------

interface SensitiveAuditInput {
  paths?: string[];
}

const sensitiveUrlAudit: Playbook<SensitiveAuditInput> = {
  name: 'sensitive_url_audit',
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
    return buildOutcome(sensitiveUrlAudit.name, steps, { probed });
  },
};

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export {
  clickjackingProbe,
  csrfProbe,
  idorProbe,
  openRedirectProbe,
  resolveOnOrigin,
  roleEscalationProbe,
  sensitiveUrlAudit,
  sessionInvalidationProbe,
  storageInspect,
};

/** Internal helpers exported only for tests. */
export const __internal = {
  resolveOnOrigin,
  replaceIdSegment,
  looksLikeRealContent,
  UUID_RE,
  NUMERIC_ID_RE,
  JWT_RE,
  API_KEY_RE,
  EMAIL_RE,
};

export function registerSecurityPlaybooks(r: PlaybookRegistry): void {
  r.register(idorProbe);
  r.register(roleEscalationProbe);
  r.register(sessionInvalidationProbe);
  r.register(storageInspect);
  r.register(csrfProbe);
  r.register(openRedirectProbe);
  r.register(clickjackingProbe);
  r.register(sensitiveUrlAudit);
}

// Suppress unused-warning for context type by re-exporting nothing — but we
// keep the type imported so downstream code that imports from this module via
// the Playbook generic gets PlaybookContext.
export type { PlaybookContext };
