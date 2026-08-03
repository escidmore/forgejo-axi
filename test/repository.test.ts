import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url);

const packageJson = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));

describe('repository', () => {
  it('is publishable, so a release cannot be blocked by a stray private flag', async () => {
    expect((await packageJson())['private']).not.toBe(true);
  });

  it('declares MIT and ships the license text under a name npm includes', async () => {
    expect((await packageJson())['license']).toBe('MIT');
    const entries = await readdir(fileURLToPath(ROOT));
    expect(entries.filter((name) => /^licen[cs]e/i.test(name))).toEqual([
      'LICENSE',
    ]);
  });
});
