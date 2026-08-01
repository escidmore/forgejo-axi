# Plan 004: decide the `@toon-format/toon` major version before 1.0.0 freezes the output contract

> **Executor instructions**: This is an **investigation** plan. Its deliverable
> is a measured comparison and a draft decision record — you must NOT change
> the dependency version. Follow it step by step and stop at the STOP
> conditions. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8ee9a1b..HEAD -- package.json src/cli.ts docs/contract.md`
> If any of those changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but see "Timing" below — this is most valuable before
  PR #13 lands)
- **Category**: dependency / migration
- **Planned at**: commit `8ee9a1b`, 2026-08-01

## Why this matters

`forgejo-axi` emits TOON by default and JSON only under `--json`. The TOON
encoder is therefore not an implementation detail — it _is_ the default output
contract, the bytes every agent consuming this CLI parses.

That encoder is pinned at `@toon-format/toon` 2.1.0. The current release is
4.1.0: two major versions ahead. Nobody has established what changed between
them. Two consequences follow:

1. **A silent break is one `npm update` away.** If TOON's encoding changed
   across either major, the first person to bump the dependency changes every
   consumer's parse target without touching a line of `src/`. Nothing in the
   test suite would necessarily catch it — the tests assert on parsed structure
   via `parseJson`, not on encoded TOON bytes.
2. **The freeze is imminent.** PR #13 ("Prepare the first public npm release")
   sets version 1.0.0 and leans on `docs/contract.md`'s promise that output
   shape changes only in a major release. Publishing 1.0.0 on a two-majors-stale
   encoder means either carrying that lag into the supported line, or taking the
   output change as a 2.0.0 shortly after 1.0.0 ships.

The lazy correct move is to find out _now_, cheaply, whether the encodings
differ at all. If they are byte-identical for the shapes this CLI emits, the
bump is a non-event and can be recorded as safe. If they differ, that is a
decision the maintainer needs to make deliberately, before 1.0.0, not
accidentally afterwards.

**Timing**: this is worth doing before PR #13 merges. It does not block that
PR — the finding may well be "no change needed" — but the answer is much more
useful before a version number promises stability than after.

## Current state

Files involved:

- `package.json` — declares `"@toon-format/toon": "2.1.0"` under
  `dependencies` (an exact pin, not a range).
- `src/cli.ts` — the sole consumer, in `render` at lines 1187–1188.
- `docs/contract.md` — line 54 establishes TOON as the default stdout format.
- `test/fixtures/forgejo-15.json`, `test/fixtures/forgejo-16.json` — recorded
  Forgejo responses, the raw material for representative output shapes.

The only use of the encoder anywhere in `src/`, `src/cli.ts:1187-1188`:

```ts
const render = (output: unknown, json: boolean): string =>
  json ? JSON.stringify(output) : encode(output);
