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

## Run

A single execution of an Actions workflow, grouping one or more Jobs. Exists as an
API resource only where the runs capability is advertised (Forgejo 16+).

## Job

One unit of execution inside a Run. Logs are fetched per Job where the job-logs
capability is advertised.

## Task

Forgejo's legacy flat Actions listing (`actions/tasks`), predating the Run/Job
API. Not part of the CLI vocabulary; commands speak in Runs and Jobs.
