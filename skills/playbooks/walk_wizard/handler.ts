/**
 * walk_wizard handler — re-exports from src/playbooks/wizards.ts.
 */

import { z } from 'zod';
import { walkWizard } from '../../../src/playbooks/wizards.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  wizardId: z.string(),
  stepInputs: z.array(z.record(z.string(), z.string())),
  expectFinish: z.boolean().optional(),
  testBackNav: z.boolean().optional().describe('Test back-navigation state preservation after the last step'),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return walkWizard.run(input, ctx);
}
