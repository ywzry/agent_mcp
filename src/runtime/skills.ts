import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  body: string;
  tokens_estimate: number;
}

export interface SkillCatalog {
  skills: SkillInfo[];
  warnings: string[];
}

const MAX_SKILL_BYTES = 512 * 1024;

/** Loads metadata only; bodies stay on disk until skill_read asks for one. */
export function loadSkillCatalog(roots: readonly string[]): SkillCatalog {
  const skills: SkillInfo[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) { warnings.push(`skill root does not exist: ${root}`); continue; }
    const rootReal = safeReal(root);
    if (!rootReal) { warnings.push(`skill root is unreadable: ${root}`); continue; }
    for (const entry of readdirSync(root)) {
      const directory = join(root, entry);
      const file = join(directory, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const real = realpathSync(file);
        if (!inside(rootReal, real)) { warnings.push(`skill escapes its root: ${file}`); continue; }
        if (statSync(real).size > MAX_SKILL_BYTES) { warnings.push(`skill too large: ${file}`); continue; }
        const raw = readFileSync(real, 'utf8');
        const meta = parseFrontmatter(raw);
        const name = meta.name ?? entry;
        if (seen.has(name)) { warnings.push(`duplicate skill name ${name}; keeping the first`); continue; }
        seen.add(name);
        skills.push({
          name,
          description: meta.description ?? '',
          path: join(directory, 'SKILL.md'),
          body: raw,
          tokens_estimate: Math.ceil(raw.length / 4),
        });
      } catch (error) {
        warnings.push(`cannot read skill ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { skills, warnings };
}

export function readSkillBody(skill: SkillInfo): string {
  // Bodies are loaded with the catalog; enforce the size limit again in case a
  // caller constructs a SkillInfo from persisted metadata.
  return skill.body.length > MAX_SKILL_BYTES ? skill.body.slice(0, MAX_SKILL_BYTES) : skill.body;
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  try {
    const value = parse(text.slice(3, end)) as Record<string, unknown>;
    return {
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
    };
  } catch { return {}; }
}

function safeReal(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && !resolve(rel).startsWith('..'));
}

export function skillPathLabel(path: string): string {
  return `${basename(dirname(path))}${sep}${basename(path)}`;
}
