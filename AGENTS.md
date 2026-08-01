# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `docs/contract.md` is the compatibility authority for commands, output schemas, status semantics, and exit codes.
- Run `npm run check` before committing; its tests use Forgejo 15/16 response fixtures plus fake HTTP/HTTPS servers.
- Live testing is required, not optional: before committing any change to API requests, response handling, or fixtures, run both live lanes locally (`npm run test:live -- 15` and `-- 16`, hosts from the mise/sops environment). The live lanes outrank the fixtures — when a real host and a fixture disagree, the fixture is wrong; fix the fixture to match the host, never the reverse. See `docs/live-test-matrix.md`.
- Capabilities must come from runtime API probing, never version assumptions. Forgejo 15.0.5 remains a first-class target; unsupported Actions logs are not failed status checks.
- Preserve canonical URL, token-scope/redaction, same-origin redirect, path-prefix, and expected-head merge protections when changing transport code.
- `skills/forgejo-axi/SKILL.md` is generated, never hand-edited. Its command catalog comes from `src/help.ts`, the guidance the CLI itself serves on `--help`; the prose around it comes from `src/skill.ts`. Edit whichever source applies, run `npm run gen:skill`, and commit the result; `npm run check` byte-compares the two and fails on drift. That check proves the skill matches its sources, not that its prose still matches runtime behavior — `docs/contract.md` remains the authority for output schemas and exit codes.
- Do not add a license or publish a package without explicit user approval. The env-configured local live hosts are approved standing targets; never point live tests at any other host or at a production repository.
