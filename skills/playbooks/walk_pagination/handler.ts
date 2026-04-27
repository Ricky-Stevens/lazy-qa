/**
 * walk_pagination handler — re-exports from src/playbooks/tables.ts.
 */

import { z } from 'zod';
import { walkPagination } from '../../../src/playbooks/tables.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  tableId: z.string(),
  maxPages: z.number().int().min(1).max(20).optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return walkPagination.run(input, ctx);
}
