/**
 * route_404_probe handler — re-exports from src/playbooks/discovery.ts.
 */

import { z } from 'zod';
import { route404Probe } from '../../../src/playbooks/discovery.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  paths: z.array(z.string()),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return route404Probe.run(input, ctx);
}
