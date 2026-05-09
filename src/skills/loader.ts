/**
 * Skills loader — discovers and loads persona + playbook skills from the
 * repo-root `skills/` directory.
 *
 * Layout convention:
 *   skills/personas/<slug>/SKILL.md   — persona skills
 *   skills/playbooks/<name>/SKILL.md  — playbook skills
 *   skills/playbooks/<name>/handler.ts — playbook handler + inputShape
 *
 * The loader lives at src/skills/loader.ts (inside src/) but reads from
 * <repoRoot>/skills/ (outside src/).  The root is resolved via:
 *   path.dirname(fileURLToPath(import.meta.url))
 *
 * Design: shared playbook helper code stays in src/playbooks/*.ts.  Each
 * handler.ts re-exports the matching playbook object from those files.
 * This avoids code duplication while giving the skills format its own entry
 * point for discovery and dynamic import.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import type { PlaybookCategory, PlaybookContext } from '../playbooks/framework.ts';
import type { PlaybookOutcome } from '../playbooks/outcome.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Skill {
  /** Canonical name, e.g. "power-user" or "fill_and_verify". */
  name: string;
  type: 'persona' | 'playbook';
  description: string;
  /** For personas: the personality prose (everything after frontmatter). */
  body: string;
  /** Budget limits. Only present on persona skills. */
  defaultBudget?: {
    max_turns: number;
    max_usd: number;
    max_minutes: number;
  };
  /** Persona suite: 'attacker' for security agents, 'qa' for QA agents.
   *  Derived from the subdirectory (`attackers/` or `qa/`) or frontmatter. */
  category?: 'attacker' | 'qa';
  /** Attacker personas only: wave number (1-based). Wave 1 runs first,
   *  wave 2 starts when wave 1 completes, etc. QA personas ignore this. */
  wave?: number;
  /** Per-persona model override. When set, this model is used instead of the
   *  global attacker_model / qa_model. Allows recon agents to run on Haiku
   *  while exploitation agents stay on Sonnet. */
  model?: string;
  /** For playbooks: Zod raw shape imported from handler.ts. */
  inputShape?: z.ZodRawShape;
  /** For playbooks: the async run function from handler.ts. */
  // biome-ignore lint/suspicious/noExplicitAny: generic handler signature
  handler?: (input: any, ctx: PlaybookContext) => Promise<PlaybookOutcome>;
  estimatedDurationMs?: number;
  categories?: PlaybookCategory[];
  /** Playbook-only: when set, this playbook is exposed only to agents whose
   *  profile is in the allowlist. Used to keep speculative URL-guessing
   *  playbooks (sensitive_path_audit, idor_probe, route_404_probe) out of
   *  functional personas' tool lists — those personas drift toward
   *  cheap-finding probes and stop completing real flows. Unset = available
   *  to every persona. */
  personaAllowlist?: string[];
}

