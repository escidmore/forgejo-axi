import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name === 'FORGEJO_TOKEN' || name.startsWith('FORGEJO_TOKEN_')) {
    delete env[name];
  }
}

function run(args) {
  const result = spawnSync(
    process.execPath,
    ['dist/bin/forgejo-axi.js', ...args],
    {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Smoke command ${args.join(' ')} exited ${result.status}`);
  }
  if (!result.stdout.trim()) {
    throw new Error(`Smoke command ${args.join(' ')} emitted no output`);
  }
  return result.stdout;
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Every bare version flag is answered by the entry point's fast path, which
// never loads the command graph. Asserting the value here is what keeps that
// shortcut honest: a fast path that answered with anything other than the
// package version would be a faster wrong answer.
for (const flag of ['--version', '-v', '-V']) {
  const output = run([flag]);
  if (output !== `${version}\n`) {
    throw new Error(
      `Smoke command ${flag} printed ${JSON.stringify(output)}, expected ${JSON.stringify(`${version}\n`)}`,
    );
  }
}

// Anything that is not a bare version flag must still reach the full CLI.
const help = run(['--help']);
if (!help.includes('forgejo-axi status')) {
  throw new Error('Smoke command --help did not reach the full command graph');
}
