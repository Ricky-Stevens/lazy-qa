/**
 * Shared cross-agent intelligence store.
 *
 * Lives at the run level — every agent in a parallel run shares one instance.
 * When an agent discovers something the team should benefit from (credentials
 * dumped via SQLi, an authenticated route exposed, a JWT in localStorage, a
 * supervisor-issued directive), they share it here. Every other agent's
 * per-turn user message gets a "Team intelligence" block listing what's
 * available — credentials to log in with, routes to navigate to, instructions
 * from the supervisor.
 *
 * Why this exists: in the previous Juice Shop run the attacker dumped the
 * users table including admin passwords via UNION SQLi at turn 32 — and then
 * went straight back to URL-guessing for 25 more turns. Zero login attempts.
 * The functional agents had no idea the credentials existed. With this store +
 * the `try_login` tool + supervisor broadcast, finding credentials becomes a
 * team event that unlocks the authenticated surface for every agent.
 *
 * Storage is in-process per run. The events.jsonl trace is the durable record.
 */

/** Credentials discovered by an agent — typically via SQLi UNION dumps,
 *  exposed config files, FTP-readable backup files, or admin-enumeration
 *  endpoints. Once shared, every other agent on its next turn sees these and
 *  is told to attempt login. */
export interface SharedCredential {
  username: string;
  password: string;
  /** Optional: role / privilege level if known (e.g. 'admin', 'customer'). */
  role?: string;
  /** Where the credential came from — short human-readable phrase, e.g.
   *  "UNION SQLi on /rest/products/search" or "ftp/users.json". */
  source: string;
  /** Optional: a finding ID this credential is tied to, for cross-reference. */
  fromFindingId?: string;
  /** Agent that found it. */
  foundBy: string;
  /** ISO timestamp. */
  foundAt: string;
  /** Has this credential been successfully used to log in by ANY agent yet?
   *  Flipped to true by the try_login tool on success. Other agents skip
   *  re-trying credentials that have already worked. */
  loginVerified?: boolean;
}

/** A route discovered by an agent that wasn't in the original sitemap.
 *  Typically authenticated routes (admin panels, API endpoints accessible
 *  post-login, hidden pages found by reading source/configs). Other agents
 *  should add this to their exploration backlog. */
export interface SharedDiscoveredRoute {
  /** Absolute URL OR origin-relative path. Agents are expected to normalise. */
  url: string;
  /** Last observed HTTP status when accessed. -1 if not yet probed. */
  lastStatus: number;
  /** Does this route require authentication? Set when known (e.g. observed
   *  redirect to login, or accessed only after a successful try_login). */
  requiresAuth: boolean;
  /** Why the discovering agent thinks the team should care. Short phrase. */
  note: string;
  foundBy: string;
  foundAt: string;
}

/** A bearer token / JWT / session cookie value scraped from a successful
 *  login or from page state. Sharing this lets other agents reuse the auth
 *  context without re-running the login flow. */
export interface SharedAuthToken {
  kind: 'jwt' | 'bearer' | 'cookie' | 'other';
  /** The token value. NOT redacted in shared-knowledge — this is internal
   *  in-process state only, never persisted to disk except in events.jsonl. */
  value: string;
  /** Optional: cookie name when kind='cookie'. */
  cookieName?: string;
  /** Origin this token applies to. Empty string = wildcard within run. */
  origin: string;
  source: string;
  foundBy: string;
  foundAt: string;
}

/** A supervisor-issued directive that should be broadcast to every agent's
 *  next turn user message. Distinct from `pushNudge` (which targets one agent)
 *  — broadcasts go to all. Used for "credentials available, log in NOW",
 *  "team has discovered admin panel at X, prioritise it", etc. */
export interface SharedBroadcast {
  /** Short, action-oriented message. Rendered verbatim in the per-turn
   *  user message after the credentials/routes blocks. */
  message: string;
  /** Optional: agents matching this profileName see the broadcast; others skip
   *  it. Useful for "ATTACKER: stop URL-guessing, you have creds — log in". */
  forProfile?: string;
  issuedBy: 'supervisor';
  issuedAt: string;
}

/** Maximum entries retained per category. Older entries fall off. Sized so
 *  the per-turn rendering doesn't blow the input budget. */
const MAX_CREDENTIALS = 25;
const MAX_ROUTES = 50;
const MAX_TOKENS = 25;
const MAX_BROADCASTS = 30;