```

`encode` is imported from `@toon-format/toon` at the top of `src/cli.ts`.

`npm outdated` at `8ee9a1b` reports:

```
@toon-format/toon   2.1.0  ->  4.1.0
```

The dependency is pinned exactly, so `npm ci` reproduces 2.1.0 and no automatic
drift is possible — the lag is stable, not creeping. That is why this is a
scheduled decision rather than an incident.

### Repo conventions to match

- **Contract discipline** (`CLAUDE.md`): `docs/contract.md` is the
  compatibility authority for output schemas. It describes the _shape_ of
  documents; the encoder decides how that shape is serialised.
- **ADRs** live in `docs/adr/`, numbered, following
  `docs/adr/0001-first-public-release-is-1-0-0.md`. Read that file first and
  match its headings and tone.
- **No unapproved dependency or publishing changes** (`CLAUDE.md`): do not add
  a license, publish, or change what the package depends on without explicit
  approval. Comparing versions in a scratch directory is fine; changing
  `package.json` is not.

## Commands you will need

| Purpose               | Command                                                   | Expected on success |
| --------------------- | --------------------------------------------------------- | ------------------- |
| Install               | `npm ci`                                                  | exit 0              |
| Build                 | `npm run build`                                           | exit 0              |
| Tests                 | `npm test`                                                | all pass            |
| Lint                  | `npm run lint`                                            | exit 0              |
| Full gate             | `npm run check`                                           | exit 0              |
| Scratch dir           | `mktemp -d`                                               | prints a path       |
| Fetch a version there | `npm install --prefix "$SCRATCH" @toon-format/toon@2.1.0` | exit 0              |
| Changelog             | `npm view @toon-format/toon versions --json`              | prints a list       |

## Scope

**In scope**:

- A throwaway comparison performed in a temporary directory **outside** the
  repository working tree
- `docs/adr/0003-toon-encoder-version.md` — new, a draft decision record
- Optionally `test/` — one new test that pins encoded output, but only if
  Step 4's finding warrants it (see that step)

**Out of scope** — do NOT do any of these:

- `package.json` / `package-lock.json` — do not bump, do not add, do not remove
  anything. The decision is the maintainer's.
- `src/cli.ts` — no change. `render` is correct as written.
- `node_modules` in the repo — install comparison versions in a scratch
  directory with `--prefix`, never into the working tree.
- PR #13's files — do not touch the release preparation branch's work.

## Git workflow

- Branch: `advisor/004-toon-encoder-version`
- One commit. Suggested subject: `docs: record the TOON encoder version decision`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Collect representative output documents

Build the CLI and capture the actual TOON output for a spread of command
shapes, so the comparison runs over what this CLI really emits rather than
invented data.

```
npm ci
npm run build
```

The tests already stand up fake Forgejo servers that produce every document
shape. The cheapest way to get real payloads is to reuse them: write a
throwaway script under `$TMPDIR` that imports the built
`dist/src/forgejo.js` normalisers, or — simpler and preferred — extract the
JSON documents the existing tests assert on.

Aim for at least these shapes, since they exercise different TOON constructs:

- a **list with `page_info`** (e.g. `pr list` output: array of uniform objects
  plus a nested metadata object)
- a **single identity** (e.g. `pr view`: one flat object with nulls)
- a **nested composite** (e.g. `pr checks`: nested `statuses` array,
  `required` array, and `protection` object)
- a **review with inline comments** (`pr reviews`: array of objects each
  containing an array of objects — the deepest nesting the CLI emits)
- an **error document** (`{error, code, details, help}`)
- an **unsupported document** (`{supported: false, capability, next}`)

Save each as a `.json` file in a scratch directory:

```
SCRATCH="$(mktemp -d)"
```

**Verify**: `ls "$SCRATCH"/*.json | wc -l` → at least `6`.

### Step 2: Install both encoder versions side by side

```
npm install --prefix "$SCRATCH/v2" @toon-format/toon@2.1.0
npm install --prefix "$SCRATCH/v4" @toon-format/toon@4.1.0
```

**Verify**: both commands exit 0, and
`node -e "console.log(require('$SCRATCH/v2/node_modules/@toon-format/toon/package.json').version)"`
prints `2.1.0` (and the v4 equivalent prints `4.1.0`).

Note: if the package is ESM-only, use a dynamic `import()` from a `.mjs` file
instead of `require`. Check its `package.json` `exports` field first rather
than guessing.

### Step 3: Diff the encodings

Write a small script in `$SCRATCH` that loads each saved document, encodes it
with both versions, and reports whether the bytes differ. Print, per document:
the document name, whether the outputs are identical, and — when they differ —
a unified diff of the two encodings.

The comparison that matters is byte equality of `encode(document)`. Do not
compare parsed round-trips; a round-trip can be stable while the emitted bytes
change, and it is the bytes that consumers parse.

**Verify**: the script runs to completion and prints a verdict line per
document.

### Step 4: Record the finding

Two possible outcomes, and they lead to different work:

**Outcome A — every document encodes identically.** The two majors changed
things this CLI does not use. The bump is safe and mechanical. Record that.
In this case also add one guard test so the finding does not decay: a test that
asserts the exact encoded TOON string for one representative document, so a
future encoder bump that _does_ change output fails the suite instead of
shipping. Put it in `test/cli.test.ts` alongside the existing rendering
assertions, and keep it to a single small document — a large golden string is a
maintenance burden, not a guard.

**Outcome B — any document encodes differently.** Do NOT bump, do NOT "fix" the
difference. Capture in the ADR: which documents differ, what the difference is
(quote a short before/after), and which of the two majors introduced it (repeat
Step 3 against `3.x` to bisect if the answer is not obvious). Note explicitly
whether the change would break a consumer parsing the current format.

**Verify**: you can state, in one sentence, which outcome holds and on which
documents.

### Step 5: Write the draft ADR

Create `docs/adr/0003-toon-encoder-version.md`, matching the structure of
`docs/adr/0001-first-public-release-is-1-0-0.md`.

It must state:

- **Context**: TOON is the default output format, so the encoder version is
  part of the compatibility surface, not an implementation detail. The pin is
  exact at 2.1.0; current is 4.1.0.
- **Evidence**: the comparison from Step 3 — which document shapes were tested
  and the verdict for each. Include the short before/after quote if Outcome B.
- **Decision**: leave as `Proposed`. Recommend, with reasons, one of:
  - _Bump before 1.0.0_ (Outcome A): the encoding is unchanged for everything
    this CLI emits, so 1.0.0 should ship on a current encoder rather than
    inherit a two-major lag on day one.
  - _Hold the pin and document it_ (Outcome B): the encoding changed, so
    bumping is an output-contract change that belongs in a major release of
    _this_ package, not slipped in before its first one. Record the pin as
    deliberate so a future contributor does not "helpfully" update it.
- **Consequences**: either way, state that the exact pin is intentional and that
  a future bump requires re-running this comparison.

**Verify**: `npm run lint` → exit 0 (prettier checks markdown).

### Step 6: Clean up and run the gate

```
rm -rf "$SCRATCH"
```

**Verify**: `git status --porcelain` shows no changes to `package.json` or
`package-lock.json`, and `npm run check` → exit 0.

## Test plan

- **Conditional new test** (Outcome A only): one assertion in `test/cli.test.ts`
  pinning the exact encoded TOON string for a single small document. It exists
  so that a future encoder bump which changes output fails loudly. Follow the
  existing rendering assertions in that file for structure.
- **No test** under Outcome B — the finding is recorded in the ADR, and the
  exact pin in `package.json` is already the guard.
- **Verification**: `npm run check` → exit 0. If you added the golden test,
  confirm it fails when pointed at a deliberately altered string, so you know
  it is actually asserting something.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `git diff --stat 8ee9a1b..HEAD -- package.json package-lock.json` shows
      **no** changes
- [ ] `git diff --stat 8ee9a1b..HEAD -- src/` shows **no** changes
- [ ] `docs/adr/0003-toon-encoder-version.md` exists and contains the string
      `Proposed`
- [ ] The ADR names every document shape compared and gives a verdict for each
- [ ] The scratch directory is removed (`test -d "$SCRATCH"` returns non-zero)
- [ ] `git status --porcelain` lists only the new ADR, `plans/README.md`, and —
      under Outcome A only — `test/cli.test.ts`
- [ ] `plans/README.md` status row for 004 updated with the outcome

## STOP conditions

Stop and report back (do not improvise) if:

- `@toon-format/toon@4.1.0` cannot be installed or imported in the scratch
  directory (e.g. it requires a Node version above this project's `>=20`
  engine). That is itself the finding — report it rather than working around it.
- The encoder's API changed such that `encode(document)` is no longer the call
  shape. Report the new signature; do not adapt `src/cli.ts` to it.
- You conclude the right move is to bump `package.json`. It may well be — but
  that is the maintainer's call on a dependency that defines the output
  contract, and `CLAUDE.md` requires approval for dependency and publishing
  decisions. Write the recommendation into the ADR and stop.
- You find yourself editing anything under `src/`.

## Maintenance notes

- **Why the exact pin is right regardless of outcome**: with `"2.1.0"` rather
  than `"^2.1.0"`, `npm ci` cannot drift the output format underneath a
  consumer. Whatever version is chosen, keep the exact pin.
- **What a reviewer should scrutinise**: that the comparison covered the
  _deepest_ shape the CLI emits (reviews with inline comments), not just flat
  objects. Nesting is where serialisation formats most often differ across
  majors.
- **Related**: PR #13 sets 1.0.0 and adds `docs/adr/`. If that PR has already
  merged when this plan runs, the new ADR number may need to be higher than
  `0003` — check `ls docs/adr/` and take the next free number rather than
  assuming.
- **Not investigated here**: the other outdated dependencies at `8ee9a1b`
  (`typescript` 5.9.2 → 7.0.2, `vitest` 3.2.7 → 4.1.10, and several minor
  bumps). Those are dev-only and cannot change emitted output, so they carry
  none of the urgency that makes this one worth a plan.
