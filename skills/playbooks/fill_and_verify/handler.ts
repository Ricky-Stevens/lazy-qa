/**
 * fill_and_verify handler — re-exports from src/playbooks/forms.ts.
 */

import { z } from 'zod';
import { fillAndVerify } from '../../../src/playbooks/forms.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  formId: z.string(),
  values: z.record(z.string(), z.string()),
  submit: z.boolean().optional(),
  verify: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('url-changed') }),
        z.object({ kind: z.literal('url-matches'), pattern: z.string() }),
        z.object({ kind: z.literal('success-toast') }),
        z.object({ kind: z.literal('error-shown') }),
        z.object({ kind: z.literal('value-persisted'), field: z.string(), expect: z.string() }),
        z.object({ kind: z.literal('redirect-to'), pathContains: z.string() }),
      ]),
    )
    .optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return fillAndVerify.run(input, ctx);
}
