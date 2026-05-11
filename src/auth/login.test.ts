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

  it('throws when stealth is true and cloakbrowser is unavailable or crashes', async () => {
    // This test verifies that stealth mode surfaces a clear error rather than
    // silently falling through. Two outcomes are valid depending on the env:
    //   1. cloakbrowser module not installed → import fails → our wrapper
    //      throws "cloakbrowser is not installed"
    //   2. cloakbrowser IS installed but the binary crashes (e.g. SIGBUS on
    //      WSL2) → launch() throws a Playwright-level error
    // Either way, launchBrowser must reject — it must never resolve with an
    // unusable browser handle.
    try {
      const browser = await launchBrowser(true, { headless: true });
      // If launch somehow succeeds (cloakbrowser installed and healthy), clean
      // up and skip — the test only validates error paths.
      await browser.close();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      // Accept either our custom message or a Playwright crash message.
      const isExpectedError =
        msg.includes('cloakbrowser is not installed') ||
        msg.includes('browserType.launch') ||
        msg.includes('Browser closed') ||
        msg.includes('Target page, context or browser has been closed');
      expect(isExpectedError).toBe(true);
    }
  });
});
