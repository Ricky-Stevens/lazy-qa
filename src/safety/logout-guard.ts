/**
 * Logout-link detection. Pattern-matches link/button accessible metadata for
 * common logout/sign-out shapes. Used by the browser server's `find_and_click`
 * to refuse navigation that would terminate the session, and by the
 * `read_recent` snapshot enrichment.
 */

const LOGOUT_TEXTS = [
  'log out',
  'logout',
  'sign out',
  'signout',
  'log-out',
  'sign-out',
  'logoff',
  'log off',
];

export interface LogoutMeta {
  text: string;
  ariaLabel: string;
  href: string;
  testid: string;
  title: string;
}

export interface LogoutMatch {
  matched: boolean;
  reason?: string;
}

export function isLogoutLink(meta: LogoutMeta): LogoutMatch {
  const haystack = `${meta.text} ${meta.ariaLabel} ${meta.title} ${meta.testid}`.toLowerCase();
  for (const phrase of LOGOUT_TEXTS) {
    if (haystack.includes(phrase)) {
      return { matched: true, reason: `text/aria/title/testid contained "${phrase}"` };
    }
  }
  if (/\/(logout|signout|log-out|sign-out|logoff)(\?|#|$)/i.test(meta.href)) {
    return { matched: true, reason: 'href matched logout pattern' };
  }
  return { matched: false };
}
