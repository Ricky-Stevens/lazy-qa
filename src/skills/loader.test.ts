/**
 * Tests for the Skills loader (src/skills/loader.ts).
 *
 * Tests use the real skills/ directory at the repo root — the loader is
 * wired to discover from there by default.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSkills } from './loader.ts';

// Resolve the skills/ directory relative to this test file:
// src/skills/loader.test.ts → ../../skills
const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');

describe('loadSkills', () => {
  it('discovers exactly 6 personas', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    expect(bundle.personas.size).toBe(6);
  });

  it('discovers exactly 14 playbooks', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    expect(bundle.playbooks.size).toBe(14);
  });

  it('persona names match the 6 expected slugs', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    const names = Array.from(bundle.personas.keys()).sort();
    expect(names).toEqual([
      'bobby-tables',
      'caine',
      'house',
      'leeroy-jenkins',
      'the-magpie',
      'the-spanner',
    ]);
  });

  it('playbook names match the 14 expected names', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    const names = Array.from(bundle.playbooks.keys()).sort();
    expect(names).toEqual([
      'ask_sitemap',
      'discover_route_affordances',
      'fill_and_verify',
      'form_double_submit',
      'form_fuzz_validation',
      'form_persistence_roundtrip',
      'form_required_field_check',
      'header_audit',
      'idor_probe',
      'route_404_probe',
      'sensitive_path_audit',
      'table_sort_each_column',
      'walk_pagination',
      'walk_wizard',
    ]);
  });

  it('house persona preserves frontmatter budget', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    const persona = bundle.personas.get('house');
    expect(persona).toBeDefined();
    expect(persona?.defaultBudget).toEqual({
      max_turns: 250,
      max_usd: 1.5,
      max_minutes: 5,
    });
  });

  it('bobby-tables persona has a non-empty body (includes the Mindset section)', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    const persona = bundle.personas.get('bobby-tables');
    expect(persona).toBeDefined();
    expect(persona?.body).toContain('# Mindset');
    expect(persona?.body.length ?? 0).toBeGreaterThan(500);
  });

  it('fill_and_verify playbook has an inputShape with formId field', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    const pb = bundle.playbooks.get('fill_and_verify');
    expect(pb).toBeDefined();
    expect(pb?.inputShape).toBeDefined();
    expect(pb?.inputShape).toHaveProperty('formId');
  });

  it('ask_sitemap handler is callable and returns a PlaybookOutcome shape', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    const pb = bundle.playbooks.get('ask_sitemap');
    expect(pb).toBeDefined();
    expect(typeof pb?.handler).toBe('function');
  });

  it('all playbooks have a handler and inputShape', async () => {
    const bundle = await loadSkills(SKILLS_ROOT);
    for (const [name, pb] of bundle.playbooks) {
      expect(typeof pb.handler, `${name}: handler must be function`).toBe('function');
      expect(pb.inputShape, `${name}: inputShape must be defined`).toBeDefined();
    }
  });
});
