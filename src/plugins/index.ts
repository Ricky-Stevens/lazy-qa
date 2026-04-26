/**
 * Plugin registry. Exposes `resolveAuthProvider` (used by the orchestrator's
 * pre-login layer) plus default LinkExtractor / LogoutGuard singletons.
 *
 * The shipped providers map to the `target.auth.type` values referenced in
 * §11 of the v2 spec. `'none'` is back-compat: existing v1 YAMLs use it for
 * "no pre-login, optionally attach storage state", which is exactly what
 * the storage-state provider does.
 */

import { auth0Provider } from './auth/auth0.ts';
import { bearerTokenProvider } from './auth/bearer-token.ts';
import { formAuthProvider } from './auth/form.ts';
import { storageStateProvider } from './auth/storage-state.ts';
import { defaultLinkExtractor } from './link-extractors/default.ts';
import { defaultLogoutGuard } from './logout-guards/default.ts';
import type { AuthProvider, LinkExtractor, LogoutGuard } from './types.ts';

export {
  auth0Provider,
  bearerTokenProvider,
  defaultLinkExtractor,
  defaultLogoutGuard,
  formAuthProvider,
  storageStateProvider,
};

const PROVIDERS: Record<string, AuthProvider> = {
  form: formAuthProvider,
  auth0: auth0Provider,
  'storage-state': storageStateProvider,
  bearer: bearerTokenProvider,
  // Back-compat with v1 YAML: `auth.type: none` historically meant "skip
  // pre-login, optionally attach storage_state_path". The storage-state
  // provider implements exactly that.
  none: storageStateProvider,
};

export function resolveAuthProvider(name: string): AuthProvider {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(`Unknown auth provider: ${name}. Known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return p;
}

/** Names of every built-in provider, in registration order. Useful for
 * surfacing the catalog in error messages without leaking the singletons. */
export function listAuthProviderNames(): string[] {
  return Object.keys(PROVIDERS);
}

export type { AuthProvider, LinkExtractor, LogoutGuard };
