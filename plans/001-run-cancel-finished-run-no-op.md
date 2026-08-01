# Plan 001: `run cancel` on an already-finished run never contacts the cancel endpoint

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8ee9a1b..HEAD -- src/forgejo.ts test/run.test.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8ee9a1b`, 2026-08-01

## Why this matters

`forgejo-axi run cancel` promises that cancelling an already-finished run is a
successful no-op: exit `0`, `cancelled: false`, run returned unchanged. That
promise is written into `docs/contract.md` and into the command's own `--help`
text. The implementation does not honour it structurally — it sends the
`POST .../cancel` request unconditionally and only _reports_ `cancelled: false`
afterwards. The no-op therefore depends on Forgejo tolerating a redundant
cancel of a finished run.

Nothing proves Forgejo does tolerate it. The only coverage is a fake server
that returns `204` no matter what the run's status is, and
`docs/live-test-matrix.md` explicitly lists Actions cancel among the behaviours
**not** yet covered against a live host. If a real Forgejo answers a redundant
cancel with `4xx`, `run cancel` exits `1` with an API error instead of the
contracted exit-`0` no-op — which breaks exactly the defensive
"cancel it if it is still running" retry an agent would write.

Returning early when the run is already finished makes the contract true
regardless of what the host does, and removes two HTTP requests from that path.

## Current state

Files involved:

- `src/forgejo.ts` — `ForgejoService.cancelRun` is the whole implementation
  (lines 1128–1143). `DONE_RUN_STATUSES` is defined at lines 320–325.
- `test/run.test.ts` — the run-family suite, including the fake Actions server
  and the existing cancel test.
- `docs/contract.md` — the compatibility authority; line 151 states the promise.

`src/forgejo.ts:1128-1143` today:

```ts
  async cancelRun(
    repo: RepositoryRef,
    runId: number,
  ): Promise<Record<string, unknown>> {
    const before = await this.getRunRaw(repo, runId);
    const wasDone = DONE_RUN_STATUSES.has(before.status ?? '');
    await this.http.api({
      method: 'POST',
      path: `${repoPath(repo)}/actions/runs/${runId}/cancel`,
    });
    const after = await this.getRunRaw(repo, runId);
    return {
      cancelled: !wasDone,
      run: normalizeRun(this.config, repo, after),
    };
  }
```

`src/forgejo.ts:319-325` — the status set this plan reuses unchanged:

```ts
/** Run states Forgejo will no longer act on; used only to report whether a cancel changed anything. */
const DONE_RUN_STATUSES = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
]);
```

The fake server that makes the current test pass, `test/run.test.ts:78-89` —
note it answers `204` regardless of run status, which is why the existing test
cannot detect this problem:

```ts
if (path === `/actions/runs/${id}/cancel` && recorded.method === 'POST') {
  if (!DONE_STATUSES.has(String(state.run['status']))) {
    state.run = {
      ...state.run,
      status: 'cancelled',
      stopped: '2026-01-03T00:06:00Z',
    };
  }
  response.statusCode = 204;
  response.end();
  return;
}
```

The existing test, `test/run.test.ts:413-430`:

```ts
it('cancels a running run and reports the repeat as a no-op', async () => {
  const world = await load<RunWorld>(16);
  const server = await runServer({
    ...world,
    run: { ...world.run, status: 'running', stopped: '0001-01-01T00:00:00Z' },
  });
  const args = ['run', 'cancel', ...connection(server), '9'];

  expect(parseJson((await invoke(args)).output)).toMatchObject({
    cancelled: true,
    run: { id: 9, status: 'cancelled' },
  });
  expect(parseJson((await invoke(args)).output)).toMatchObject({
    cancelled: false,
    run: { id: 9, status: 'cancelled' },
  });
});
```

What `docs/contract.md:151` promises (do not change this line — the code is
what must be made to match it):

> `run cancel` reports `cancelled=true` only when the run was still actionable
> beforehand; cancelling an already finished run is exit `0`, `cancelled=false`,
> and returns the run unchanged.

### Repo conventions to match

- **Comment style**: short, declarative, explaining _why_ a decision holds, not
  what the line does. See the existing comment above `DONE_RUN_STATUSES` quoted
  above, and `src/forgejo.ts:1657-1660`.
- **Test style**: `vitest`, one `it(...)` per behaviour with a sentence-shaped
  name. Assertions on CLI output go through the `invoke` / `parseJson` helpers
  from `test/server.ts`. Requests made are inspected via `server.requests`,
  which is an array of `{ url, method }` records — see the existing example at
  `test/run.test.ts:215`:
  ```ts
  expect(touched.some((url) => url.includes('/cancel'))).toBe(false);
  ```
- **Vocabulary** (from `CONTEXT.md`): a **Run** is one execution of an Actions
  workflow. Use "run", not "task" or "workflow".

## Commands you will need

| Purpose   | Command                           | Expected on success |
| --------- | --------------------------------- | ------------------- |
| Install   | `npm ci`                          | exit 0              |
| Typecheck | `npm run typecheck`               | exit 0, no errors   |
| Tests     | `npm test`                        | all pass            |
| One file  | `npx vitest run test/run.test.ts` | all pass            |
| Lint      | `npm run lint`                    | exit 0              |
| Full gate | `npm run check`                   | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/forgejo.ts` — `cancelRun` only
- `test/run.test.ts` — add one test, extend the existing cancel test

