# Plan 003: establish whether minimatch matches required status contexts the way Forgejo does

> **Executor instructions**: This is an **investigation** plan, not a fix plan.
> Its deliverable is evidence and a decision record — you must NOT change how
> contexts are matched. Follow it step by step, run every verification command,
> and stop at the STOP conditions. When done, update the status row for this
> plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8ee9a1b..HEAD -- src/forgejo.ts test/forgejo.test.ts scripts/live.mjs`
> If any of those changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (unconfirmed — this plan exists to confirm or refute it)
- **Planned at**: commit `8ee9a1b`, 2026-08-01

## Why this matters

`pr checks` and `pr mergeability` are the commands an agent uses to decide
whether a pull request may be merged. Both hinge on matching the branch
protection rule's required _patterns_ against the _contexts_ that commit
statuses actually reported. `forgejo-axi` does that matching with `minimatch`.
Forgejo does it server-side with a different glob implementation.

The two agree on most patterns, including the one the test suite covers
(`ci/*` against `ci/unit`). They are expected to diverge on one specific
class: a `*` that must **cross a `/`**. In minimatch, `*` does not match a path
separator, so the pattern `ci*` does not match the context `ci/build`. Glob
libraries in the Go ecosystem commonly treat `*` as matching any character
including `/` unless a separator is configured. If Forgejo is in that second
group, then a required pattern like `ci*` or `*` — which Forgejo considers
satisfied — reads here as `state: 'missing'`, which forces `required_state:
'missing'`, which forces `passes: false`, which makes `pr mergeability` report
`mergeable: false`.

The failure direction is _closed_: `forgejo-axi` would refuse to merge
something Forgejo would allow. That is the safe direction, which is why this is
a correctness and usability problem rather than a security hole — but it is
still a false blocker that would stall an agent merge loop with no diagnosis
available from the output.

**This is unconfirmed.** The divergence in `forgejo-axi`'s own behaviour is
certain and can be pinned by a unit test today. What Forgejo actually does is
an inference from how the pattern is typically implemented, and this repository
has an explicit rule (`CLAUDE.md`, `docs/live-test-matrix.md`) that a live host
outranks any assumption or fixture. Changing a required-checks safety gate on
an inference would be exactly the wrong move: if the inference is wrong, the
change _loosens_ a merge gate for no reason. So this plan gathers the evidence
and stops.

## Current state

Files involved:

- `src/forgejo.ts` — `minimatch` imported at line 3, used at exactly one site,
  inside `evaluateChecks` (lines 1897–1918).
- `test/forgejo.test.ts` — a table-driven suite over required-context cases.
- `scripts/live.mjs` — the live harness, which already provisions real branch
  protection.

The single matching site, `src/forgejo.ts:1906-1918`:

```ts
const required: RequiredCheck[] = patterns.map((pattern) => {
  const matched = statuses.filter((status) =>
    minimatch(status.context, pattern, { nonegate: true, nocomment: true }),
  );
  return {
    context: pattern,
    state:
      matched.length === 0
        ? 'missing'
        : worstState(matched.map((status) => status.state)),
    matched: matched.map((status) => status.context),
  };
});
```

`patterns` comes from `branch.status_check_contexts ?? []`, gated on
`branch.enable_status_check === true` (lines 1902–1905). `minimatch` is
imported at `src/forgejo.ts:3` and appears nowhere else in `src/`:

```ts
import { minimatch } from 'minimatch';
```

The existing unit coverage is table-driven. Cases are objects of shape
`{ name, statuses, required, state, requiredState, passes }`, driven by
`it.each(cases)('$name', async ({ statuses, required, state, requiredState, passes }) => { ... })`.
The fake server answers `/branches/main` with:

```ts
return json(response, 200, {
  name: 'main',
  protected: required.length > 0,
  effective_branch_protection_name: required.length > 0 ? 'main' : '',
  enable_status_check: required.length > 0,
  status_check_contexts: required,
});
```

and the body asserts `checks.reported`, `checks.state`,
`checks.required_state`, and `checks.passes`.

Two existing cases matter for orientation. This one passes under **both** glob
semantics, because `*` never has to cross a `/`:

```ts
    {
      name: 'successful required glob',
      statuses: [
        { context: 'ci/unit', status: 'success' },
        { context: 'ci/lint', status: 'success' },
      ],
      required: ['ci/*'],
      state: 'success',
      requiredState: 'success',
      passes: true,
    },
```

and this one pins an option that is deliberately set:

```ts
    {
      name: 'treats leading bang as a literal, not minimatch negation',
      statuses: [{ context: 'other', status: 'success' }],
      required: ['!ci'],
      state: 'success',
      requiredState: 'missing',
      passes: false,
    },
```

There is **no** case where a `*` must cross a `/`. That is the untested gap.

The live harness already provisions real branch protection —
`scripts/live.mjs:864-937`. The relevant helpers:

- `ok(name, condition, detail)` — records an assertion; a false condition fails
  the lane.
- `raw(method, path, body)` — a direct authenticated API call, returning an
  object with a `status`.
- `seedStatus(sha, state, context)` (lines 163–168) — posts a commit status.
- `probeBranch(name, from)` (line 260) — creates a branch.
- `repoCli([...])` — invokes the built CLI against the live repo and parses
  its JSON.
- `created` — a cleanup ledger; `created.protection` and `created.pulls` are
  torn down at the end of the run.

The existing protection block provisions `status_check_contexts:
['live/required']` on a branch, opens a pull against it, and asserts through
`const protChecks = () => repoCli(['pr', 'checks', String(protNumber)]).checks;`.

### Repo conventions to match

- **Evidence hierarchy** (`CLAUDE.md`, `docs/live-test-matrix.md`): the live
  lanes are the primary evidence of correctness. Fixtures only prove the code
  agrees with itself. When a live host and a fixture disagree, the fixture is
  wrong.
- **Live safety**: the harness has three pre-write guards — it targets
  `FORGEJO_LIVE_REPO` (never `FORGEJO_REPOSITORY`), refuses unless the host
  reports `FORGEJO_EXPECT_VERSION`, and refuses unless the host names the armed
  repository back. Never weaken these. Never point a live lane at any host
  other than the env-configured local ones.
- **ADRs** live in `docs/adr/`, numbered, following the existing
  `docs/adr/0001-first-public-release-is-1-0-0.md`.

## Commands you will need

| Purpose              | Command                               | Expected on success      |
| -------------------- | ------------------------------------- | ------------------------ |
| Install              | `npm ci`                              | exit 0                   |
| Typecheck            | `npm run typecheck`                   | exit 0                   |
| Tests                | `npm test`                            | all pass                 |
| One file             | `npx vitest run test/forgejo.test.ts` | all pass                 |
| Lint                 | `npm run lint`                        | exit 0                   |
| Full gate            | `npm run check`                       | exit 0                   |
| Live lane (operator) | `npm run test:live -- 15`             | all `ok` assertions pass |
| Live lane (operator) | `npm run test:live -- 16`             | all `ok` assertions pass |

You will almost certainly **not** be able to run the live lanes yourself — they
need credentials and two local Forgejo hosts from the operator's mise/sops
environment. That is expected. Write the probe; the operator runs it.

## Scope

**In scope**:

- `test/forgejo.test.ts` — add cases that pin today's behaviour
- `scripts/live.mjs` — add a probe that reports what Forgejo actually does
- `docs/adr/0002-required-status-context-glob-semantics.md` — new, a draft
  decision record with the outcome left open

**Out of scope** — these are what a follow-up plan would change _after_ the
evidence lands, and changing them now is the failure mode this plan exists to
prevent:

- `src/forgejo.ts` — do NOT change `evaluateChecks`, do NOT replace or
  reconfigure `minimatch`, do NOT hand-roll a glob matcher.
- `package.json` — do NOT remove the `minimatch` dependency.
- `docs/contract.md` — the contract does not currently specify a glob dialect;
  deciding what it should say is part of the deferred decision.
- The existing live protection block's assertions — add alongside it, do not
  alter what it already proves.

## Git workflow

- Branch: `advisor/003-glob-semantics-investigation`
- One commit. Suggested subject:
  `test: pin required-context glob behaviour and probe it live`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin today's behaviour with unit cases

In `test/forgejo.test.ts`, add two cases to the `cases` array, after the
existing `'successful required glob'` case. These document what `forgejo-axi`
does **today** — they are expected to pass immediately, and their job is to
make any future change to the matcher deliberate and visible.

```ts
    {
      // minimatch's `*` does not cross a `/`, so a pattern anchored above the
      // separator does not match a context below it. Whether Forgejo agrees is
      // the open question in plans/003; this case pins today's answer so a
      // change to it cannot pass unnoticed.
      name: 'a star does not cross a slash in a required pattern',
      statuses: [{ context: 'ci/unit', status: 'success' }],
      required: ['ci*'],
      state: 'success',
      requiredState: 'missing',
      passes: false,
    },
    {
      name: 'a bare star does not match a slashed context',
      statuses: [{ context: 'ci/unit', status: 'success' }],
      required: ['*'],
      state: 'success',
      requiredState: 'missing',
      passes: false,
    },
```

**Verify**: `npx vitest run test/forgejo.test.ts` → all pass, including both new
cases. If either FAILS, that is a significant finding — it would mean minimatch
is already crossing separators here and the premise of this plan is wrong.
Treat it as a STOP condition and report the actual result.

### Step 2: Add a live probe of Forgejo's own matching

In `scripts/live.mjs`, extend the required-contexts section (around lines
864–937). After the existing assertions on `live/required` complete, add a
second protected branch whose required pattern must cross a `/`, and record
what `pr checks` reports.

Model the setup exactly on the existing block: `probeBranch`, then
`raw('POST', \`repos/${REPO}/branch_protections\`, {...})`, then a head branch,
then `repoCli(['pr', 'create', ...])`, registering `created.protection` and
`created.pulls` so teardown removes them. Use a distinct branch name suffix
(e.g. `${BRANCH}-crossing`) so it cannot collide with the existing block.

The protection rule to provision:

```js
    status_check_contexts: ['live*'],
```

Then seed a green status on a context that only matches if `*` crosses the
separator, and read the result:

```js
await seedStatus(crossSha, 'success', 'live/crossing');
const crossing = repoCli(['pr', 'checks', String(crossNumber)]).checks;
```

Now the important part: **assert the two systems agree, using Forgejo itself as
the oracle.** Do not assert a hard-coded expectation about which way it goes —
the whole point is that we do not know. Instead, compare `forgejo-axi`'s verdict
against whether Forgejo will actually permit the merge, since branch protection
is enforced server-side at merge time.

```js
const merge = repoCli(
  ['pr', 'merge', String(crossNumber), '--expected-head', crossSha],
  { allowFail: true },
);
const forgejoAllowedIt = merge.merged === true;
ok(
  'required-context matching agrees with the host on a slash-crossing pattern',
  crossing.passes === forgejoAllowedIt,
  `axi_passes=${crossing.passes} forgejo_merged=${forgejoAllowedIt} ` +
    `required=${JSON.stringify(crossing.required)}`,
);
```

`cli` already supports `{ allowFail: true }` (see `scripts/live.mjs:89`); check
its exact return shape for a failed invocation and adapt the `merged` read
accordingly — a refused merge must not throw out of the lane.

Register the merged/unmerged pull for teardown the same way the surrounding
code does.

**Verify**: `node --check scripts/live.mjs` → exit 0 (syntax only; you cannot
run the lane). Then `npm run lint` → exit 0.

### Step 3: Draft the decision record with the outcome left open

Create `docs/adr/0002-required-status-context-glob-semantics.md`, following the
structure of `docs/adr/0001-first-public-release-is-1-0-0.md` (read it first
and match its headings and tone).

The ADR must state:

- **Context**: `forgejo-axi` matches required status-check patterns with
  `minimatch`; Forgejo matches them server-side with its own implementation.
  They agree on separator-respecting patterns like `ci/*`. Whether they agree
  when a `*` must cross a `/` is the open question.
- **Evidence**: name the unit cases from Step 1 as pinning `forgejo-axi`'s
  behaviour, and the live probe from Step 2 as the test that answers what
  Forgejo does. State plainly that the live probe has **not been run yet** at
  the time of writing.
- **Decision**: leave as `Proposed`, not `Accepted`. Write both branches
  explicitly:
  - If the live probe passes, the two agree and no code change is warranted;
    the ADR records that the semantics were verified rather than assumed, and
    `docs/contract.md` should gain a sentence naming the supported glob dialect.
  - If the live probe fails, `forgejo-axi` is stricter than the host and reports
    a false `missing`; the fix is to match the host's semantics, and because
    `minimatch` has no option to make `*` cross `/`, that means replacing the
    single call site — which would also remove the project's only use of the
    `minimatch` dependency.
- **Consequences**: note that the failure direction is fail-closed (refusing a
  merge Forgejo would allow), so this is a false blocker rather than an unsafe
  merge, and that a fix loosens a gate and therefore must not land on inference
  alone.

**Verify**: `npm run lint` → exit 0 (prettier checks markdown).

### Step 4: Run the full gate

**Verify**: `npm run check` → exit 0.

### Step 5: Hand the live probe to the operator

Report back with:

- the exact command the operator must run: `npm run test:live -- 15` and
  `npm run test:live -- 16`
- the name of the new assertion to watch:
  `required-context matching agrees with the host on a slash-crossing pattern`
- what each outcome means, per the two branches written into the ADR

Do not attempt to run the live lanes yourself, and do not guess the result.

## Test plan

- **New unit cases**: two entries in the `cases` table of
  `test/forgejo.test.ts`, pinning that a `*` does not cross a `/` today. They
  pass against current code by construction; their value is that any future
  matcher change must update them deliberately.
- **New live assertion**: one `ok(...)` in `scripts/live.mjs` comparing
  `forgejo-axi`'s `passes` verdict against whether the host actually permitted
  the merge. This is the assertion that answers the open question. It is
  expected to be run by the operator, on both lanes.
- **Structural pattern to follow**: the existing required-contexts block in
  `scripts/live.mjs:864-937`, including its use of `created` for teardown.
- **Verification**: `npm run check` → exit 0; `node --check scripts/live.mjs`
  → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `node --check scripts/live.mjs` exits 0
- [ ] `npx vitest run test/forgejo.test.ts` passes, with two more cases than at
      `8ee9a1b`
- [ ] `git diff --stat 8ee9a1b..HEAD -- src/forgejo.ts` shows **no** changes
- [ ] `git diff --stat 8ee9a1b..HEAD -- package.json` shows **no** changes
- [ ] `docs/adr/0002-required-status-context-glob-semantics.md` exists and
      contains the string `Proposed`
- [ ] `grep -c "slash-crossing" scripts/live.mjs` returns at least `1`
- [ ] `git status --porcelain` lists only `test/forgejo.test.ts`,
      `scripts/live.mjs`, `docs/adr/0002-required-status-context-glob-semantics.md`,
      and `plans/README.md`
- [ ] `plans/README.md` status row for 003 updated, noting it is blocked on a
      live run

## STOP conditions

Stop and report back (do not improvise) if:

- Either new unit case in Step 1 **fails**. That refutes this plan's premise —
  report the actual `required_state` observed.
- You are tempted to change `evaluateChecks`, swap out `minimatch`, or hand-roll
  a glob. That is explicitly out of scope. The decision needs live evidence
  first; making the change now is the exact failure this plan is structured to
  avoid.
- The live harness's structure has changed such that adding a second protected
  branch would interfere with the existing block's assertions or its teardown.
- `cli(..., { allowFail: true })` does not give you a way to observe a refused
  merge without throwing. Report what it does instead of forcing it.
- You have live credentials available and are considering running the lane
  yourself. Confirm with the operator first — the live lanes mutate a real
  repository, and `CLAUDE.md` restricts them to approved hosts.

## Maintenance notes

- **Why this is not a fix plan**: the fix loosens a merge gate. If the inference
  about Forgejo's matcher is wrong, applying it would make `forgejo-axi` accept
  required contexts the host does not consider satisfied. Fail-closed today is
  strictly safer than fail-open on a guess.
- **If the follow-up fix does happen**: `minimatch` has no option to make `*`
  cross `/`, so it would be replaced at the single call site rather than
  reconfigured — and since `src/forgejo.ts:3` is its only import in `src/`, the
  dependency would come out of `package.json` with it. Note that hand-rolling a
  glob on a required-checks path deserves its own careful test table, including
  `?`, character classes, and brace expansion, since minimatch supports all
  three today.
- **Related uncovered ground**: `docs/live-test-matrix.md` already tracks what
  the lanes do not reach. If this probe lands, that document should gain a line
  saying slash-crossing required patterns are now covered.
