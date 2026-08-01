import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderSkill } from '../src/skill.js';

const SKILL_PATH = new URL('../skills/forgejo-axi/SKILL.md', import.meta.url);

describe('agent skill', () => {
  it('is byte-for-byte what the generator produces', async () => {
    const committed = await readFile(SKILL_PATH, 'utf8');
    expect(
      committed,
      'skills/forgejo-axi/SKILL.md is stale; run `npm run gen:skill`',
    ).toBe(renderSkill());
  });

  it('regenerates deterministically', () => {
    expect(renderSkill()).toBe(renderSkill());
  });

  it('never carries a token value', async () => {
    const committed = await readFile(SKILL_PATH, 'utf8');
    expect(committed).not.toMatch(/FORGEJO_TOKEN[A-Z0-9_]*\s*[=:]\s*\S/);
    expect(committed).toContain('read from environment variables only');
  });

  it('claims no registry runner install', async () => {
    const committed = await readFile(SKILL_PATH, 'utf8');
    expect(committed).not.toMatch(/npx\s+(-y\s+)?forgejo-axi/);
    expect(committed).toContain('npm link');
  });
});
