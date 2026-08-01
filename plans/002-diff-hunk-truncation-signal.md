# Plan 002: report whether a review comment's `diff_hunk` was truncated

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8ee9a1b..HEAD -- src/forgejo.ts test/review.test.ts docs/contract.md`
> If any of those changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8ee9a1b`, 2026-08-01

## Why this matters

`forgejo-axi` is a machine-facing CLI: its output is consumed by agents, not
read by people. Every other free-text field it emits is _measured_ — a body
comes back as `body`, `body_length`, and `body_truncated`, so a consumer can
always tell whether it is holding the whole thing or a 500-character preview.

The `diff_hunk` on an inline review comment is the one exception. It goes
through the same `previewBody` truncation as a body, but only the truncated
string is kept; the length and the truncation flag are discarded. A consumer
reading `pr reviews` therefore cannot distinguish a hunk that is genuinely 500
characters long from one that was cut at 500 — it reads a silently-truncated
hunk as complete. An agent deciding whether it has enough context to answer a
review comment gets no signal that the excerpt it is reasoning about is
partial.

`docs/contract.md` promises the ceiling exists but promises no flag, so this is
a gap in the contract as much as in the code. Both are additive to fix, and the
contract explicitly permits adding fields.

## Current state

Files involved:

- `src/forgejo.ts` — `BodyPreview` (lines 219–224), `ReviewCommentIdentity`
  (lines 234–248), `normalizeReviewComment` (lines 1646–1679), `previewBody`
  (lines 1749–1761).
- `test/review.test.ts` — the review suite, including a local `ReviewComment`
  interface and the existing truncation assertions.
- `docs/contract.md` — line 119 describes the review-comment identity.

The shared preview shape, `src/forgejo.ts:219-224`:

```ts
/** A body rendered as a preview or in full, with the measurement that says which. */
interface BodyPreview {
  body: string;
  body_length: number;
  body_truncated: boolean;
}
```

The truncation function, `src/forgejo.ts:1749-1761` — note it already returns
everything needed; the caller throws two thirds of it away:

```ts
function previewBody(raw: string | undefined, full: boolean): BodyPreview {
  const body = raw ?? '';
  const characters = [...body];
  const previewLimit = 500;
  const truncated = !full && characters.length > previewLimit;
  return {
    body: truncated
      ? `${characters.slice(0, previewLimit - 3).join('')}...`
      : body,
    body_length: characters.length,
    body_truncated: truncated,
  };
}
```

The identity type, `src/forgejo.ts:234-248`:

```ts
/** One inline review comment, anchored to the file and diff position it marks. */
export interface ReviewCommentIdentity extends BodyPreview {
  id: number;
  api_url: string;
  path: string | null;
  position: number | null;
  original_position: number | null;
  commit_id: string | null;
  original_commit_id: string | null;
  diff_hunk: string;
  user: string | null;
  resolved_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}
```

The discarding call site, `src/forgejo.ts:1669-1678`:

```ts
    // The hunk is free text like a body, so it observes the same ceiling.
    // Uncapped, a review carrying many large hunks would let the capped view
    // emit an unbounded payload while page_info still reported no truncation.
    diff_hunk: previewBody(comment.diff_hunk, context.full).body,
    user: comment.user?.login ?? null,
    resolved_by: comment.resolver?.login ?? null,
    created_at: timestampOrNull(comment.created_at),
    updated_at: timestampOrNull(comment.updated_at),
    ...previewBody(comment.body, context.full),
  };
}
```

The `...previewBody(comment.body, ...)` spread is last and supplies `body`,
`body_length`, `body_truncated`. Your new keys must not collide with those.

What `docs/contract.md:119` currently says about the hunk (the sentence you
will extend):

> `diff_hunk` is the excerpt Forgejo anchors the comment to; it observes the
> same preview ceiling as a body, so the capped view cannot emit an unbounded
> hunk and `--full` returns it whole.

Existing coverage in `test/review.test.ts` — a test seeds an over-long hunk at
line 307 (`diff_hunk: hunk,`) and asserts:

```ts
expect(capped.reviews[0]?.comments[0]?.diff_hunk).toHaveLength(500);
```

```ts
expect(full.reviews[0]?.comments[0]?.diff_hunk).toBe(hunk);
```

