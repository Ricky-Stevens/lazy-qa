import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScreenshot } from './screenshot.ts';

describe('captureScreenshot', () => {
  let browser: Browser;
  let runDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(path.join(tmpdir(), 'screenshot-test-'));
  });

  afterAll(async () => {
    await browser.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it('writes a valid PNG and returns a relative path under findings/', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(
      '<!doctype html><html><body><h1 style="color:red">Hello</h1></body></html>',
    );

    const findingId = 'finding-123';
    const rel = await captureScreenshot(page, runDir, findingId);
    await ctx.close();

    // Returned path is relative and points at findings/<id>.png.
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel).toBe(path.join('findings', `${findingId}.png`));

    // The file exists and is a valid PNG (8-byte header).
    const bytes = await readFile(path.join(runDir, rel));
    expect(bytes.length).toBeGreaterThan(8);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
    expect(bytes[4]).toBe(0x0d);
    expect(bytes[5]).toBe(0x0a);
    expect(bytes[6]).toBe(0x1a);
    expect(bytes[7]).toBe(0x0a);
  });
});
