import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { assertWithinRoot } from '../safety/paths.ts';

const PROFILES_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface ProfileFile {
  name: string;
  defaultBudget: { max_turns: number; max_usd: number; max_minutes: number };
  personality: string;
}

interface ProfileFrontmatter {
  name: string;
  defaultBudget: {
    max_turns: number;
    max_usd: number;
    max_minutes: number;
  };
}

function validateFrontmatter(raw: unknown, filePath: string): ProfileFrontmatter {
  if (raw == null || typeof raw !== 'object') {
    throw new Error(`Profile ${filePath}: frontmatter is missing or not an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error(`Profile ${filePath}: frontmatter missing 'name'`);
  }
  if (obj.defaultBudget == null || typeof obj.defaultBudget !== 'object') {
    throw new Error(`Profile ${filePath}: frontmatter missing 'defaultBudget'`);
  }
  const budget = obj.defaultBudget as Record<string, unknown>;
  if (typeof budget.max_turns !== 'number') {
    throw new Error(`Profile ${filePath}: defaultBudget missing 'max_turns'`);
  }
  if (typeof budget.max_usd !== 'number') {
    throw new Error(`Profile ${filePath}: defaultBudget missing 'max_usd'`);
  }
  if (typeof budget.max_minutes !== 'number') {
    throw new Error(`Profile ${filePath}: defaultBudget missing 'max_minutes'`);
  }
  return {
    name: obj.name,
    defaultBudget: {
      max_turns: budget.max_turns,
      max_usd: budget.max_usd,
      max_minutes: budget.max_minutes,
    },
  };
}

function parseSection(body: string, heading: string, filePath: string): string {
  const parts = body.split(/^(?=# )/m);
  for (const part of parts) {
    const firstLine = part.split('\n')[0]?.trim() ?? '';
    if (firstLine.toLowerCase() === `# ${heading}`.toLowerCase()) {
      const content = part.split('\n').slice(1).join('\n').trim();
      if (!content) {
        throw new Error(`Profile ${filePath}: section '# ${heading}' is empty`);
      }
      return content;
    }
  }
  throw new Error(`Profile ${filePath}: missing section '# ${heading}'`);
}

export async function loadProfile(nameOrPath: string): Promise<ProfileFile> {
  let filePath: string;
  if (nameOrPath.endsWith('.md')) {
    // Custom profile path — must resolve to within cwd (user cannot reach above project)
    const candidate = path.isAbsolute(nameOrPath)
      ? nameOrPath
      : path.resolve(process.cwd(), nameOrPath);
    const cwd = path.resolve(process.cwd());
    const rel = path.relative(cwd, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Profile path '${nameOrPath}' escapes project directory (${cwd}). Custom profiles must live under cwd.`,
      );
    }
    filePath = candidate;
  } else {
    // Built-in slug — must resolve to within the profiles dir (no "../../etc/passwd")
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(nameOrPath)) {
      throw new Error(
        `Profile name '${nameOrPath}' is not a valid slug. Use lowercase alphanumeric+hyphens, or pass a path ending in .md.`,
      );
    }
    filePath = assertWithinRoot(`${nameOrPath}.md`, PROFILES_DIR, 'profile slug');
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot load profile '${nameOrPath}': file not found at ${filePath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Split frontmatter: must start with --- on first line
  if (!content.startsWith('---')) {
    throw new Error(`Profile ${filePath}: does not start with YAML frontmatter ('---')`);
  }

  const secondFence = content.indexOf('\n---', 3);
  if (secondFence === -1) {
    throw new Error(`Profile ${filePath}: unterminated YAML frontmatter (no closing '---')`);
  }

  const frontmatterRaw = content.slice(3, secondFence).trim();
  const body = content.slice(secondFence + 4); // skip the "\n---"

  const parsed = parseYaml(frontmatterRaw) as unknown;
  const frontmatter = validateFrontmatter(parsed, filePath);

  const personality = parseSection(body, 'Personality', filePath);

  return {
    name: frontmatter.name,
    defaultBudget: frontmatter.defaultBudget,
    personality,
  };
}
