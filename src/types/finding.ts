import { z } from 'zod';

/**
 * Zod schema for persisted findings. Used to validate findings loaded from
 * disk (loadFindings in review.ts) — prevents runtime errors from corrupt
 * or partially-written findings.json files.
 */
export const FindingSchema = z.object({
  id: z.string(),
  ts: z.string(),
  severity: z.enum(['critical', 'major', 'minor', 'cosmetic']),
  category: z.enum([
    'validation',
    'error-handling',
    'ux-confusion',
    'visual-regression',
    'broken-feature',
    'performance',
    'unexpected-behavior',
    'accessibility',
    'other',
  ]),
  title: z.string(),
  description: z.string(),
  stepsToReproduce: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  route: z.string().optional(),
  confidence: z.enum(['certain', 'likely', 'maybe-flake']),
  source: z.enum(['agent', 'heuristic']),
  agentId: z.string().optional(),
  ruleName: z.string().optional(),
  screenshotPath: z.string().optional(),
  reproductionActions: z
    .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }))
    .optional(),
  httpStatus: z.number().optional(),
  httpMethod: z.string().optional(),
  requestUrl: z.string().optional(),
  consoleErrors: z.array(z.string()).optional(),
  filedAtUrl: z.string().optional(),
  responseBodySample: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
