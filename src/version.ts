import { fileURLToPath } from 'node:url';
import { readNearestPackageJson } from 'axi-sdk-js';

/**
 * Single version source: the nearest package.json above this module, which is
 * this package's own whether running from src/ or dist/src/.
 */
export const VERSION =
  readNearestPackageJson(fileURLToPath(import.meta.url)).version ?? '0.0.0';
