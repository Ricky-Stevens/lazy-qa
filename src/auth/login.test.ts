import { describe, expect, it } from 'vitest';
import { launchBrowser } from './login.ts';

describe('launchBrowser', () => {
  it('uses playwright chromium when stealth is false', async () => {
    // With stealth: false, should not throw and should return a Browser object
    const browser = await launchBrowser(false, { headless: true });
    expect(browser).toBeDefined();
    // Clean up
    await browser.close();
  });

  it('throws a clear error when stealth is true but cloakbrowser is not installed', async () => {
    try {
      await launchBrowser(true, { headless: true });
      expect.fail('Should have thrown an error');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('cloakbrowser is not installed');
    }
  });
});
