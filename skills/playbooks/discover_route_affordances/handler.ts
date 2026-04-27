/**
 * discover_route_affordances handler — re-exports from src/playbooks/discovery.ts.
 */

import { z } from 'zod';
import { discoverRouteAffordances } from '../../../src/playbooks/discovery.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  force: z.boolean().optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return discoverRouteAffordances.run(input, ctx);
}
