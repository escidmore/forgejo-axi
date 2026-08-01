import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url);

const packageJson = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));

describe('repository', () => {
  it('stays private, so nothing can be published by accident', async () => {
    expect((await packageJson())['private']).toBe(true);
  });

  it('carries no license until one is chosen deliberately', async () => {
    expect(await packageJson()).not.toHaveProperty('license');
    const entries = await readdir(fileURLToPath(ROOT));
    expect(entries.filter((name) => /^licen[cs]e/i.test(name))).toEqual([]);
  });
});
