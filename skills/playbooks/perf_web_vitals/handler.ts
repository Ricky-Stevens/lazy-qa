/**
 * perf_web_vitals handler — re-exports from src/playbooks/performance.ts.
 */

import { z } from 'zod';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';
import { perfWebVitals } from '../../../src/playbooks/performance.ts';

export const inputShape = {
  route: z.string(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return perfWebVitals.run(input, ctx);
}
