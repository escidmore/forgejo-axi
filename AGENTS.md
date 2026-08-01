# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `docs/contract.md` is the compatibility authority for commands, output schemas, status semantics, and exit codes.
- Run `npm run check` before committing; tests are local-only and use Forgejo 15/16 response fixtures plus fake HTTP/HTTPS servers.
- Capabilities must come from runtime API probing, never version assumptions. Forgejo 15.0.5 remains a first-class target; unsupported Actions logs are not failed status checks.
- Preserve canonical URL, token-scope/redaction, same-origin redirect, path-prefix, and expected-head merge protections when changing transport code.
- Do not add a license, publish a package, or run against a live Forgejo host without explicit user approval.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
