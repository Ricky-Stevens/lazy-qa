/**
 * form_persistence_roundtrip handler — re-exports from src/playbooks/forms.ts.
 */

import { z } from 'zod';
import { formPersistenceRoundtrip } from '../../../src/playbooks/forms.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  formId: z.string(),
  values: z.record(z.string(), z.string()),
  awayUrl: z.string().url().optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return formPersistenceRoundtrip.run(input, ctx);
}
