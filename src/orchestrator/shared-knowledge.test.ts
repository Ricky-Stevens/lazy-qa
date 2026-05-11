import { describe, expect, it } from 'vitest';
import { SharedKnowledge } from './shared-knowledge.ts';
import type {
  SharedAuthToken,
  SharedBroadcast,
  SharedCredential,
  SharedDiscoveredRoute,
} from './shared-knowledge.ts';

function makeCred(overrides: Partial<SharedCredential> = {}): SharedCredential {
  return {
    username: 'admin@example.com',
    password: 'admin123',
    source: 'UNION SQLi on /rest/products/search',
    foundBy: 'agent-attacker',
    foundAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRoute(overrides: Partial<SharedDiscoveredRoute> = {}): SharedDiscoveredRoute {
  return {
    url: '/admin',
    lastStatus: 200,
    requiresAuth: true,
    note: 'Admin panel found',
    foundBy: 'agent-1',
    foundAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeToken(overrides: Partial<SharedAuthToken> = {}): SharedAuthToken {
  return {
    kind: 'jwt',
    value: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.sig',
    origin: 'http://localhost:3000',
    source: 'localStorage after login',
    foundBy: 'agent-1',
    foundAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBroadcast(overrides: Partial<SharedBroadcast> = {}): SharedBroadcast {
  return {
    message: 'Credentials found! Log in with admin@example.com / admin123.',
    issuedBy: 'supervisor',
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SharedKnowledge', () => {
  // ── Credentials ──────────────────────────────────────────────────────────

  describe('credentials', () => {
    it('adds and lists credentials', () => {
      const sk = new SharedKnowledge();
      const added = sk.addCredential(makeCred());
      expect(added).toBe(true);
      expect(sk.listCredentials()).toHaveLength(1);
    });

    it('deduplicates on username+password', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred({ username: 'a', password: 'b' }));
      const added = sk.addCredential(makeCred({ username: 'a', password: 'b', source: 'other' }));
      expect(added).toBe(false);
      expect(sk.listCredentials()).toHaveLength(1);
    });

    it('does not dedup different passwords', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred({ username: 'a', password: 'b' }));
      sk.addCredential(makeCred({ username: 'a', password: 'c' }));
      expect(sk.listCredentials()).toHaveLength(2);
    });

    it('lists most recent first', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred({ username: 'first', password: 'x' }));
      sk.addCredential(makeCred({ username: 'second', password: 'y' }));
      expect(sk.listCredentials()[0]?.username).toBe('second');
    });

    it('caps at 25 entries', () => {
      const sk = new SharedKnowledge();
      for (let i = 0; i < 30; i++) {
        sk.addCredential(makeCred({ username: `user${i}`, password: `pw${i}` }));
      }
      expect(sk.listCredentials()).toHaveLength(25);
    });

    it('markCredentialVerified flips the flag', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred({ username: 'u', password: 'p' }));
      sk.markCredentialVerified('u', 'p');
      expect(sk.listCredentials()[0]?.loginVerified).toBe(true);
    });

    it('markCredentialVerified is a no-op for unknown creds', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred({ username: 'u', password: 'p' }));
      sk.markCredentialVerified('u', 'wrong');
      expect(sk.listCredentials()[0]?.loginVerified).toBeUndefined();
    });
  });

  // ── Routes ───────────────────────────────────────────────────────────────

  describe('routes', () => {
    it('adds and lists routes', () => {
      const sk = new SharedKnowledge();
      expect(sk.addRoute(makeRoute())).toBe(true);
      expect(sk.listRoutes()).toHaveLength(1);
    });

    it('deduplicates on url and updates status', () => {
      const sk = new SharedKnowledge();
      sk.addRoute(makeRoute({ url: '/admin', lastStatus: -1 }));
      const added = sk.addRoute(makeRoute({ url: '/admin', lastStatus: 200 }));
      expect(added).toBe(false);
      expect(sk.listRoutes()).toHaveLength(1);
      expect(sk.listRoutes()[0]?.lastStatus).toBe(200);
    });

    it('preserves requiresAuth=true on re-add with false', () => {
      const sk = new SharedKnowledge();
      sk.addRoute(makeRoute({ url: '/admin', requiresAuth: true }));
      sk.addRoute(makeRoute({ url: '/admin', requiresAuth: false }));
      expect(sk.listRoutes()[0]?.requiresAuth).toBe(true);
    });

    it('caps at 50 entries', () => {
      const sk = new SharedKnowledge();
      for (let i = 0; i < 55; i++) {
        sk.addRoute(makeRoute({ url: `/route-${i}` }));
      }
      expect(sk.listRoutes()).toHaveLength(50);
    });
  });

  // ── Tokens ───────────────────────────────────────────────────────────────

  describe('tokens', () => {
    it('adds and lists tokens', () => {
      const sk = new SharedKnowledge();
      expect(sk.addToken(makeToken())).toBe(true);
      expect(sk.listTokens()).toHaveLength(1);
    });

    it('deduplicates on value+origin', () => {
      const sk = new SharedKnowledge();
      sk.addToken(makeToken({ value: 'tok', origin: 'http://x' }));
      const added = sk.addToken(makeToken({ value: 'tok', origin: 'http://x' }));
      expect(added).toBe(false);
      expect(sk.listTokens()).toHaveLength(1);
    });

    it('allows same value on different origins', () => {
      const sk = new SharedKnowledge();
      sk.addToken(makeToken({ value: 'tok', origin: 'http://a' }));
      sk.addToken(makeToken({ value: 'tok', origin: 'http://b' }));
      expect(sk.listTokens()).toHaveLength(2);
    });

    it('caps at 25 entries', () => {
      const sk = new SharedKnowledge();
      for (let i = 0; i < 30; i++) {
        sk.addToken(makeToken({ value: `tok-${i}` }));
      }
      expect(sk.listTokens()).toHaveLength(25);
    });
  });

  // ── Broadcasts ───────────────────────────────────────────────────────────

  describe('broadcasts', () => {
    it('consumeBroadcasts returns unseen broadcasts for the agent', () => {
      const sk = new SharedKnowledge();
      sk.addBroadcast(makeBroadcast({ message: 'msg1' }));
      sk.addBroadcast(makeBroadcast({ message: 'msg2' }));

      const result = sk.consumeBroadcasts('agent-1', 'power-user');
      expect(result).toHaveLength(2);
      expect(result[0]?.message).toBe('msg1');
    });

    it('marks watermark so second consume returns only new broadcasts', () => {
      const sk = new SharedKnowledge();
      sk.addBroadcast(makeBroadcast({ message: 'old' }));
      sk.consumeBroadcasts('agent-1', 'power-user');

      sk.addBroadcast(makeBroadcast({ message: 'new' }));
      const result = sk.consumeBroadcasts('agent-1', 'power-user');
      expect(result).toHaveLength(1);
      expect(result[0]?.message).toBe('new');
    });

    it('filters by forProfile when set', () => {
      const sk = new SharedKnowledge();
      sk.addBroadcast(makeBroadcast({ message: 'for-attacker', forProfile: 'attacker' }));
      sk.addBroadcast(makeBroadcast({ message: 'for-all' }));

      const attackerSees = sk.consumeBroadcasts('a1', 'attacker');
      expect(attackerSees).toHaveLength(2);

      // Different agent, different profile
      const funcSees = sk.consumeBroadcasts('a2', 'power-user');
      expect(funcSees).toHaveLength(1);
      expect(funcSees[0]?.message).toBe('for-all');
    });

    it('caps at 30 entries', () => {
      const sk = new SharedKnowledge();
      for (let i = 0; i < 35; i++) {
        sk.addBroadcast(makeBroadcast({ message: `msg-${i}` }));
      }
      expect(sk.size().broadcasts).toBe(30);
    });
  });

  // ── Snapshot ──────────────────────────────────────────────────────────────

  describe('snapshot', () => {
    it('returns shallow copies of all categories', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred());
      sk.addRoute(makeRoute());
      sk.addToken(makeToken());

      const snap = sk.snapshot();
      expect(snap.credentials).toHaveLength(1);
      expect(snap.routes).toHaveLength(1);
      expect(snap.tokens).toHaveLength(1);

      // Mutating snapshot does not affect store
      snap.credentials.length = 0;
      expect(sk.listCredentials()).toHaveLength(1);
    });
  });

  describe('size', () => {
    it('returns counts for all categories', () => {
      const sk = new SharedKnowledge();
      sk.addCredential(makeCred());
      sk.addRoute(makeRoute());
      sk.addToken(makeToken());
      sk.addBroadcast(makeBroadcast());

      const s = sk.size();
      expect(s.credentials).toBe(1);
      expect(s.routes).toBe(1);
      expect(s.tokens).toBe(1);
      expect(s.broadcasts).toBe(1);
    });
  });
});
