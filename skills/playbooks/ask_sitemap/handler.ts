/**
 * ask_sitemap handler — re-exports from src/playbooks/discovery.ts.
 * The canonical implementation lives in the source file; this handler
 * bridges the Skills loader to the existing playbook object.
 */

import { z } from 'zod';
import { askSitemap } from '../../../src/playbooks/discovery.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  query: z.enum([
    'unvisited routes',
    'untested forms',
    'unfuzzed forms',
    'unsorted tables',
    'unexercised modals',
    'unexercised wizards',
    '4xx routes',
  ]),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return askSitemap.run(input, ctx);
}
