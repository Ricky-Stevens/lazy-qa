/**
 * Derive a stable route key from a raw URL. SPA hash-routes are kept;
 * query strings and non-SPA fragments are stripped.
 */
export function deriveRoute(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const isSpaHash = /^#!?\//.test(u.hash);
    if (isSpaHash) {
      return `${u.origin}/${u.hash}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}
