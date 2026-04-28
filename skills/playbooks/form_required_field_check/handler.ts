/**
 * form_required_field_check handler — re-exports from src/playbooks/forms.ts.
 */

import { z } from 'zod';
import { formRequiredFieldCheck } from '../../../src/playbooks/forms.ts';
import type { PlaybookContext } from '../../../src/playbooks/framework.ts';
import type { PlaybookOutcome } from '../../../src/playbooks/outcome.ts';

export const inputShape = {
  formId: z.string(),
} as const satisfies z.ZodRawShape;

export async function handler(
  input: z.infer<z.ZodObject<typeof inputShape>>,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  return formRequiredFieldCheck.run(input, ctx);
}
