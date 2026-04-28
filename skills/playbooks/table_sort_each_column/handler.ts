/**
 * table_sort_each_column handler — re-exports from src/playbooks/tables.ts.
 */

import { z } from 'zod';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';
import { tableSortEachColumn } from '../../../src/playbooks/tables.ts';

export const inputShape = {
  tableId: z.string(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return tableSortEachColumn.run(input, ctx);
}
