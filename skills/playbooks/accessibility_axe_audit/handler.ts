import { z } from 'zod';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';
import { accessibilityAxeAudit } from '../../../src/playbooks/accessibility-audit.ts';

export const inputShape = {
  route: z.string().min(1),
  standard: z.string().optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return accessibilityAxeAudit.run(input, ctx);
}
