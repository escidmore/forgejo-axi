import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderSkill } from '../src/skill.js';

const SKILL_PATH = new URL('../skills/forgejo-axi/SKILL.md', import.meta.url);

// A missing file reads as empty so it fails the byte-compare with the hint
// below rather than an ENOENT stack.
const committed = (): Promise<string> =>
  readFile(SKILL_PATH, 'utf8').catch(() => '');

describe('agent skill', () => {
  it('is byte-for-byte what the generator produces', async () => {
    expect(
      await committed(),
      'skills/forgejo-axi/SKILL.md is stale or missing; run `npm run gen:skill`',
    ).toBe(renderSkill());
  });

  it('never carries a token value', async () => {
    expect(await committed()).not.toMatch(
      /FORGEJO_TOKEN[A-Z0-9_]*\s*[=:]\s*\S/,
    );
  });

  it('documents environment-only token configuration', async () => {
    expect(await committed()).toContain('FORGEJO_TOKEN_<HOST_KEY>');
  });

  it('installs the published package, not a source checkout', async () => {
    const skill = await committed();
    expect(skill).toContain('npm install -g forgejo-axi');
    expect(skill).not.toContain('npm link');
  });
});
