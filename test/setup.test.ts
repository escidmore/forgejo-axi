import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { invoke, parseJson } from './server.js';

const homes: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forgejo-axi-home-'));
  homes.push(dir);
  return dir;
}

/** An exec path the SDK's own install policy accepts for this tool. */
const INSTALLED =
  '/opt/node/lib/node_modules/forgejo-axi/dist/bin/forgejo-axi.js';

describe('setup hooks', () => {
  it('writes a session hook for every agent it supports', async () => {
    const home = await scratchHome();
    const result = await invoke(
      ['setup', 'hooks', '--json'],
      { HOME: home },
      undefined,
      INSTALLED,
    );
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      hooks: { installed: true, entry_point: INSTALLED },
    });

    const claude = parseJson<{
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    }>(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(claude.hooks.SessionStart[0]?.hooks[0]?.command).toContain(
      'forgejo-axi',
    );
    // Codex takes both a hook registration and a config entry; OpenCode takes
    // a plugin. All three are written, so none of the three agents is silently
    // skipped while the command reports success.
    await expect(
      readFile(join(home, '.codex', 'hooks.json'), 'utf8'),
    ).resolves.toContain('forgejo-axi');
    await expect(
      readFile(join(home, '.codex', 'config.toml'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(
        join(home, '.config', 'opencode', 'plugins', 'axi-forgejo-axi.js'),
        'utf8',
      ),
    ).resolves.toContain('forgejo-axi');
  });

  it('is a no-op on a second run', async () => {
    const home = await scratchHome();
    const settings = join(home, '.claude', 'settings.json');
    await invoke(['setup', 'hooks'], { HOME: home }, undefined, INSTALLED);
    const first = await readFile(settings, 'utf8');
    await invoke(['setup', 'hooks'], { HOME: home }, undefined, INSTALLED);
    expect(await readFile(settings, 'utf8')).toBe(first);
  });

  it('says so instead of claiming success when the entry point is not installed', async () => {
    const home = await scratchHome();
    // The SDK declines to wire a hook to a dev checkout or an unrelated
    // runner. That refusal is correct, and reporting it as an install would
    // be a confident lie about a file that was never written.
    const result = await invoke(
      ['setup', 'hooks', '--json'],
      { HOME: home },
      undefined,
      '/usr/bin/some-other-tool',
    );
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      hooks: {
        installed: false,
        reason: 'entry_point_not_an_installed_binary',
        entry_point: '/usr/bin/some-other-tool',
      },
    });
    await expect(
      readFile(join(home, '.claude', 'settings.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('reports a target it could not write instead of exiting 0', async () => {
    const home = await scratchHome();
    // A regular file where the agent's directory belongs makes the write fail.
    await writeFile(join(home, '.claude'), 'not a directory', 'utf8');
    const result = await invoke(
      ['setup', 'hooks', '--json'],
      { HOME: home },
      undefined,
      INSTALLED,
    );
    expect(result.exitCode).toBe(1);
    const output = parseJson<{ error: string; code: string }>(result.output);
    expect(output.code).toBe('SETUP_FAILED');
    expect(output.error).toContain('could not be written');
  });

  it('rejects an unknown setup command', async () => {
    const result = await invoke(['setup', 'nope', '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown setup command: nope');
  });

  it('serves setup help without touching the filesystem', async () => {
    const family = await invoke(['setup', '--help']);
    expect(family.output).toContain('forgejo-axi setup');
    expect(family.output).toContain('hooks');
    const command = await invoke(['setup', 'hooks', '--help']);
    expect(command.output).toContain('No host is contacted');
  });
});
