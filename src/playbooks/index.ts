/**
 * Default playbook registry aggregator. Builds a `PlaybookRegistry` populated
 * with the 9 surviving playbooks: 3 discovery, 3 utility, 3 security.
 *
 * Usage:
 *   const registry = buildDefaultRegistry();
 *   const tools = registry.toMcpTools(buildHandler);
 */

import { registerDiscoveryPlaybooks } from './discovery.ts';
import { registerFormPlaybooks } from './forms.ts';
import { PlaybookRegistry } from './framework.ts';
import { registerSecurityPlaybooks } from './security.ts';
import { registerTablePlaybooks } from './tables.ts';
import { registerWizardPlaybooks } from './wizards.ts';

/** Build a registry containing every shipped playbook (9 total). */
export function buildDefaultRegistry(): PlaybookRegistry {
  const r = new PlaybookRegistry();
  registerFormPlaybooks(r);
  registerTablePlaybooks(r);
  registerWizardPlaybooks(r);
  registerSecurityPlaybooks(r);
  registerDiscoveryPlaybooks(r);
  return r;
}

export type { Playbook, PlaybookContext } from './framework.ts';
export { PlaybookRegistry } from './framework.ts';
export type { PlaybookOutcome } from './outcome.ts';
export { fail, ok, suspicious } from './outcome.ts';
