/**
 * Tests for findings-server.ts — CTF noise filter, auth-provider noise filter,
 * rate limiting, dedup, end_session verification, and share_with_team logic.
 *
 * We exercise these by calling createHarnessMcpServer and invoking the raw
 * tool handlers directly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { createHarnessMcpServer, type HarnessServerInput } from './findings-server.ts';

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
  } as unknown as Logger;
}

function makeJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    agentId: 'test-agent',
    profileName: 'tester',
    model: 'claude-haiku-4-5',
    startedAt: new Date().toISOString(),
    turns: [],
    findings: [],
    costUsd: 0,
    ...overrides,
  } as Journey;
}

function makeValidFindingArgs(overrides: Record<string, unknown> = {}) {
  return {
    severity: 'major',
    category: 'broken-feature',
    title: 'Button does not work on /dashboard',
    description: 'The submit button is non-functional when clicked; nothing happens.',
    stepsToReproduce: ['Navigate to /dashboard', 'Click Submit'],
    expected: 'Form submits',
    actual: 'Nothing happens',
    route: '/dashboard',
    confidence: 'certain',
    ...overrides,
  };
}

function getReportFindingHandler(rawTools: Array<{ name: string; handler: Function }>) {
  const tool = rawTools.find((t) => t.name === 'report_finding');
  if (!tool) throw new Error('report_finding tool not found');
  return tool.handler;
}

function getEndSessionHandler(rawTools: Array<{ name: string; handler: Function }>) {
  const tool = rawTools.find((t) => t.name === 'end_session');
  if (!tool) throw new Error('end_session tool not found');
  return tool.handler;
}

function getShareWithTeamHandler(rawTools: Array<{ name: string; handler: Function }>) {
  const tool = rawTools.find((t) => t.name === 'share_with_team');
  if (!tool) throw new Error('share_with_team tool not found');
  return tool.handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createHarnessMcpServer', () => {
  it('returns mcpServer and rawTools', () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { mcpServer, rawTools } = createHarnessMcpServer({ journey, logger });

    expect(mcpServer).toBeDefined();
    expect(rawTools).toBeInstanceOf(Array);
    expect(rawTools.length).toBeGreaterThanOrEqual(3);
  });

  it('includes report_finding, share_with_team, and end_session tools', () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({ journey, logger });

    const names = rawTools.map((t) => t.name);
    expect(names).toContain('report_finding');
    expect(names).toContain('share_with_team');
    expect(names).toContain('end_session');
  });
});

describe('report_finding', () => {
  it('records a valid finding in the journey', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({ journey, logger });
    const handler = getReportFindingHandler(rawTools);

    const result = await handler(makeValidFindingArgs());

    expect(journey.findings).toHaveLength(1);
    expect(journey.findings[0]!.title).toBe('Button does not work on /dashboard');
    expect(result.content[0].text).toContain('Finding recorded');
  });

  it('assigns id and timestamp to finding', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({ journey, logger });
    const handler = getReportFindingHandler(rawTools);

    await handler(makeValidFindingArgs());

    const finding = journey.findings[0]!;
    expect(finding.id).toBeDefined();
    expect(finding.ts).toBeDefined();
    expect(finding.source).toBe('agent');
  });

  describe('CTF noise filter', () => {
    it('rejects findings with "challenge solved" in title', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const { rawTools } = createHarnessMcpServer({ journey, logger });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(
        makeValidFindingArgs({
          title: 'Juice Shop challenge solved! Exposed Metrics',
        }),
      );

      expect(journey.findings).toHaveLength(0);
      expect(result.content[0].text).toContain('NOT A BUG');
      expect(result.content[0].text).toContain('gamification');
    });

    it('rejects findings with "challenge triggered" in description', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const { rawTools } = createHarnessMcpServer({ journey, logger });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(
        makeValidFindingArgs({
          description:
            'When visiting /admin, a challenge triggered notification appeared saying XSS completed.',
        }),
      );

      expect(journey.findings).toHaveLength(0);
      expect(result.content[0].text).toContain('NOT A BUG');
    });

    it('allows normal findings through', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const { rawTools } = createHarnessMcpServer({ journey, logger });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(makeValidFindingArgs());

      expect(journey.findings).toHaveLength(1);
      expect(result.content[0].text).toContain('Finding recorded');
    });
  });

  describe('auth provider noise filter', () => {
    it('rejects findings about auth0 returning 400', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const { rawTools } = createHarnessMcpServer({ journey, logger });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(
        makeValidFindingArgs({
          route: 'https://myapp.auth0.com/u/login',
          title: 'Auth0 login page returns 400 Bad Request',
          description:
            'The Auth0 login page returns a 400 bad request error when accessed directly.',
        }),
      );

      expect(journey.findings).toHaveLength(0);
      expect(result.content[0].text).toContain('NOT A BUG');
      expect(result.content[0].text).toContain('OAuth');
    });

    it('allows findings on non-auth routes', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const { rawTools } = createHarnessMcpServer({ journey, logger });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(
        makeValidFindingArgs({
          route: '/dashboard',
          title: 'Dashboard returns 400 Bad Request',
          description: 'The dashboard page shows a 400 bad request error.',
        }),
      );

      expect(journey.findings).toHaveLength(1);
    });
  });

  describe('rate limiting', () => {
    it('throttles after 8 findings in 60s window', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const { rawTools } = createHarnessMcpServer({ journey, logger });
      const handler = getReportFindingHandler(rawTools);

      // File 8 findings
      for (let i = 0; i < 8; i++) {
        await handler(
          makeValidFindingArgs({
            title: `Bug ${i} on /page-${i}`,
            description: `Description for bug number ${i} that is long enough to pass validation`,
            route: `/page-${i}`,
          }),
        );
      }
      expect(journey.findings).toHaveLength(8);

      // 9th finding should be throttled
      const result = await handler(
        makeValidFindingArgs({
          title: 'Bug 9 should be throttled',
          description: 'This ninth finding should be throttled by the rate limiter.',
          route: '/page-9',
        }),
      );

      expect(journey.findings).toHaveLength(8); // Not 9
      expect(result.content[0].text).toContain('THROTTLED');
    });
  });

  describe('within-agent dedup', () => {
    it('rejects duplicate findings when findingCache detects dups', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const findingCache = {
        findWithinAgentDuplicate: vi.fn().mockReturnValue({
          title: 'Original bug',
          severity: 'major',
          route: '/page',
        }),
        add: vi.fn(),
        matchesFalsePositive: vi.fn().mockReturnValue(null),
      };
      const { rawTools } = createHarnessMcpServer({
        journey,
        logger,
        findingCache: findingCache as any,
      });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(makeValidFindingArgs());

      expect(journey.findings).toHaveLength(0);
      expect(result.content[0].text).toContain('THROTTLED');
      expect(result.content[0].text).toContain('Original bug');
    });
  });

  describe('false positive suppression', () => {
    it('rejects findings matching known false positives', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const findingCache = {
        findWithinAgentDuplicate: vi.fn().mockReturnValue(null),
        add: vi.fn(),
        matchesFalsePositive: vi.fn().mockReturnValue({
          reason: 'Known Auth0 callback noise',
        }),
      };
      const { rawTools } = createHarnessMcpServer({
        journey,
        logger,
        findingCache: findingCache as any,
      });
      const handler = getReportFindingHandler(rawTools);

      const result = await handler(makeValidFindingArgs());

      expect(journey.findings).toHaveLength(0);
      expect(result.content[0].text).toContain('NOT A BUG');
      expect(result.content[0].text).toContain('false-positive');
    });
  });

  describe('screenshot capture', () => {
    it('auto-captures screenshot for critical findings', async () => {
      const journey = makeJourney();
      const logger = makeLogger();
      const mockPage = {
        url: vi.fn().mockReturnValue('http://localhost:3000/bug'),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
      };
      const { rawTools } = createHarnessMcpServer({
        journey,
        logger,
        getPage: () => mockPage as any,
        runDir: '/tmp/run',
      });
      const handler = getReportFindingHandler(rawTools);

      await handler(makeValidFindingArgs({ severity: 'critical' }));

      expect(journey.findings[0]!.filedAtUrl).toBe('http://localhost:3000/bug');
    });
  });
});

describe('end_session', () => {
  it('sets terminationReason and endedAt on journey', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({ journey, logger });
    const handler = getEndSessionHandler(rawTools);

    await handler({
      reason: 'auth_wall',
      detail: 'Redirected to login page at https://app.auth0.com/u/login',
    });

    expect(journey.terminationReason).toBe('end_session');
    expect(journey.endedAt).toBeDefined();
  });

  it('rejects auth_wall claim when page is not on login URL', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const mockPage = {
      url: vi.fn().mockReturnValue('http://localhost:3000/dashboard'),
    };
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      getPage: () => mockPage as any,
    });
    const handler = getEndSessionHandler(rawTools);

    const result = await handler({
      reason: 'auth_wall',
      detail: 'I think I am auth walled because...',
    });

    expect(result.content[0].text).toContain('REJECTED');
    expect(journey.terminationReason).toBeUndefined();
  });

  it('accepts auth_wall claim when page is on login URL', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const mockPage = {
      url: vi.fn().mockReturnValue('https://myapp.auth0.com/u/login'),
    };
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      getPage: () => mockPage as any,
    });
    const handler = getEndSessionHandler(rawTools);

    const result = await handler({
      reason: 'auth_wall',
      detail: 'Redirected to Auth0 login page, cannot continue.',
    });

    expect(result.content[0].text).toContain('Session ended');
    expect(journey.terminationReason).toBe('end_session');
  });

  it('rejects site_unreachable when browser is alive', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const mockPage = {
      url: vi.fn().mockReturnValue('http://localhost:3000'),
    };
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      getPage: () => mockPage as any,
    });
    const handler = getEndSessionHandler(rawTools);

    const result = await handler({
      reason: 'site_unreachable',
      detail: 'Cannot reach the site, all requests fail.',
    });

    expect(result.content[0].text).toContain('REJECTED');
    expect(journey.terminationReason).toBeUndefined();
  });

  it('accepts browser_dead when getPage throws', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      getPage: () => {
        throw new Error('page is dead');
      },
    });
    const handler = getEndSessionHandler(rawTools);

    const result = await handler({
      reason: 'browser_dead',
      detail: 'Cannot interact with the browser at all.',
    });

    expect(result.content[0].text).toContain('Session ended');
  });
});

describe('share_with_team', () => {
  it('returns unavailable when no sharedKnowledge configured', async () => {
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({ journey, logger });
    const handler = getShareWithTeamHandler(rawTools);

    const result = await handler({
      kind: 'credentials',
      username: 'admin',
      password: 'admin123',
      source: 'SQLi dump from /rest/products',
    });

    expect(result.content[0].text).toContain('unavailable');
  });

  it('requires username and password for credentials kind', async () => {
    const sharedKnowledge = {
      addCredential: vi.fn().mockReturnValue(true),
      addRoute: vi.fn().mockReturnValue(true),
      addToken: vi.fn().mockReturnValue(true),
    };
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      sharedKnowledge: sharedKnowledge as any,
    });
    const handler = getShareWithTeamHandler(rawTools);

    const result = await handler({
      kind: 'credentials',
      source: 'some source text',
    });

    expect(result.content[0].text).toContain('requires both username and password');
  });

  it('requires url for route kind', async () => {
    const sharedKnowledge = {
      addCredential: vi.fn().mockReturnValue(true),
      addRoute: vi.fn().mockReturnValue(true),
      addToken: vi.fn().mockReturnValue(true),
    };
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      sharedKnowledge: sharedKnowledge as any,
    });
    const handler = getShareWithTeamHandler(rawTools);

    const result = await handler({
      kind: 'route',
      source: 'manual discovery during crawl',
    });

    expect(result.content[0].text).toContain('requires url');
  });

  it('requires token_kind and token_value for token kind', async () => {
    const sharedKnowledge = {
      addCredential: vi.fn().mockReturnValue(true),
      addRoute: vi.fn().mockReturnValue(true),
      addToken: vi.fn().mockReturnValue(true),
    };
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      sharedKnowledge: sharedKnowledge as any,
    });
    const handler = getShareWithTeamHandler(rawTools);

    const result = await handler({
      kind: 'token',
      source: 'found in localStorage',
    });

    expect(result.content[0].text).toContain('requires token_kind and token_value');
  });

  it('shares credentials successfully', async () => {
    const sharedKnowledge = {
      addCredential: vi.fn().mockReturnValue(true),
      addRoute: vi.fn().mockReturnValue(true),
      addToken: vi.fn().mockReturnValue(true),
    };
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      sharedKnowledge: sharedKnowledge as any,
    });
    const handler = getShareWithTeamHandler(rawTools);

    const result = await handler({
      kind: 'credentials',
      username: 'admin',
      password: 'admin123',
      role: 'admin',
      source: 'UNION SQLi on /rest/products',
    });

    expect(result.content[0].text).toContain('Shared with team');
    expect(result.content[0].text).toContain('credentials');
    expect(sharedKnowledge.addCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'admin',
        password: 'admin123',
        role: 'admin',
      }),
    );
  });

  it('reports already known when dedup returns false', async () => {
    const sharedKnowledge = {
      addCredential: vi.fn().mockReturnValue(false), // duplicate
      addRoute: vi.fn().mockReturnValue(false),
      addToken: vi.fn().mockReturnValue(false),
    };
    const journey = makeJourney();
    const logger = makeLogger();
    const { rawTools } = createHarnessMcpServer({
      journey,
      logger,
      sharedKnowledge: sharedKnowledge as any,
    });
    const handler = getShareWithTeamHandler(rawTools);

    const result = await handler({
      kind: 'credentials',
      username: 'admin',
      password: 'admin123',
      source: 're-discovered same creds',
    });

    expect(result.content[0].text).toContain('Already known');
  });
});
