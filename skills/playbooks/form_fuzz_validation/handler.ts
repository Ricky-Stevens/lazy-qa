/**
 * form_fuzz_validation handler — re-exports from src/playbooks/forms.ts.
 */

import { z } from 'zod';
import { formFuzzValidation } from '../../../src/playbooks/forms.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  formId: z.string(),
  vectors: z.array(z.string()).optional(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return formFuzzValidation.run(input, ctx);
}
