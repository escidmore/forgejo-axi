# 1. Required status contexts match in Forgejo's glob dialect

Status: Accepted (2026-08-02)

Recorded for FJA-14, which asked for this as `0002` alongside a `0001` that was
never written. This is the repository's first decision record, so it takes the
first number. The issue also asked for status `Proposed`, on the expectation
that the evidence would still be open when it was filed; the evidence landed
first, so it is filed as accepted.

## Context

A branch-protection rule names required status contexts as globs. `pr checks`
and `pr mergeability` decide whether a pull request is merge-eligible by
matching those patterns against the contexts Checks actually reported, and
Forgejo decides the same thing server-side from the same rule. The two matchers
therefore have to agree, or the CLI blocks merges the host would allow.

The CLI matched with minimatch, whose `*` stops at `/` and which skips a leading
dot. Forgejo compiles required contexts in `services/pull/commit_status.go` with
`glob.Compile(ctx)` and no separator argument, so gobwas lets `*` and `?` cross
`/` and treats a leading dot as ordinary. A rule of `ci*` matched a Check named
`ci/unit` on the server and not here.

The divergence was fail-closed: the CLI reported `missing`, `passes` went false,
and `mergeability` refused a merge Forgejo would have taken. A false blocker
stalls an agent merge loop rather than admitting an unsafe merge — which is why
closing the gap loosens a safety gate, and why it could not land on inference.

## Decision

Match required contexts in Forgejo's dialect, compiled in `src/checks.ts`.

minimatch has no option to cross a separator, so the dialect is compiled here
rather than delegated, and minimatch leaves the dependency list. Patterns become
tokens matched against the context's runes, not a translated `RegExp`, for two
reasons. gobwas matches runes, so `?` there covers an astral character that a
UTF-16 character class splits in half. And a glob translated to a backtracking
expression is exponential on inputs like `*a*a*a*x` — measured at roughly ten
seconds for eight stars against a sixty-character context — which is reachable
because a commit status names its own context. Walking the set of reachable
positions costs one pass per token instead.

## Evidence

The live lanes provision a protected branch requiring `live*`, `live/cross?ng`,
`live[!x]*` and `live/{crossing,other}`, report a single Check named
`live/crossing`, and compare the CLI's `checks_pass` against Forgejo's own
settled `mergeable`. Before the change both hosts answered
`forgejo_mergeable=true checks_pass=false`; after it, both answer true. Probed
on Forgejo 15.0.5 and 16.0.1.

Escapes, astral runes, reversed ranges and malformed patterns are pinned in the
unit table rather than live, since provisioning a Check named `live*` against a
real host is not worth the teardown risk.

## Consequences

Two differences remain, deliberately. Forgejo logs and drops a pattern gobwas
rejects, so a malformed rule cannot block a merge there; here it matches nothing
and reads `missing`, which blocks. That is the fail-closed direction and it
surfaces the broken rule rather than ignoring it. Separately, Forgejo folds an
unmatched pattern into `pending` while the CLI reports the distinct `missing`,
which is strictly more informative and never green either way.

A reversed range like `[z-a]` is not a rejection on either side: gobwas builds a
range nothing satisfies, and so does this.

The dialect is now part of the `pr checks` contract in `docs/contract.md`, so
changing it again is a compatibility change and needs its own live cases.
