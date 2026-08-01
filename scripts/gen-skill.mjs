import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { renderSkill } from '../dist/src/skill.js';

// skills/forgejo-axi/ is committed, so it exists in any checkout.
writeFileSync(
  new URL('../skills/forgejo-axi/SKILL.md', import.meta.url),
  renderSkill(),
);
