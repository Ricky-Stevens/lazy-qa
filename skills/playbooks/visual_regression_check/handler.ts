/**
 * visual_regression_check handler — re-exports from src/playbooks/visual-regression.ts.
 */

import { z } from 'zod';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';
import { visualRegressionCheck } from '../../../src/playbooks/visual-regression.ts';

export const inputShape = {
  route: z.string().min(1),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return visualRegressionCheck.run(input, ctx);
}
