/**
 * rate_limit_probe handler — re-exports from src/playbooks/security.ts.
 */

import { z } from 'zod';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';
import { rateLimitProbe } from '../../../src/playbooks/security.ts';

export const inputShape = {
  route: z.string(),
  method: z.enum(['GET', 'POST']).default('GET'),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return rateLimitProbe.run(input, ctx);
}