export interface SkillsBundle {
  personas: Map<string, Skill>;
  playbooks: Map<string, Skill>;
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

interface SkillFrontmatter {
  name: string;
  type: 'persona' | 'playbook';
  description: string;
  defaultBudget?: { max_turns: number; max_usd: number; max_minutes: number };
  category?: 'attacker' | 'qa';
  wave?: number;
  model?: string;
  categories?: PlaybookCategory[];
  estimatedDurationMs?: number;
  personaAllowlist?: string[];
}

function parseFrontmatter(
  content: string,
  filePath: string,
): { fm: SkillFrontmatter; body: string } {
  if (!content.startsWith('---')) {
    throw new Error(`SKILL.md at ${filePath}: does not start with YAML frontmatter ('---')`);
  }
  const secondFence = content.indexOf('\n---', 3);
  if (secondFence === -1) {
    throw new Error(`SKILL.md at ${filePath}: unterminated YAML frontmatter (no closing '---')`);
  }
  const rawYaml = content.slice(3, secondFence).trim();
  const body = content.slice(secondFence + 4).trim();

  const parsed = parseYaml(rawYaml) as unknown;
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error(`SKILL.md at ${filePath}: frontmatter is not a YAML object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error(`SKILL.md at ${filePath}: frontmatter missing 'name'`);
  }
  if (obj.type !== 'persona' && obj.type !== 'playbook') {
    throw new Error(
      `SKILL.md at ${filePath}: frontmatter 'type' must be 'persona' or 'playbook', got '${obj.type}'`,
    );
  }
  if (typeof obj.description !== 'string' || !obj.description) {
    throw new Error(`SKILL.md at ${filePath}: frontmatter missing 'description'`);
  }

  const fm: SkillFrontmatter = {
    name: obj.name,
    type: obj.type,
    description: obj.description,
  };

  if (obj.defaultBudget != null && typeof obj.defaultBudget === 'object') {
    const b = obj.defaultBudget as Record<string, unknown>;
    if (
      typeof b.max_turns === 'number' &&
      typeof b.max_usd === 'number' &&
      typeof b.max_minutes === 'number'
    ) {
      fm.defaultBudget = {
        max_turns: b.max_turns,
        max_usd: b.max_usd,
        max_minutes: b.max_minutes,
      };
    }
  }

  if (obj.category === 'attacker' || obj.category === 'qa') {
    fm.category = obj.category;
  }

  if (typeof obj.wave === 'number' && obj.wave >= 1) {
    fm.wave = obj.wave;
  }

  if (typeof obj.model === 'string' && obj.model.length > 0) {
    fm.model = obj.model;
  }

  if (Array.isArray(obj.categories)) {
    fm.categories = obj.categories as PlaybookCategory[];
  }

  if (typeof obj.estimatedDurationMs === 'number') {
    fm.estimatedDurationMs = obj.estimatedDurationMs;
  }

  if (Array.isArray(obj.personaAllowlist)) {
    fm.personaAllowlist = obj.personaAllowlist
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  return { fm, body };
}

// ─── Handler module shape ─────────────────────────────────────────────────────

interface HandlerModule {
  // biome-ignore lint/suspicious/noExplicitAny: handler input varies per playbook
  handler: (input: any, ctx: PlaybookContext) => Promise<PlaybookOutcome>;
  inputShape: z.ZodRawShape;
}

// ─── Main loader ──────────────────────────────────────────────────────────────

/**
 * Resolve the default skills root: two levels up from this file's directory
 * (from src/skills/ → repo root), then into skills/.
 */
function defaultSkillsRoot(): string {
  // import.meta.url → file:///...../src/skills/loader.ts
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, '../../skills');
}

/**
 * Load all skills from the given root directory (defaults to repo-root skills/).
 * Returns a SkillsBundle with two Maps keyed by skill name.
 */
export async function loadSkills(rootDir?: string): Promise<SkillsBundle> {
  const root = rootDir ?? defaultSkillsRoot();

  const personas = new Map<string, Skill>();
  const playbooks = new Map<string, Skill>();

  // ── Load personas ──────────────────────────────────────────────────────────
  // Scan three locations:
  //   skills/personas/<slug>/SKILL.md          (legacy flat layout)
  //   skills/personas/attackers/<slug>/SKILL.md (attacker suite)
  //   skills/personas/qa/<slug>/SKILL.md        (QA suite)
  // Category is inferred from the subdirectory name, overridden by frontmatter.
  const personasDir = path.join(root, 'personas');
  const suiteEntries: Array<{ dir: string; inferredCategory?: 'attacker' | 'qa' }> = [
    { dir: personasDir },
    { dir: path.join(personasDir, 'attackers'), inferredCategory: 'attacker' },
    { dir: path.join(personasDir, 'qa'), inferredCategory: 'qa' },
  ];

  for (const { dir, inferredCategory } of suiteEntries) {
    let slugs: string[];
    try {
      slugs = await readdir(dir);
    } catch {
      slugs = [];
    }

    for (const slug of slugs) {
      if (slug === 'attackers' || slug === 'qa') continue;
      const skillFile = path.join(dir, slug, 'SKILL.md');
      let content: string;
      try {
        content = await readFile(skillFile, 'utf-8');
      } catch {
        continue;
      }
      const { fm, body } = parseFrontmatter(content, skillFile);
      const category = fm.category ?? inferredCategory;
      const skill: Skill = {
        name: fm.name,
        type: 'persona',
        description: fm.description,
        body,
        defaultBudget: fm.defaultBudget,
        category,
        wave: fm.wave,
        model: fm.model,
      };
      personas.set(fm.name, skill);
    }
  }

  // ── Load playbooks ─────────────────────────────────────────────────────────
  const playbooksDir = path.join(root, 'playbooks');
  let playbookNames: string[];
  try {
    playbookNames = await readdir(playbooksDir);
  } catch {
    playbookNames = [];
  }

  for (const name of playbookNames) {
    const skillFile = path.join(playbooksDir, name, 'SKILL.md');
    let content: string;
    try {
      content = await readFile(skillFile, 'utf-8');
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(content, skillFile);

    // Dynamically import the handler module (TypeScript via tsx/ts-node resolution)
    const handlerPath = path.join(playbooksDir, name, 'handler.ts');
    let handlerMod: HandlerModule;
    try {
      // Use a URL-form import so Node/tsx can resolve the TypeScript file.
      handlerMod = (await import(/* @vite-ignore */ `file://${handlerPath}`)) as HandlerModule;
    } catch (err) {
      console.error(
        `Skills loader: failed to import handler for playbook '${fm.name}' at ${handlerPath}: ${
          err instanceof Error ? err.message : String(err)
        }. Skipping this playbook.`,
      );
      continue;
    }

    if (typeof handlerMod.handler !== 'function') {
      console.error(
        `Skills loader: handler.ts for playbook '${fm.name}' must export a 'handler' function. Skipping.`,
      );
      continue;
    }
    if (handlerMod.inputShape == null || typeof handlerMod.inputShape !== 'object') {
      console.error(
        `Skills loader: handler.ts for playbook '${fm.name}' must export an 'inputShape' object. Skipping.`,
      );
      continue;
    }

    const skill: Skill = {
      name: fm.name,
      type: 'playbook',
      description: fm.description,
      body,
      categories: fm.categories,
      estimatedDurationMs: fm.estimatedDurationMs,
      inputShape: handlerMod.inputShape,
      handler: handlerMod.handler,
      personaAllowlist: fm.personaAllowlist,
    };
    playbooks.set(fm.name, skill);
  }

  return { personas, playbooks };
}
