# First public release is 1.0.0

`docs/contract.md` promises that command names, field meanings, enum values, and
exit semantics require a major release to change. Semver reserves major version
zero for initial development, where anything may change at any time, so a 0.x
release would have contradicted that promise the moment a consumer read it. The
package publishes as 1.0.0 so the compatibility boundary the contract describes
is the one semver enforces.

## Considered options

Publishing 0.1.0 and amending the contract to defer its stability promise until
1.0.0. Rejected because the evidence that justifies the promise already exists —
live lanes against Forgejo 15 and 16, a generated skill byte-checked against its
sources, and a clean-clone install check — and because the consumers are agents
that read the contract, not the version range.

## Consequences

Renaming a command, changing an enum value, or altering an exit code now costs a
major release. Interface changes of that kind belong before the first publish.
