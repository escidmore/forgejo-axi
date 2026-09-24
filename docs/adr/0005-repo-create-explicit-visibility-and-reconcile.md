# 5. `repo create` requires explicit visibility, routes by login, and reconciles

Status: Accepted (2026-09-19)

## Context

Creating a repository was reachable only through `api POST user/repos` or
`api POST orgs/{org}/repos`, which means every agent that needs one rebuilds
the same three decisions: which route to post to, what visibility to send,
and what to do when the name is taken. Forgejo's `CreateRepoOption` defaults
`private` to the instance setting, so an agent that omits the field publishes
or hides a repository according to server configuration it cannot see. The
name-taken case answers `409`, which is also what a create that lost a race
answers, and the raw path leaves the agent to tell those apart.

## Decisions

**Exactly one of `--private` or `--public`, or a usage error.** Neither and
both exit `2` before any request. This follows the precedent of explicit
visibility on gist creation in sibling CLIs. A defaulted visibility would be
the one way this command could publish something by omission, and the
server-side default is invisible to the caller, so the flag carries no
default at all.

**Route from the authenticated login, never from the owner's shape.** The
command resolves `GET /user` once and posts to `user/repos` when `OWNER`
equals that login, otherwise to `orgs/{OWNER}/repos`. Guessing from the name
cannot work: a user and an organization can carry the same kind of name, and
posting the wrong route fails with a `404` that reads like a missing owner.
The extra request costs one round trip and removes a class of wrong answer.

**Reconcile onto an existing repository; never mutate it.** A repository
already at the address, whether read before the request or found behind a
`409` the request provoked, is returned with `created: false` and exit `0`.
Requested fields it does not satisfy are reported in `differs` as
`{field, requested, actual}`, today `private` always and `default_branch`
and `description` when requested. The command never patches the existing
repository toward the request. `label create` and `pr create` reconcile by
applying differences; this command reports them instead, because changing a
repository's visibility is a publication or a lockdown, which is a decision
for the caller and not a side effect of asking for a repository to exist. A
`409` with nothing readable behind it remains `CONFLICT`.

**One repository object.** `repo view` and `repo create` share a normalizer.
Both gain `clone_url`, rebuilt from the canonical base URL like `url` and
`api_url`, plus `empty` and `ssh_url`. `ssh_url` is the one field taken from
the host, because the SSH domain and port are server configuration with no
canonical form the CLI can derive; it is `null` when the host reports none.

**Capability, not version.** `repo_create` is probed from the runtime Swagger
document as the presence of both creation routes, so a host missing either
returns the unsupported document before any request, as every other family
does.

## Consequences

Additive: a new command, a new capability name, and three new fields on the
repository object, all permitted in a minor release under the contract.

An agent that wants to change an existing repository's visibility, default
branch, or description reads `differs` and decides;
`api PATCH repos/{owner}/{repo}` remains the mutation path. A future
`repo edit` could take that over.

The live lane creates and deletes a repository under the lane owner and under
the authenticated login, so both routes are proven against a real host
whenever the lane repository's owner is not the authenticated login, and only
the user route otherwise. Deleting a repository needs the token's delete
permission; a lane token without it reports the repository as leaked rather
than failing silently.
