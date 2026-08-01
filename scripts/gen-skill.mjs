import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { renderSkill } from '../dist/src/skill.js';

const target = fileURLToPath(
  new URL('../skills/forgejo-axi/SKILL.md', import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderSkill());
