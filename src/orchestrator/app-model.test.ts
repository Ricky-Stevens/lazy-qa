/**
 * Tests for app-model.ts — the pure rendering helper.
 * buildApplicationModel requires an LLM call and is not tested here.
 */

import { describe, expect, it } from 'vitest';
import { type ApplicationModel, renderApplicationModelForPrompt } from './app-model.ts';

function makeModel(overrides: Partial<ApplicationModel> = {}): ApplicationModel {
  return {
    appType: 'admin portal',
    errorPatterns: ['red toast at top right'],
    successPatterns: ['green toast notification'],
    emptyStates: ['"No data available" with illustration'],
    sortBehavior: 'server-side (column header updates but rows may not visually reorder)',
    authProvider: 'Auth0',
    navigationStructure: 'left sidebar with 8 items',
    knownPatterns: ['first table column is always a row-select checkbox'],
    ...overrides,
  };
}

describe('renderApplicationModelForPrompt', () => {
  it('includes all non-empty fields', () => {
    const result = renderApplicationModelForPrompt(makeModel());
    expect(result).toContain('admin portal');
    expect(result).toContain('red toast at top right');
    expect(result).toContain('green toast notification');
    expect(result).toContain('No data available');
    expect(result).toContain('server-side');
    expect(result).toContain('Auth0');
    expect(result).toContain('left sidebar');
    expect(result).toContain('row-select checkbox');
  });

  it('starts with APPLICATION CONTEXT header', () => {
    const result = renderApplicationModelForPrompt(makeModel());
    expect(result.startsWith('APPLICATION CONTEXT')).toBe(true);
  });

  it('omits authProvider when "none detected"', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({ authProvider: 'none detected' }),
    );
    expect(result).not.toContain('Auth provider');
  });

  it('omits authProvider when "unknown"', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({ authProvider: 'unknown' }),
    );
    expect(result).not.toContain('Auth provider');
  });

  it('omits sortBehavior when "unknown"', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({ sortBehavior: 'unknown' }),
    );
    expect(result).not.toContain('Sort behaviour');
  });

  it('omits navigationStructure when "unknown"', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({ navigationStructure: 'unknown' }),
    );
    expect(result).not.toContain('Navigation');
  });

  it('omits knownPatterns section when empty', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({ knownPatterns: [] }),
    );
    expect(result).not.toContain('Known-normal patterns');
  });

  it('renders multiple known patterns as bullet list', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({
        knownPatterns: ['pattern one', 'pattern two'],
      }),
    );
    expect(result).toContain('  - pattern one');
    expect(result).toContain('  - pattern two');
  });

  it('omits empty arrays gracefully', () => {
    const result = renderApplicationModelForPrompt(
      makeModel({
        errorPatterns: [],
        successPatterns: [],
        emptyStates: [],
      }),
    );
    expect(result).not.toContain('Error handling');
    expect(result).not.toContain('Success feedback');
    expect(result).not.toContain('Empty states');
  });
});
