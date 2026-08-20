#!/usr/bin/env node
import { tryFastPath } from 'axi-sdk-js/fast-path';
import { VERSION } from '../src/version.js';

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

// A bare version flag is answered without loading the command graph. Anything
// else falls through to the full CLI, which stays the single owner of every
// other argv shape including a version flag in any other position.
if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import('../src/cli.js');
  await main();
}
