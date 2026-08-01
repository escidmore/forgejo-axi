/**
 * Repository-only completion verification: proof that a fresh consumer can
 * clone, build, discover the agent skill, and run the CLI without publishing
 * anything or reaching a Forgejo host. The checkout, the install prefix, and
 * the agent home the skill installer writes to all live inside one temporary
 * directory, so a run never mutates the developer's own configuration.
 */
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Pinned to a minor so skill discovery stays reproducible without freezing on
// a patch release.
const SKILLS_CLI = 'skills@1.5';

/** The CLI has to prove itself with no Forgejo configuration of any kind. */
function unconfiguredEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of Object.keys(env)) {
    if (name.startsWith('FORGEJO_')) delete env[name];
  }
  return env;
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\n` +
        `${result.stdout}${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function step(name, run) {
  run();
  console.log(`ok  ${name}`);
}

const temp = mkdtempSync(join(tmpdir(), 'forgejo-axi-verify-'));
const checkout = join(temp, 'checkout');
const prefix = join(temp, 'prefix');
const home = join(temp, 'home');
const cli = join(prefix, 'bin', 'forgejo-axi');

try {
  step('clean checkout of the committed tree', () => {
    const dirty = sh('git', ['-C', REPO, 'status', '--porcelain']).trim();
    if (dirty) {
      console.warn('warn  uncommitted changes are not covered by this run');
    }
    sh('git', ['clone', '--quiet', '--no-hardlinks', REPO, checkout]);
    const head = sh('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD']);
    console.log(`      verifying ${head.trim()}`);
  });

  step('npm ci installs from the committed lockfile', () => {
    sh('npm', ['ci'], { cwd: checkout });
  });

  step('npm run check passes', () => {
    sh('npm', ['run', 'check'], { cwd: checkout, env: unconfiguredEnv() });
  });

  step('npm pack --dry-run ships the CLI and the skill', () => {
    const listing = sh('npm', ['pack', '--dry-run'], { cwd: checkout });
    for (const file of [
      'dist/bin/forgejo-axi.js',
      'skills/forgejo-axi/SKILL.md',
    ]) {
      assert(listing.includes(file), `packed files omit ${file}`);
    }
  });

  step('a fresh source install runs unconfigured', () => {
    sh('npm', ['install', '--global', '--prefix', prefix, checkout]);
    const { version } = JSON.parse(
      readFileSync(join(checkout, 'package.json'), 'utf8'),
    );
    const env = unconfiguredEnv();
    assert(
      sh(cli, ['--help'], { env }).includes('forgejo-axi'),
      '--help printed no command catalog',
    );
    assert(
      sh(cli, ['--version'], { env }).trim() === version,
      `--version disagrees with package.json ${version}`,
    );
    assert(
      sh(cli, [], { env }).includes('configured: false'),
      'the home view did not report unconfigured state',
    );
  });

  step(`${SKILLS_CLI} finds the skill in an isolated agent home`, () => {
    mkdirSync(home);
    sh(
      'npx',
      [
        '-y',
        SKILLS_CLI,
        'add',
        checkout,
        '--skill',
        'forgejo-axi',
        '--agent',
        'claude-code',
        '--global',
        '--yes',
      ],
      {
        env: unconfiguredEnv({
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
        }),
      },
    );
    // Landing under the isolated home is what proves the override took hold;
    // an ignored HOME would have left this path empty.
    const installed = join(
      home,
      '.claude',
      'skills',
      'forgejo-axi',
      'SKILL.md',
    );
    assert(existsSync(installed), `installer wrote no skill to ${installed}`);
    assert(
      readFileSync(installed, 'utf8') ===
        readFileSync(join(checkout, 'skills/forgejo-axi/SKILL.md'), 'utf8'),
      'the installed skill differs from the committed one',
    );
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
