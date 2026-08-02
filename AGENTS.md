# Git policies

- All work on new branches prefixed with 'eve/'
- PRs should be prefixed with Linear issue number 'FJA-##:' when one exists
- PR body should mention the Linear issue number when one exists

# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `docs/contract.md` is the compatibility authority for commands, output schemas, status semantics, and exit codes.
- Run `npm run check` before committing; its tests use Forgejo 15/16 response fixtures plus fake HTTP/HTTPS servers.
- `.pre-commit-config.yaml` runs the `npm run lint` pair — prettier and eslint — over staged files under [prek](https://github.com/j178/prek), so the cheapest half of `npm run check` cannot be skipped. Both hooks invoke this checkout's `node_modules`, which is why a fresh worktree needs its own `npm ci`: with none, `npx prettier` resolves a newer release from the registry than package-lock pins, calls a differently-formatted file clean, and CI then rejects it.
- Live testing is required, not optional: before committing any change to API requests, response handling, or fixtures, run both live lanes locally (`npm run test:live -- 15` and `-- 16`, hosts from the mise/sops environment). The live lanes outrank the fixtures — when a real host and a fixture disagree, the fixture is wrong; fix the fixture to match the host, never the reverse. See `docs/live-test-matrix.md`.
- Capabilities must come from runtime API probing, never version assumptions. Forgejo 15.0.5 remains a first-class target; unsupported Actions logs are not failed status checks.
- Preserve canonical URL, token-scope/redaction, same-origin redirect, path-prefix, and expected-head merge protections when changing transport code.
- `skills/forgejo-axi/SKILL.md` is generated, never hand-edited. Its command catalog comes from `src/help.ts`, the guidance the CLI itself serves on `--help`; the prose around it comes from `src/skill.ts`. Edit whichever source applies, run `npm run gen:skill`, and commit the result; `npm run check` byte-compares the two and fails on drift. That check proves the skill matches its sources, not that its prose still matches runtime behavior — `docs/contract.md` remains the authority for output schemas and exit codes.
- `npm run verify` is the repository-completion check: a clean clone in a temporary directory gets `npm ci`, `npm run check`, and `npm pack --dry-run`, then a throwaway install prefix runs `--help`, `--version`, and the unconfigured home view, and a throwaway agent home proves the skill installer finds `forgejo-axi`. It refuses a dirty working tree, because it clones HEAD and can only speak for that commit. No Forgejo host is contacted, and every child runs without Forgejo variables in its environment; the shared npm cache is the only thing a run writes outside its temporary directory.
- Do not add a license or publish a package without explicit user approval. The env-configured local live hosts are approved standing targets; never point live tests at any other host or at a production repository.
- Posting a comment on a Linear issue is pre-approved when a finding materially affects that issue — a result that invalidates its premise, answers a question it left open, or makes a follow-up it proposed unnecessary belongs on the issue, not only in the pull request that found it. Say what changed and what it means for the issue, not just that work happened.
- Changing an issue's state to "In Progress" when beginning work on an issue is also pre-approved
- Otherwise creating, closing, or restating the state of an issue still needs approval.
