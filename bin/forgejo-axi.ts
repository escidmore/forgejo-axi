#!/usr/bin/env node
import { main } from '../src/cli.js';
import { exitCleanlyOnEpipe } from '../src/epipe.js';

exitCleanlyOnEpipe(process.stdout);
await main();
