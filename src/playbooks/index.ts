/**
 * Default playbook registry aggregator. Builds a `PlaybookRegistry` populated
 * with every shipped playbook across all 12 categories.
 *
 * Usage:
 *   const registry = buildDefaultRegistry();
 *   const tools = registry.toMcpTools(buildHandler);
 */

import { registerAsyncPlaybooks } from './async.ts';
import { registerButtonPlaybooks } from './buttons.ts';
import { registerChaosPlaybooks } from './chaos.ts';
import { registerCrudPlaybooks } from './crud.ts';
import { registerDiscoveryPlaybooks } from './discovery.ts';
import { registerFilePlaybooks } from './files.ts';
import { registerFormPlaybooks } from './forms.ts';
import { PlaybookRegistry } from './framework.ts';
import { registerModalPlaybooks } from './modals.ts';
import { registerSearchPlaybooks } from './search.ts';
import { registerSecurityPlaybooks } from './security.ts';
import { registerTablePlaybooks } from './tables.ts';
import { registerWizardPlaybooks } from './wizards.ts';

/** Build a registry containing every shipped playbook. ~30+ playbooks total. */
export function buildDefaultRegistry(): PlaybookRegistry {
  const r = new PlaybookRegistry();
  registerCrudPlaybooks(r);
  registerFormPlaybooks(r);
  registerTablePlaybooks(r);
  registerModalPlaybooks(r);
  registerButtonPlaybooks(r);
  registerWizardPlaybooks(r);
  registerSecurityPlaybooks(r);
  registerChaosPlaybooks(r);
  registerSearchPlaybooks(r);
  registerFilePlaybooks(r);
  registerAsyncPlaybooks(r);
  registerDiscoveryPlaybooks(r);
  return r;
}

export { PlaybookRegistry } from './framework.ts';
export type { Playbook, PlaybookContext } from './framework.ts';
export { ok, fail, suspicious } from './outcome.ts';
export type { PlaybookOutcome } from './outcome.ts';
