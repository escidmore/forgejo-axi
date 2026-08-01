#!/usr/bin/env node
import { main } from '../src/cli.js';

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
await main();
