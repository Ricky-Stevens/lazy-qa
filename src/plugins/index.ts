/**
 * Plugin registry. Auth providers only — link extraction and logout detection
 * are plain functions in `src/crawler/extract-links.ts` and
 * `src/safety/logout-guard.ts` respectively.
 */

import { formAuthProvider } from './auth/form.ts';
import { storageStateProvider } from './auth/storage-state.ts';
import type { AuthProvider } from './types.ts';

export { formAuthProvider, storageStateProvider };

const PROVIDERS: Record<string, AuthProvider> = {
  form: formAuthProvider,
  'storage-state': storageStateProvider,
  // Back-compat: pre-V3 YAML used `auth.type: none` for "skip pre-login,
  // optionally attach storage_state_path", which is exactly storage-state.
  none: storageStateProvider,
  // Auth0 is a form login. Use `auth.type: form` with the Auth0 selectors,
  // OR use `auth.type: auth0` and we route to formAuthProvider.
  auth0: formAuthProvider,
};

export function resolveAuthProvider(name: string): AuthProvider {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(`Unknown auth provider: ${name}. Known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return p;
}

export function listAuthProviderNames(): string[] {
  return Object.keys(PROVIDERS);
}

export type { AuthProvider };
