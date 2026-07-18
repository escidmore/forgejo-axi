import { spawnSync } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name === 'FORGEJO_TOKEN' || name.startsWith('FORGEJO_TOKEN_')) {
    delete env[name];
  }
}

for (const args of [['--help'], ['--version']]) {
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
}
