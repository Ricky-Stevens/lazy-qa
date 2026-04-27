/**
 * idor_probe handler — re-exports from src/playbooks/security.ts.
 */

import { z } from 'zod';
import { idorProbe } from '../../../src/playbooks/security.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  routeWithId: z.string(),
  candidates: z.array(z.string()).optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return idorProbe.run(input, ctx);
}