That suite also declares a local mirror interface (`test/review.test.ts:20-32`)
that must gain the new fields or the assertions will not typecheck:

```ts
interface ReviewComment {
  id: number;
  api_url: string;
  path: string | null;
  position: number | null;
  original_position: number | null;
  commit_id: string | null;
  original_commit_id: string | null;
  diff_hunk: string;
  user: string | null;
  resolved_by: string | null;
  body: string;
  body_truncated: boolean;
}
```

### Repo conventions to match

- **Field naming**: snake_case in output payloads, mirroring the `body_length`
  / `body_truncated` pair. The new fields are therefore `diff_hunk_length` and
  `diff_hunk_truncated`.
- **Contract discipline**: `docs/contract.md` is the compatibility authority
  (see `CLAUDE.md`). Adding output fields is additive and allowed; the contract
  must be updated in the same commit as the code.
- **Comment style**: short, explaining why, not what.

## Commands you will need

| Purpose   | Command                              | Expected on success |
| --------- | ------------------------------------ | ------------------- |
| Install   | `npm ci`                             | exit 0              |
| Typecheck | `npm run typecheck`                  | exit 0, no errors   |
| Tests     | `npm test`                           | all pass            |
| One file  | `npx vitest run test/review.test.ts` | all pass            |
| Lint      | `npm run lint`                       | exit 0              |
| Full gate | `npm run check`                      | exit 0              |

## Scope

**In scope**:

- `src/forgejo.ts` — `ReviewCommentIdentity` and `normalizeReviewComment` only
- `test/review.test.ts` — local interface plus truncation assertions
- `docs/contract.md` — line 119 only, the review-comment identity sentence

**Out of scope** (do NOT touch):

- `previewBody` — it already returns exactly what is needed; do not change it.
- `BodyPreview` — do not add hunk fields to the shared interface. Only review
  comments have a hunk; putting them on `BodyPreview` would leak the fields
  onto `CommentIdentity`, which has no hunk.
- The `...previewBody(comment.body, context.full)` spread and every `body*`
  field — unchanged.
- `src/help.ts` and `skills/forgejo-axi/SKILL.md` — help text does not
  enumerate output fields. `SKILL.md` is generated; never hand-edit it.
- `normalizeComment` (issue comments) — issue comments have no hunk.

## Git workflow

- Branch: `advisor/002-diff-hunk-truncation`
- One commit covering code, tests, and contract together — the contract must
  never describe a shape the code does not emit.
  Suggested subject: `feat: report diff_hunk length and truncation`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the two fields to `ReviewCommentIdentity`

In `src/forgejo.ts`, extend the interface (lines 234–248) so the hunk carries
its own measurement, placed directly after `diff_hunk` to keep the anchor
fields together:

```ts
diff_hunk: string;
diff_hunk_length: number;
diff_hunk_truncated: boolean;
```

**Verify**: `npm run typecheck` → it should now FAIL, reporting that
`normalizeReviewComment`'s return value is missing the two new properties. That
failure is the point: it proves the type change reaches the one call site.

### Step 2: Populate them in `normalizeReviewComment`

In `src/forgejo.ts`, hoist the hunk preview into a local so all three pieces
are available, then emit them. Replace the `diff_hunk:` line (1672) and add the
local above the `return`:

```ts
const hunk = previewBody(comment.diff_hunk, context.full);
```

and in the returned object:

```ts
    // The hunk is free text like a body, so it observes the same ceiling — and
    // reports the same measurement, so a consumer can tell a capped hunk from a
    // whole one.
    diff_hunk: hunk.body,
    diff_hunk_length: hunk.body_length,
    diff_hunk_truncated: hunk.body_truncated,
```

Keep the existing three-line comment's meaning; the replacement above folds in
the reason the measurement is now reported. Leave every other field, and the
trailing `...previewBody(comment.body, context.full)` spread, exactly as they
are.

**Verify**: `npm run typecheck` → exit 0, no errors.

### Step 3: Update the local test interface

In `test/review.test.ts`, add the two fields to the local `ReviewComment`
interface (lines 20–32), after `diff_hunk`:

```ts
diff_hunk_length: number;
diff_hunk_truncated: boolean;
```

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Assert the new fields in the existing truncation test

