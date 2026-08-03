/**
 * Repository-only completion verification: proof that a fresh consumer can
 * clone, build, discover the agent skill, and run the CLI without publishing
 * anything or reaching a Forgejo host. It answers a question about the
 * committed tree, so it refuses to run against a dirty one.
 *
 * The checkout, the install prefix, and the agent home the skill installer
 * writes to all live inside one temporary directory, and every child runs
 * without Forgejo configuration in its environment. The shared npm cache is
 * the only thing outside that directory a run writes to.
 */
import { ok as assert } from 'node:assert';
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

// Pinned exactly, like every other dependency here: `npx -y` executes whatever
// this resolves to, so a range would hand a floating third party the run.
const SKILLS_CLI = 'skills@1.5.21';

/**
 * No child may see Forgejo configuration: it keeps the suite honest about
 * being local-only, and keeps real tokens out of dependency lifecycle scripts.
 */
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
    // A full `npm run check` outruns the 1 MB default, which would otherwise
    // surface as a null status with the real cause hidden in `error`.
    maxBuffer: 64 * 1024 * 1024,
    env: unconfiguredEnv(),
    ...options,
  });
  const label = `${command} ${args.join(' ')}`;
  if (result.error) {
    throw new Error(`${label} could not run`, { cause: result.error });
  }
  if (result.status !== 0) {
    const how = result.signal
      ? `was killed by ${result.signal}`
      : `exited ${result.status}`;
    throw new Error(
      `${label} ${how}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
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
    // Cloning copies HEAD only, so a dirty tree would report a confident pass
    // for a commit that does not contain the change being verified.
    const dirty = sh('git', [
      '-C',
      REPO,
      'status',
      '--porcelain',
    ]).stdout.trim();
    assert(!dirty, `commit or stash these first:\n${dirty}`);
    sh('git', ['clone', '--quiet', '--no-hardlinks', REPO, checkout]);
    const head = sh('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD']);
    console.log(`      verifying ${head.stdout.trim()}`);
  });

  step('npm ci installs from the committed lockfile', () => {
    sh('npm', ['ci'], { cwd: checkout });
  });

  step('npm run check passes', () => {
    sh('npm', ['run', 'check'], { cwd: checkout });
  });

  step('npm pack --dry-run ships the CLI and the skill', () => {
    // npm writes the file listing to stderr.
    const { stdout, stderr } = sh('npm', ['pack', '--dry-run'], {
      cwd: checkout,
    });
    for (const file of [
      'dist/bin/forgejo-axi.js',
      'skills/forgejo-axi/SKILL.md',
    ]) {
      assert(`${stdout}${stderr}`.includes(file), `packed files omit ${file}`);
    }
  });

  step('a fresh source install runs unconfigured', () => {
    // The documented install builds before linking, and nothing here may rely
    // on an earlier step having left dist/ behind.
    sh('npm', ['run', 'build'], { cwd: checkout });
    sh('npm', ['install', '--global', '--prefix', prefix, checkout]);
    const { version } = JSON.parse(
      readFileSync(join(checkout, 'package.json'), 'utf8'),
    );
    assert(
      sh(cli, ['--help']).stdout.includes('forgejo-axi'),
      '--help printed no command catalog',
    );
    assert(
      sh(cli, ['--version']).stdout.trim() === version,
      `--version disagrees with package.json ${version}`,
    );
    assert(
      sh(cli, []).stdout.includes('configured: false'),
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
        // HOME and XDG_CONFIG_HOME are independent inputs; leaving either
        // pointed at the developer would let the installer escape.
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
  rmSync(temp, { recursive: true, force: true });
} catch (error) {
  console.error(`\nfailed — the checkout is left at ${temp} for inspection`);
  throw error;
}
