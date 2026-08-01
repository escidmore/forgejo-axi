# Contributing

Issues and pull requests are both welcome.

## Getting set up

Requires Node.js 20 or newer, plus an `openssl` executable for the ephemeral
custom-CA HTTPS test.

```console
npm ci
npm run check
```

`npm run check` runs lint, typecheck, the unit tests, and the smoke test. It
uses fake HTTP/HTTPS servers and recorded Forgejo 15/16 fixtures, so it needs
no Forgejo instance and mutates nothing.

## What the contract freezes

[`docs/contract.md`](docs/contract.md) is the compatibility authority. Command
names, field meanings, enum values, and exit semantics change only in a major
release. Additive object fields and new capability names are fine in a minor.
A change that renames a flag or repurposes a field is not a bug fix, however
small the diff looks.

Capabilities come from probing the runtime API, never from version assumptions.
An unsupported capability is a successful outcome reported as `unsupported`, not
a failure.

## The generated skill

`skills/forgejo-axi/SKILL.md` is generated and must never be hand-edited. Its
command catalog comes from `src/help.ts` and the prose around it from
`src/skill.ts`. Edit whichever source applies, run `npm run gen:skill`, and
commit the result. `npm run check` byte-compares the two and fails on drift.

## Live lanes

Changes to API requests, response handling, or fixtures need verification
against a real Forgejo. Two lanes exist, one per supported major:

```console
npm run test:live -- 15
npm run test:live -- 16
```

Each lane reads its target from the environment, so they run against whatever
hosts you have:

| Variable                                  | Lane |
| ----------------------------------------- | ---- |
| `FORGEJO_15_BASE_URL`, `FORGEJO_15_TOKEN` | 15   |
| `FORGEJO_BASE_URL`, `FORGEJO_TOKEN`       | 16   |
| `FORGEJO_LIVE_REPO`                       | both |

[`docs/live-test-matrix.md`](docs/live-test-matrix.md) describes what each lane
covers and how to prepare a repository for it.

**The lanes mutate the repository they point at.** Use a throwaway repository,
never one that matters.

Not everyone has both versions running, and that is fine — say in the pull
request which lanes you ran, and a maintainer will cover the rest. What matters
is that nobody guesses. When a live host and a fixture disagree, the host is
right and the fixture gets fixed to match, never the reverse.

## Pull requests

One logical change per commit, imperative mood, subject under 72 characters,
prefixed with `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, or
`ci`. Describe what the code does now rather than how it got there.
