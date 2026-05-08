// Operator-controlled safety guards.
//
// Two CRITICAL findings drove this file's shape:
//
//   1. SSRF / credential exfil. Without an out-of-band allowlist, a malicious
//      YAML can declare its own allowed_hosts and have the orchestrator type
//      real env-var-resolved credentials into a form on attacker.example.
//      Defence: REGRESS_TRUSTED_HOSTS is set by the operator (env / shell /
//      systemd unit), and YAML allowed_hosts must be a subset.
//
//   2. The previous \bprod(uction)?\b/i regex was fail-open — it missed
//      api.example.com, www.example.com, customer aliases, IP literals.
//      Defence: positive non-prod host check; operator can extend via
//      REGRESS_NONPROD_HOST_PATTERNS for unusual hostnames.

const TRUSTED_HOSTS_ENV = 'REGRESS_TRUSTED_HOSTS';
const NONPROD_PATTERNS_ENV = 'REGRESS_NONPROD_HOST_PATTERNS';

// Hosts that are unambiguously non-prod by virtue of being loopback.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

// Default non-prod host prefixes. Operator can override via
// REGRESS_NONPROD_HOST_PATTERNS — when set, the env-var fully replaces this list.
const DEFAULT_NONPROD_PREFIXES = [
  'staging.',
  'staging-',
  'dev.',
  'dev-',
  'qa.',
  'qa-',
  'test.',
  'test-',
  'preview.',
  'preview-',
];

function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function isLoopback(host: string): boolean {
  // Strip port for loopback comparison.
  const bare = host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(bare);
}

/**
 * Reject if any host in the YAML's allowed_hosts is not in the operator's
 * REGRESS_TRUSTED_HOSTS allowlist. This is the primary defence against a
 * malicious YAML pointing the orchestrator at attacker-controlled hosts.
 *
 * REGRESS_TRUSTED_HOSTS must be set by the operator. Hard-fail if absent —
 * silent default-allow would re-introduce the SSRF.
 */
export function assertHostsTrusted(allowedHosts: string[]): void {
  const trusted = parseHostList(process.env[TRUSTED_HOSTS_ENV]);
  if (trusted.length === 0) {
    throw new Error(
      `${TRUSTED_HOSTS_ENV} is not set. Refusing to run. Set it (in your shell, .env, or systemd unit) ` +
        `to a comma-separated list of host[:port] entries that the YAML's allowed_hosts may reference. ` +
        `Example: ${TRUSTED_HOSTS_ENV}=staging.analyst-portal.ip-house.com,localhost:3001`,
    );
  }
  const trustedSet = new Set(trusted);
  const violators = allowedHosts.filter((h) => !trustedSet.has(h));
  if (violators.length > 0) {
    throw new Error(
      `target.allowed_hosts contains entries not in ${TRUSTED_HOSTS_ENV}: ${violators.join(', ')}. ` +
        `Either add them to ${TRUSTED_HOSTS_ENV} (operator-side) or remove from the config.`,
    );
  }
}

export function assertAllowedTarget(url: string, allowedHosts: string[]): void {
  if (allowedHosts.length === 0) {
    throw new Error(
      `target.allowed_hosts is empty — refusing to scan. Populate it with the hosts you've authorised.`,
    );
  }
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    throw new Error(`target.url is not a valid URL: ${url}`);
  }
  if (!allowedHosts.includes(host)) {
    throw new Error(
      `Target host '${host}' is not in target.allowed_hosts (${allowedHosts.join(', ')}). Refusing to scan.`,
    );
  }
}

/**
 * Reject if `host` does not look like a non-prod host. Replaces the previous
 * fail-open `\bprod\b` regex.
 *
 * Defaults match common non-prod prefixes (staging./dev./qa./test./preview./
 * loopback). Operator can override the list via REGRESS_NONPROD_HOST_PATTERNS,
 * which fully replaces the default set when present (a non-empty value means
 * "I am taking responsibility for this list").
 */
export function assertNonProdHost(url: string): void {
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    throw new Error(`target.url is not a valid URL: ${url}`);
  }

  if (isLoopback(host)) return;

  const overrides = parseHostList(process.env[NONPROD_PATTERNS_ENV]);
  if (overrides.length > 0) {
    if (overrides.includes(host)) return;
    throw new Error(
      `Target host '${host}' is not in ${NONPROD_PATTERNS_ENV} (${overrides.join(', ')}). ` +
        `If this is a non-prod host with an unusual name, add it to ${NONPROD_PATTERNS_ENV}.`,
    );
  }

  const matches = DEFAULT_NONPROD_PREFIXES.some((p) => host.startsWith(p));
  if (!matches) {
    throw new Error(
      `Target host '${host}' does not match any default non-prod prefix ` +
        `(${DEFAULT_NONPROD_PREFIXES.join(', ')}) and ${NONPROD_PATTERNS_ENV} is unset. ` +
        `If '${host}' is genuinely non-prod, set ${NONPROD_PATTERNS_ENV}='${host}' (or a list).`,
    );
  }
}

type PlaywrightRoute = {
  request: () => { url: () => string };
  abort: () => Promise<void>;
  continue: () => Promise<void>;
};

/**
 * Check whether a URL's host matches the run's allowed-hosts list.
 * Match rules (in order):
 *   1. exact `host:port` match against any allowed entry
 *   2. exact `hostname` match against any allowed entry (port-stripped both sides)
 *   3. subdomain match — `cdn.staging.example.com` matches `staging.example.com`
 * Returns false for invalid URLs. Port-stripping mirrors the crawler's
 * isAllowedHost so a config entry like `localhost:3000` permits the
 * agent-tool navigate path even though `URL.hostname` drops the port.
 */
export function isHostAllowed(url: string, allowedHosts: string[]): boolean {
  let host: string;
  let hostname: string;
  try {
    const u = new URL(url);
    host = u.host;
    hostname = u.hostname;
  } catch {
    return false;
  }
  for (const allowed of allowedHosts) {
    if (host === allowed) return true;
    if (hostname === allowed) return true;
    const allowedHostname = allowed.split(':')[0] ?? allowed;
    if (hostname === allowedHostname) return true;
    if (hostname.endsWith(`.${allowedHostname}`)) return true;
  }
  return false;
}

export function isPathBanned(url: string, bannedPrefixes: string[]): boolean {
  if (bannedPrefixes.length === 0) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return bannedPrefixes.some((prefix) => pathname.startsWith(prefix));
}

export function createNetworkAllowlistRoute(allowedHosts: string[]) {
  const set = new Set(allowedHosts);
  return async (route: PlaywrightRoute) => {
    let host: string;
    try {
      host = new URL(route.request().url()).host;
    } catch {
      await route.abort();
      return;
    }
    if (!set.has(host)) {
      await route.abort();
      return;
    }
    await route.continue();
  };
}
