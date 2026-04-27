/**
 * header_audit handler — re-exports from src/playbooks/security.ts.
 */

import { z } from 'zod';
import { headerAudit } from '../../../src/playbooks/security.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  paths: z.array(z.string()).min(1),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return headerAudit.run(input, ctx);
}
