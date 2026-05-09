/**
 * responsive_check handler — re-exports from src/playbooks/responsive.ts.
 */

import { z } from 'zod';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';
import { responsiveCheck } from '../../../src/playbooks/responsive.ts';

export const inputShape = {
  route: z.string(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return responsiveCheck.run(input, ctx);
}