export class SharedKnowledge {
  private credentials: SharedCredential[] = [];
  private routes: SharedDiscoveredRoute[] = [];
  private tokens: SharedAuthToken[] = [];
  private broadcasts: SharedBroadcast[] = [];
  /** Per-agent watermark — the index into broadcasts up to which this agent
   *  has already seen. New broadcasts (after the watermark) render in the
   *  per-turn message; older ones are skipped to avoid repeating the same
   *  directive every turn. */
  private broadcastWatermark = new Map<string, number>();

  // ── Credentials ─────────────────────────────────────────────────────────

  /** Add a credential. Deduplicates on (username, password) — re-adding the
   *  same creds is a no-op (no `foundBy` overwrite). Returns true if newly
   *  added, false if it was already known. */
  addCredential(c: SharedCredential): boolean {
    const dup = this.credentials.find(
      (x) => x.username === c.username && x.password === c.password,
    );
    if (dup) return false;
    this.credentials.push(c);
    if (this.credentials.length > MAX_CREDENTIALS) {
      this.credentials.splice(0, this.credentials.length - MAX_CREDENTIALS);
    }
    return true;
  }

  /** Mark a credential as login-verified (called by try_login on success).
   *  No-op if no matching credential is in the store. */
  markCredentialVerified(username: string, password: string): void {
    const c = this.credentials.find((x) => x.username === username && x.password === password);
    if (c) c.loginVerified = true;
  }

  /** All credentials, most recent first. */
  listCredentials(): SharedCredential[] {
    return [...this.credentials].reverse();
  }

  // ── Discovered routes ───────────────────────────────────────────────────

  /** Add a discovered route. Deduplicates on `url` — re-adding updates
   *  `lastStatus` / `requiresAuth` if those have changed but preserves the
   *  original discoverer. */
  addRoute(r: SharedDiscoveredRoute): boolean {
    const existing = this.routes.find((x) => x.url === r.url);
    if (existing) {
      existing.lastStatus = r.lastStatus;
      existing.requiresAuth = existing.requiresAuth || r.requiresAuth;
      return false;
    }
    this.routes.push(r);
    if (this.routes.length > MAX_ROUTES) {
      this.routes.splice(0, this.routes.length - MAX_ROUTES);
    }
    return true;
  }

  listRoutes(): SharedDiscoveredRoute[] {
    return [...this.routes].reverse();
  }

  // ── Auth tokens ─────────────────────────────────────────────────────────

  addToken(t: SharedAuthToken): boolean {
    const dup = this.tokens.find((x) => x.value === t.value && x.origin === t.origin);
    if (dup) return false;
    this.tokens.push(t);
    if (this.tokens.length > MAX_TOKENS) {
      this.tokens.splice(0, this.tokens.length - MAX_TOKENS);
    }
    return true;
  }

  listTokens(): SharedAuthToken[] {
    return [...this.tokens].reverse();
  }

  // ── Broadcasts ──────────────────────────────────────────────────────────

  addBroadcast(b: SharedBroadcast): void {
    this.broadcasts.push(b);
    if (this.broadcasts.length > MAX_BROADCASTS) {
      this.broadcasts.splice(0, this.broadcasts.length - MAX_BROADCASTS);
    }
  }

  /** Returns broadcasts this agent has not yet seen (since its last call to
   *  consumeBroadcasts) AND that target this agent's profile (or are
   *  unscoped). Updates the per-agent watermark. */
  consumeBroadcasts(agentId: string, profileName: string): SharedBroadcast[] {
    const seen = this.broadcastWatermark.get(agentId) ?? 0;
    const fresh = this.broadcasts
      .slice(seen)
      .filter((b) => !b.forProfile || b.forProfile === profileName);
    this.broadcastWatermark.set(agentId, this.broadcasts.length);
    return fresh;
  }

  // ── Aggregate read for per-turn rendering ───────────────────────────────

  /** Snapshot used by the loop's per-turn rendering and the supervisor's
   *  list_agents view. Mutating the returned arrays does NOT affect the
   *  store — they are shallow-copied. */
  snapshot(): {
    credentials: SharedCredential[];
    routes: SharedDiscoveredRoute[];
    tokens: SharedAuthToken[];
  } {
    return {
      credentials: this.listCredentials(),
      routes: this.listRoutes(),
      tokens: this.listTokens(),
    };
  }

  /** Total entries across all categories — for supervisor visibility. */
  size(): { credentials: number; routes: number; tokens: number; broadcasts: number } {
    return {
      credentials: this.credentials.length,
      routes: this.routes.length,
      tokens: this.tokens.length,
      broadcasts: this.broadcasts.length,
    };
  }
}