In `test/review.test.ts`, find the test that seeds an over-long hunk (it sets
`diff_hunk: hunk` around line 307 and asserts `toHaveLength(500)` around line
318). Extend it so both the capped and the `--full` view are checked.

Next to the capped assertion, add:

```ts
expect(capped.reviews[0]?.comments[0]?.diff_hunk_truncated).toBe(true);
expect(capped.reviews[0]?.comments[0]?.diff_hunk_length).toBe(hunk.length);
```

Next to the `--full` assertion, add:

```ts
expect(full.reviews[0]?.comments[0]?.diff_hunk_truncated).toBe(false);
expect(full.reviews[0]?.comments[0]?.diff_hunk_length).toBe(hunk.length);
```

`diff_hunk_length` is the length of the _original_ hunk in code points in both
views — that is the whole point of the field. If `hunk` in that test is built
from non-ASCII characters, use `[...hunk].length` instead of `hunk.length`;
check how the fixture string is constructed before choosing.

**Verify**: `npx vitest run test/review.test.ts` → all pass.

### Step 5: Update the contract

In `docs/contract.md`, line 119, do two things:

1. Add `diff_hunk_length` and `diff_hunk_truncated` to the field list at the
   start of the paragraph, immediately after `diff_hunk`, so the enumerated
   identity matches what the code emits.
2. Extend the `diff_hunk` sentence so it states the measurement is reported.
   Suggested replacement for that sentence:

   > `diff_hunk` is the excerpt Forgejo anchors the comment to; it observes the
   > same preview ceiling as a body, so the capped view cannot emit an
   > unbounded hunk and `--full` returns it whole. `diff_hunk_length` and
   > `diff_hunk_truncated` measure it the way `body_length` and
   > `body_truncated` measure a body, so a capped hunk is never mistaken for a
   > whole one.

Match the surrounding prose style: declarative, present tense, no bullet lists
inside the paragraph.

**Verify**: `grep -c "diff_hunk_truncated" docs/contract.md` → at least `1`.

### Step 6: Run the full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- **Modified**: the existing over-long-hunk test in `test/review.test.ts` now
  asserts `diff_hunk_truncated` and `diff_hunk_length` in both the capped and
  `--full` views. It fails against the code as it stands today, because those
  fields do not exist.
- **No new test file.** The behaviour under test is an extension of a case the
  suite already covers; a separate test would duplicate its setup.
- **Structural pattern to follow**: the existing capped/`--full` pair in the
  same test.
- **Verification**: `npm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm test` exits 0
- [ ] `npm run check` exits 0
- [ ] `grep -c "diff_hunk_truncated" src/forgejo.ts` returns `2` (interface
      declaration plus the assignment)
- [ ] `grep -c "diff_hunk_truncated" docs/contract.md` returns at least `1`
- [ ] `grep -n "diff_hunk" src/forgejo.ts | grep -c "previewBody"` returns `0`
      — the preview is hoisted into a local, not called inline
- [ ] `git status --porcelain` lists only `src/forgejo.ts`,
      `test/review.test.ts`, `docs/contract.md`, and `plans/README.md`
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt does not match the live code.
- `npm run typecheck` does NOT fail after Step 1. That would mean the interface
  is not actually constraining `normalizeReviewComment`, and the change is not
  landing where this plan assumes.
- You find another producer of `ReviewCommentIdentity` besides
  `normalizeReviewComment`. There should be exactly one; more means the change
  is wider than planned.
- Adding the fields breaks a test outside `test/review.test.ts`. Additive
  output fields should not — if something asserts exact object equality on a
  review comment elsewhere, report where before editing it.

## Maintenance notes

- **Why not put the hunk fields on `BodyPreview`**: `BodyPreview` is shared with
  `CommentIdentity` (issue comments), which has no hunk. Widening the shared
  interface would emit two always-meaningless fields on every issue comment.
- **What a reviewer should scrutinise**: that `diff_hunk_length` reports the
  original length in _both_ views. A common mistake is measuring the truncated
  string, which makes the field report `500` and lose the information it exists
  to carry.
- **Related asymmetry left alone**: `pr reviews` still has no `--fields`
  selector, unlike `pr list` / `issue list` / `run list`. That is noted as a
  direction item in `plans/README.md`, not a defect, and is deliberately out of
  scope here.
