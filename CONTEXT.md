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

The CLI and Forgejo do not currently agree on the glob dialect. Forgejo compiles
required contexts with `glob.Compile` and no separator, so its `*` crosses `/`;
the CLI matches with minimatch, whose `*` stops at `/` and which additionally
refuses to match a leading dot. A pattern of `ci*` therefore matches a Check named
`ci/unit` on the server but not here, and the CLI reports `missing` against a pull
request Forgejo will merge. Probed live against Forgejo 15 and 16.

## Run

A single execution of an Actions workflow, grouping one or more Jobs. Exists as an
API resource only where the runs capability is advertised (Forgejo 16+).

## Job

One unit of execution inside a Run. Logs are fetched per Job where the job-logs
capability is advertised.

## Task

Forgejo's legacy flat Actions listing (`actions/tasks`), predating the Run/Job
API. Not part of the CLI vocabulary; commands speak in Runs and Jobs.