**Out of scope** (do NOT touch, even though they look related):

- `docs/contract.md` — the contract is already correct; this plan makes the
  code match it. Changing the contract would defeat the purpose.
- `src/help.ts` and `skills/forgejo-axi/SKILL.md` — the help text
  ("Cancelling an already-finished run is a no-op; cancelled is false") is
  already accurate. `SKILL.md` is generated; never hand-edit it.
- `DONE_RUN_STATUSES` itself — the status set is correct; reuse it as-is.
- Any other method on `ForgejoService`, and `scripts/live.mjs`.

## Git workflow

- Branch: `advisor/001-run-cancel-no-op`
- One commit for the change plus its tests. Conventional-commit style, matching
  `git log` (e.g. `fix: skip the cancel request for an already-finished run`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Return early from `cancelRun` when the run is already finished

Replace the body of `cancelRun` in `src/forgejo.ts` (lines 1128–1143) so that a
run whose status is in `DONE_RUN_STATUSES` returns immediately, with no
`POST` and no second `GET`. Target shape:

```ts
  async cancelRun(
    repo: RepositoryRef,
    runId: number,
  ): Promise<Record<string, unknown>> {
    const before = await this.getRunRaw(repo, runId);
    // A finished run is reported unchanged without asking Forgejo to cancel it.
    // Sending the request anyway would make the contracted no-op depend on the
    // host tolerating a redundant cancel.
    if (DONE_RUN_STATUSES.has(before.status ?? '')) {
      return { cancelled: false, run: normalizeRun(this.config, repo, before) };
    }
    await this.http.api({
      method: 'POST',
      path: `${repoPath(repo)}/actions/runs/${runId}/cancel`,
    });
    const after = await this.getRunRaw(repo, runId);
    return {
      cancelled: true,
      run: normalizeRun(this.config, repo, after),
    };
  }
```

Note the `wasDone` local disappears: the early return makes the remaining path
unconditionally `cancelled: true`.

**Verify**: `npm run typecheck` → exit 0, no errors.

### Step 2: Extend the existing cancel test to assert no second cancel request

In `test/run.test.ts`, in the test named
`'cancels a running run and reports the repeat as a no-op'` (around line 413),
add an assertion after the second `invoke` that only **one** cancel request was
ever sent. Use the `server.requests` array the suite already relies on:

```ts
expect(
  server.requests.filter((request) => request.url.includes('/cancel')).length,
).toBe(1);
```

**Verify**: `npx vitest run test/run.test.ts` → all pass, including this test.
If it reports `2`, Step 1 was not applied correctly — re-read the excerpt.

### Step 3: Add a test proving a rejecting host still yields the contracted no-op

Add a new `it(...)` to the same `describe` block in `test/run.test.ts`,
immediately after the test you edited in Step 2. It must stand up a fake server
whose cancel route **rejects** with `409` and a JSON error body, seed the run as
already finished (`status: 'success'`), and assert the command still exits `0`
with `cancelled: false`.

Model it structurally on the test from Step 2. The run world comes from
`await load<RunWorld>(16)`; override `run.status` the same way that test
overrides it. To make the cancel route reject you will need a server whose
cancel branch returns an error instead of `204` — build it with `startServer`
directly (imported at the top of `test/run.test.ts`) rather than `runServer`,
or extend `runServer` with an option; choose whichever fits the existing helper
shape with the smaller diff, and keep every other route behaving as `runServer`
does.

The assertions:

```ts
expect(result.exitCode).toBeUndefined();
expect(parseJson(result.output)).toMatchObject({
  cancelled: false,
  run: { id: 9, status: 'success' },
});
```

`exitCode` being `undefined` is how this suite spells exit `0` — see
`test/run.test.ts:193`.

**Verify**: `npx vitest run test/run.test.ts` → all pass, with two more tests
than before this plan started.

### Step 4: Run the full gate

**Verify**: `npm run check` → exit 0. This runs lint, prettier, typecheck, the
whole vitest suite, and the smoke test.

## Test plan

- **Modified**: `test/run.test.ts`, `'cancels a running run and reports the repeat as a no-op'`
  — now also asserts exactly one `/cancel` request across both invocations.
  This is the test that fails if the early return is removed.
- **New**: `test/run.test.ts`, a test asserting that a host which rejects the
  cancel of a finished run still produces exit `0` and `cancelled: false`.
  This is the regression the plan exists to prevent; it fails against the code
  as it stands today.
- **Structural pattern to follow**: the existing cancel test at
  `test/run.test.ts:413-430` and the unsupported-capability test at
  `test/run.test.ts:187-215` (for the `server.requests` assertion style).
- **Verification**: `npm test` → all pass, including the two changed/new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm test` exits 0, with two more passing tests than at `8ee9a1b`
- [ ] `npm run check` exits 0
- [ ] `grep -n "wasDone" src/forgejo.ts` returns no matches
- [ ] `git status --porcelain` lists only `src/forgejo.ts`, `test/run.test.ts`,
      and `plans/README.md`
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `cancelRun` body in `src/forgejo.ts` does not match the "Current state"
  excerpt — the code has drifted since this plan was written.
- Making the cancel route reject in Step 3 requires changing how `runServer`
  behaves for tests other than the new one. Report what the conflict is rather
  than modifying shared fixtures for every test.
- `npm test` fails in a file other than `test/run.test.ts` after your change.
  Nothing here should affect another suite; if something does, the change is
  wider than the plan assumed.
- You conclude the contract line in `docs/contract.md:151` should change
  instead. It should not — but if you believe otherwise, stop and say why.

## Maintenance notes

- **What this interacts with**: `DONE_RUN_STATUSES` is now load-bearing for
  request behaviour, not just for reporting. If Forgejo adds a terminal run
  status, adding it to that set changes whether a cancel request is sent, not
  merely what `cancelled` reports.
- **What a reviewer should scrutinise**: that the non-finished path still
  reports `cancelled: true` and still re-reads the run afterwards, so the
  returned run reflects the cancellation rather than the pre-cancel state.
- **Deferred out of this plan**: proving the real Forgejo behaviour against a
  live host. `docs/live-test-matrix.md` lists Actions cancel as uncovered
  because it needs a runner and a real workflow run. This plan removes the
  dependency on that behaviour rather than establishing what it is, so the
  live gap stays open — see the direction note in `plans/README.md`.
