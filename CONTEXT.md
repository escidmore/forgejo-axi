# Glossary

## Command family

A top-level CLI noun (`pr`, `issue`, `run`, `label`) grouping subcommands over one
Forgejo resource type.

## Capability

A Forgejo API feature whose presence is established by probing the runtime Swagger
document for its route. Capabilities are never inferred from version numbers.

## Unsupported

The status a command reports when the capability it needs is absent from the
connected Forgejo. Unsupported is a distinct, successful outcome — not a failure
and not an error. Example: Actions log routes on Forgejo 15.0.5.

## Check

A single commit status reported against a pull request's head SHA, identified by
its context string. Forgejo's API calls these commit statuses; the CLI calls them
Checks. Where several statuses share one context, only the newest counts.

## Required check

A branch-protection pattern that Checks must satisfy before a pull request passes.
Patterns are globs, not exact names — one pattern may match several Checks, in
which case the worst state wins, or match none at all, which is the distinct state
`missing`.

The dialect is Forgejo's. Forgejo compiles required contexts with
`glob.Compile` and no separator, so `*` and `?` cross `/` and a leading dot is
ordinary; the CLI compiles the same dialect rather than delegating, because
minimatch stops `*` at a separator and cannot be configured otherwise. A pattern
of `ci*` matches a Check named `ci/unit` on both, and `?` spans one rune on
both, so a character outside the basic plane is a single unit either side.
Agreement is asserted live against Forgejo 15 and 16 for the star, `?`, class
and alternation constructs; escapes and astral runes are pinned in the unit
table instead.

The two still part on a malformed pattern. Forgejo logs and drops one gobwas
rejects — an unterminated class, an unbalanced brace, a trailing backslash — so
it cannot block a merge there; here it matches nothing and reads `missing`,
which blocks. That is the fail-closed direction and it surfaces the broken rule
rather than ignoring it. A reversed range like `[z-a]` is not in that class:
neither side rejects it, and both read it as a range nothing satisfies.

They also part on how an unmatched pattern is named. Forgejo folds it into
`pending`; the CLI reports the distinct `missing`, which is strictly more
informative and never green either way.

## Run

A single execution of an Actions workflow, grouping one or more Jobs. Exists as an
API resource only where the runs capability is advertised (Forgejo 16+).

## Job

One unit of execution inside a Run. Logs are fetched per Job where the job-logs
capability is advertised.

## Task

Forgejo's legacy flat Actions listing (`actions/tasks`), predating the Run/Job
API. Not part of the CLI vocabulary; commands speak in Runs and Jobs.
