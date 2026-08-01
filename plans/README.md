# Improvement plans

Self-contained implementation plans produced by a read-only advisory audit of
this repository at commit `8ee9a1b` (2026-08-01). Each plan is written for an
executor with **no prior context** on this codebase: it inlines the code it
touches, names the exact commands to run, and ends every step in a verifiable
check.

No source code was changed to produce these. Each plan stands alone — read the
one you intend to execute, not this index.

## Execution order

Ordered by leverage (impact ÷ effort, discounted by confidence and by the risk
of the fix itself). There are no dependencies between them; they can be
executed in any order or in parallel.

| #                                             | Plan                                        | Priority | Effort | Risk | Category          | Status |
| --------------------------------------------- | ------------------------------------------- | -------- | ------ | ---- | ----------------- | ------ |
| [001](001-run-cancel-finished-run-no-op.md)   | `run cancel` no-op never contacts the host  | P1       | S      | LOW  | bug               | TODO   |
| [002](002-diff-hunk-truncation-signal.md)     | Report `diff_hunk` truncation               | P2       | S      | LOW  | bug               | TODO   |
| [003](003-required-context-glob-semantics.md) | Investigate required-context glob semantics | P2       | M      | MED  | bug (unconfirmed) | TODO   |
| [004](004-toon-encoder-major-version.md)      | Decide the TOON encoder major version       | P2       | M      | MED  | dependency        | TODO   |

Statuses: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED`, `REJECTED`.

### Notes on ordering

- **001 first.** Smallest diff, highest confidence, and it closes a gap between
  a documented promise and the code that is supposed to keep it. It also
  removes a dependency on untested live behaviour rather than adding one.
- **002 next.** Equally small, purely additive, no behavioural risk.
- **003 and 004 are investigations, not fixes.** Both deliberately stop short
  of changing anything, because both would otherwise change a
  compatibility-relevant behaviour on inference rather than evidence. Their
  deliverable is a measurement plus a draft ADR; the decision stays with the
  maintainer. Do not let an executor "finish the job" on either.
- **003 is blocked on a live run** once its code lands — the probe must be run
  by the operator against both Forgejo lanes.
- **004 is most valuable before PR #13 merges**, since that PR sets 1.0.0 and
  freezes the output contract the TOON encoder produces.

## Findings considered and rejected

Recorded so they are not re-raised. Each was examined and deliberately left
alone.

- **Serial fetch of review comments** (`src/forgejo.ts:709-712`). Reviews with
  comments are fetched one at a time. This is a documented deliberate
  tradeoff — the code comment states that parallelising would need a
  concurrency cap "which no observed pull request has needed." By design, not a
  defect.
- **Artifact zip buffered in memory** (`src/forgejo.ts:1172`). Carries a
  `ponytail:` debt marker that names both the ceiling and the upgrade path
  ("stream the transport if artifacts outgrow RAM"). A known, recorded,
  bounded shortcut — tracked debt, not an oversight.
- **`argv.includes('--json')` in `main()`** (`src/cli.ts:53`). The whole-argv
  scan that selects the output renderer can false-positive if a _positional_
  value is literally the string `--json`. It cannot false-negative, because
  `--json` is a boolean flag that never appears in `--flag=value` form. The
  only way to trigger it is to name a label (or similar) `--json`. Not worth
  code.
- **`npm audit` runs three times in CI.** `.github/workflows/ci.yml` runs an
  identical `npm audit --audit-level=high` on each of Node 20, 22, and 24. The
  audit does not depend on the Node version, so two of the three runs are
  redundant. Saves seconds; not worth the churn.
- **No coverage measurement.** There is no `@vitest/coverage-v8` and no
  coverage gate. This is consistent with the project's stated evidence
  hierarchy (`docs/live-test-matrix.md`), which puts live-host verification
  above self-referential metrics. Adding a coverage number would not change
  what the project trusts.
- **Licensing, versioning, and release scaffolding.** PR #13 ("Prepare the
  first public npm release") already adds `LICENSE`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, a release workflow,
  and `docs/adr/0001`. Planning any of it would duplicate work in flight.
- **Reviews are read-only.** Submitting, dismissing, and deleting reviews are
  reachable only through `api`. This is an explicit decision recorded in
  `docs/contract.md:121`, not an omission. It appears below as a _direction_
  option instead — revisiting a decision is different from fixing a bug.
- **Stale comment about status sort order** (`src/forgejo.ts:1885`). The
  comment reads "when no explicit sort is supplied" while the caller
  (`checksForPull`) always supplies `{sort: 'recentupdate'}`. The behaviour is
  correct either way — `recentupdate` ordering is consistent with the
  index-based tiebreak the comment describes. Cosmetic drift, no user impact.

## Direction findings

Not defects. Options for where the project goes next, recorded separately
because they are judgment calls for the maintainer rather than work items.

1. **A review write path.** Reviews are currently read-only by explicit
   decision. The counter-signal is that this CLI exists for agent pull-request
   lifecycles, already models review verdicts and inline comment anchors, and
   an agent that can _read_ a review but not _answer_ one has to drop to raw
   `api` with hand-built JSON — precisely the friction the rest of the surface
   removes. Worth revisiting as a decided constraint, with the note that review
   submission is the one write that is hard to make idempotent, which may be
   why it was excluded.

2. **`--fields` surface asymmetry.** `pr list`, `issue list`, and `run list`
   accept `--fields LIST|all`; `label list` and `pr reviews` do not. The
   selection machinery (`chooseFields` / `selectFields`, `src/cli.ts:1116-1143`)
   is already generic, so this is a small, cheap consistency win rather than
   new capability. Low urgency — it only matters to a consumer trying to
   minimise payload uniformly across commands.

3. **Live Actions coverage with a real runner.** `docs/live-test-matrix.md:49`
   names job logs, run cancel, and artifact download as behaviours no live lane
   reaches, because they need a registered runner and a real workflow run.
   Plan 001 exists precisely because that gap concealed a bug. Standing up a
   runner in the live environment would close the largest remaining hole in the
   project's primary evidence source.
