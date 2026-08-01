# `forgejo-axi` command contract

This document is the compatibility boundary for machine consumers. Additive object fields and new capability names are allowed; command names, field meanings, enum values, and exit semantics require a major release to change.

## Invocation and configuration

```text
forgejo-axi
forgejo-axi --help
forgejo-axi --version
forgejo-axi status [connection flags]
forgejo-axi repo view --repo OWNER/REPO [connection flags]
forgejo-axi api METHOD PATH [--data JSON] [--paginate [--limit N|--full]] [connection flags]
forgejo-axi pr find --repo OWNER/REPO --head BRANCH [--base BRANCH] [--state STATE]
forgejo-axi pr list --repo OWNER/REPO [--state STATE] [--limit N|--full] [--fields LIST|all]
forgejo-axi pr view --repo OWNER/REPO NUMBER [--full]
forgejo-axi pr create --repo OWNER/REPO --title TITLE --head BRANCH --base BRANCH [--body BODY] [--draft]
forgejo-axi pr update --repo OWNER/REPO NUMBER [--title TITLE] [--body BODY] [--base BRANCH] [--state open|closed]
forgejo-axi pr checks --repo OWNER/REPO NUMBER
forgejo-axi pr mergeability --repo OWNER/REPO NUMBER
forgejo-axi pr merge --repo OWNER/REPO NUMBER --expected-head SHA [--method merge|squash|rebase]
forgejo-axi pr merged --repo OWNER/REPO NUMBER
forgejo-axi label list --repo OWNER/REPO [--limit N|--full]
forgejo-axi label create --repo OWNER/REPO NAME [--color HEX] [--description TEXT]
forgejo-axi label edit --repo OWNER/REPO NAME [--name NEW] [--color HEX] [--description TEXT]
forgejo-axi label delete --repo OWNER/REPO NAME
forgejo-axi issue list --repo OWNER/REPO [--state open|closed|all] [--label NAMES] [--assignee USER] [--milestone NAME] [--limit N|--full] [--fields LIST|all]
forgejo-axi issue view --repo OWNER/REPO NUMBER [--full]
forgejo-axi issue create --repo OWNER/REPO --title TITLE [--body BODY] [--label NAMES] [--assignee USERS] [--milestone NAME]
forgejo-axi issue edit --repo OWNER/REPO NUMBER [--title TITLE] [--body BODY] [--label NAMES] [--assignee USERS] [--milestone NAME]
forgejo-axi issue close --repo OWNER/REPO NUMBER [--comment TEXT]
forgejo-axi issue reopen --repo OWNER/REPO NUMBER
forgejo-axi issue comment --repo OWNER/REPO NUMBER --body TEXT
forgejo-axi run list --repo OWNER/REPO [--status STATUS] [--branch BRANCH] [--limit N|--full] [--fields LIST|all]
forgejo-axi run view --repo OWNER/REPO RUN_ID [--log|--log-failed]
forgejo-axi run cancel --repo OWNER/REPO RUN_ID
forgejo-axi run download --repo OWNER/REPO RUN_ID --dir DIR [--name NAME]
```

With no arguments and no configured base URL, the CLI returns a configuration-free home document. With `FORGEJO_BASE_URL` configured, bare invocation performs the same runtime probes as `status` and may fail with a runtime exit. `--help` and `--version` are top-level, sole-argument invocations.

A bare `--` ends flag parsing; every remaining argument is a positional. This is the only way to address a value that begins with `-`, such as a label named `-blocked`.

Connection flags are `--base-url URL`, `--token-env NAME`, `--timeout-ms N`, `--ca-file PATH`, and `--json`. Environment defaults are `FORGEJO_BASE_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_TIMEOUT_MS`, and `FORGEJO_CA_FILE`. `--ca-file`/`FORGEJO_CA_FILE` supplies a replacement CA trust bundle, matching Node's TLS `ca` behavior; it does not append to the platform trust store.

Authentication resolves `--token-env` first, then `FORGEJO_TOKEN_<HOST_KEY>`, then `FORGEJO_TOKEN` only when the base URL came from `FORGEJO_BASE_URL`. An explicitly named `--token-env` variable that is unset or empty is a usage error. Tokens are never accepted as arguments, persisted, or emitted.

`HOST_KEY` is the uppercase URL host including a non-default port. Each non-alphanumeric ASCII character is encoded as `_HH_` using its hexadecimal code point, so `forgejo.example:8443` becomes `FORGEJO_2E_EXAMPLE_3A_8443` and cannot collide with `forgejo-example:8443`. HTTP authentication is accepted only for loopback hosts. Base URLs may contain a path prefix; credentials, query strings, fragments, encoded separators/dot segments, and cross-origin redirects are rejected. Same-origin `301`/`302` redirects are followed only for `GET`/`HEAD`, ambiguous mutation redirects are rejected, `303` switches to `GET`, and `307`/`308` preserve the method and body. Internally encoded `/` characters are accepted only for trusted Forgejo path segments such as branch names; raw `api PATH` input remains strict.

## Output and exits

Default stdout is one concise TOON document. `--json` emits the same fields and meanings as one JSON document. TOON list views display a capped number of rows while JSON displays every fetched row; `page_info` makes that difference explicit. `--limit` is TOON-only and fails loudly when combined with `--json` or `--full`. Diagnostics and progress use stderr only.

Exit `0` means success or an idempotent no-op, `1` means runtime/API/security failure, and `2` means invalid invocation. Errors have this stable shape:

```json
{
  "error": "human-readable message",
  "code": "STABLE_CODE",
  "details": {},
  "help": ["complete command"]
}
```

A command whose capability the connected host does not advertise returns an unsupported document rather than an error:

```json
{
  "supported": false,
  "capability": "runs",
  "next": ["complete command"]
}
```

Exit is `0` and neither `error` nor `code` is present: an unsupported capability is a definite answer, not a failure. `capability` names the same runtime-probed boolean `status` reports. No request is made against the unsupported API, so the probe is the only traffic the invocation produces.

Paginated responses include `page_info: {complete, pages, fetched, total, displayed, truncated}`. The safety ceiling is 100 pages of 50 rows (5000 fetched rows). Reaching it sets `complete=false`; a definitive-looking empty result must not hide incomplete fetching. TOON lists display 30 rows by default (or `--limit N`) and include a `--full` hint when rows are hidden. `--full` and JSON display every fetched row but cannot make an incomplete fetch complete.

## Command response schemas

Additive fields are permitted. Nullable fields are emitted as `null`, not omitted, when listed below.

- `status`: `{host:{url,api_url}, auth:{configured,authenticated,source}, server:{version}, capabilities:{pull_requests,commit_statuses,branch_protection,expected_head_merge,actions_job_logs,runs,probe:{source,complete}}}`.
- `repo view`: `{repository:{full_name,url,api_url,description,private,archived,default_branch,has_actions,has_pull_requests,open_pull_requests}}`.
- `api` (single request): `{status,data}`. Paginated `api`: `{data,page_info,next?}`.
- `pr find`: `{found,pull_request,search_info:{complete,pages,fetched,total}}`; `pull_request` is an identity or `null`.
- `pr list`: `{pull_requests,page_info,next?}`. Default rows are `{number,title,state,head}`; `--fields` selects other identity fields and `--fields all` selects all of them.
- `pr view`: `{pull_request:{...identity,body,body_length,body_truncated}}`. `body` is a 500-Unicode-code-point preview by default and complete with `--full`; `body_length` is measured in Unicode code points.
- `pr create`: `{created,updated,pull_request}`. `pr update`: `{updated,pull_request}`. Existing desired state is exit-0 and mutation-free. Creation refuses with `PAGINATION_INCOMPLETE` if either its initial duplicate search or its post-conflict race-recovery search reaches the pagination ceiling without finding the pull request.
- `pr checks`: `{checks}`; `pr mergeability`: `{mergeability}`; `pr merge` and `pr merged`: `{proof}`.
- `label list`: `{labels,page_info,next?}`. A repository with no labels is `labels: []` with `page_info.fetched=0` and exit `0`.
- `label create`: `{created,updated,label}`. `label edit`: `{updated,label}`. `label delete`: `{deleted,label}`.
- `issue list`: `{issues,page_info,next?}`. Rows carry the selected identity fields, defaulting to `number,title,state,labels`. A repository with no matching issues is `issues: []` with `page_info.fetched=0` and exit `0`.
- `issue view`: `{issue,comments,comment_info,next?}`. `issue` is an issue identity plus `body`, `body_length`, and `body_truncated`. `comment_info` is `{fetched,displayed,truncated}`.
- `issue create`: `{issue}`. `issue edit`: `{updated,issue}`. `issue close` and `issue reopen`: `{updated,issue}`, plus `comment` when `--comment` posted one. `issue comment`: `{comment}`.
- `run list`: `{runs,page_info,next?}`, sharing the `page_info` shape above. Rows carry the selected identity fields, defaulting to `id,title,status,branch`. A repository with no matching runs is `runs: []` with `page_info.fetched=0` and exit `0`.
- `run view`: `{run,jobs,next?}`. `jobs` is an ordered array of job identities.
- `run cancel`: `{cancelled,run}`. `run download`: `{run_id,dir,downloaded}`, where `downloaded` rows are `{name,size_in_bytes,path}`.
- Each `run` command returns the unsupported document described above, with `capability: "runs"`, when the host does not advertise the Actions runs API.

## Stable lifecycle objects

A pull request identity is `{number, url, api_url, state, draft, title, head, base, head_sha, mergeable, merged, merge_commit_sha, merged_at, merged_by}`. `url` and `api_url` are constructed from the configured canonical base URL and repository identity, not trusted response links.

Checks are `{sha, reported, state, statuses, required, required_state, passes, protection}`. Status rows are `{context,state,description,target_url,updated_at}`; required-context rows are `{context,state,matched}`; protection is `{protected,rule,status_checks_enabled}`. Nullable status metadata and `protection.rule` are emitted as `null`. `state` is `none|pending|failure|success`; an empty set is always `reported=0,state=none`. Each required pattern is `missing|pending|failure|success`; only `success` passes. `required_state` is `not_required|missing|pending|failure|success`, so missing required contexts can never be green. Checks query the current base branch protection; if that branch no longer exists, the command fails `NOT_FOUND` rather than fabricating required-context semantics, including for an already-merged pull request.

Mergeability is `{number, url, head_sha, forgejo_mergeable, checks_pass, mergeable, reasons}`. `mergeable` is true only when Forgejo reports the pull mergeable and checks pass. Checks are evaluated even for already-merged pull requests; `checks_pass` is never fabricated. Reasons include `already_merged`, `forgejo_not_mergeable`, and `checks_<state>` using the required state, or the overall state when no contexts are required.

Merge requires `--expected-head`. The expected SHA is verified before returning any proof, including already-merged and post-error recovery paths, and Forgejo's atomic `head_commit_id` guard is sent for the mutation. A head mismatch is `HEAD_CHANGED` and is never retried against the new head.

Merged-state proof always has `{merged, number, url, head_sha, merge_commit_sha, merged_at, merged_by}`. For an unmerged pull request, `merged=false` and unavailable merge fields are `null`; consumers never receive a smaller undocumented shape.

A label identity is `{id, name, color, description, is_archived, api_url}`. `api_url` is constructed from the configured canonical base URL and repository identity, not trusted response links. `color` is normalized to a lowercase `#rrggbb` string; a value Forgejo returns in another form is passed through unchanged. Labels are repository-scoped only.

Labels are addressed by name at the interface and resolved to their numeric id internally; the same resolution backs every name-addressed command. Resolution failures are usage errors with exit `2` and a `help` entry naming the `label list` command for the repository: `LABEL_NOT_FOUND` when no label carries the name, and `LABEL_AMBIGUOUS` with `details.ids` when more than one does, since Forgejo does not enforce label-name uniqueness. Resolution never mutates off an incomplete fetch: reaching the pagination ceiling raises `PAGINATION_INCOMPLETE` (exit `1`) whether the name matched or not, because an unread page can carry a second label of the same name. Only `label list` reports an incomplete fetch as data rather than failing.

Because Forgejo re-derives a label's archived state from every edit request, patches resend the label's current `is_archived` value; editing an archived label never unarchives it as a side effect.

An issue identity is `{number, url, api_url, state, title, labels, assignees, milestone, comments, is_pull_request, user, created_at, updated_at, closed_at}`. `url` and `api_url` are constructed from the configured canonical base URL and repository identity, not trusted response links. `labels` and `assignees` are name arrays and `milestone` is a name or `null`; ids stay internal. A comment identity is `{id, api_url, user, created_at, updated_at, body, body_length, body_truncated}`.

`issue list` returns issues only — pull requests are excluded and reached through `pr list`. Its `--label` and `--milestone` filters resolve names through the same name-addressing described above before the query is sent, because Forgejo silently discards unknown filter names and would otherwise return an unfiltered result that reads like a filtered one; an unknown name is `LABEL_NOT_FOUND` or `MILESTONE_NOT_FOUND` (exit `2`) and no listing request is made. `--label` takes comma-separated names; `--assignee` takes a single username, because Forgejo's issue query filters on one assignee. Empty entries in a comma-separated value are discarded, so a trailing comma is not a lookup for the empty name.

`issue view` previews a long body on the same terms as `pr view`: the first 500 code points with an ellipsis, with `body_length` and `body_truncated` reporting the elision, and `--full` returning the whole body. Forgejo returns an entire comment thread in one response and ignores pagination on that endpoint, so the thread is fetched once and capped at display time; TOON shows 30 comments and `--full` or `--json` shows every one.

`issue edit` reconciles: it fetches current state and sends only the fields that differ, reporting `updated=false` and issuing no mutation when the issue already matches. Every label and milestone name resolves before the first mutation, so an unknown name cannot leave an issue half-edited. Labels are replaced through Forgejo's issue-labels endpoint rather than the issue patch body, which has no labels field. An empty `--label`, `--assignee`, or `--milestone` value clears that field. `issue edit` with no field flag is a usage error (exit `2`).

`issue close --comment` posts the comment before the state change, so a comment is never attributed to an issue that failed to close. Closing an already-closed issue is `updated=false`, but a supplied comment still posts — comments are not idempotent.

The number-addressed issue commands share Forgejo's single index namespace for issues and pull requests, and none of them refuse a pull request number: `issue comment` lands in that pull request's discussion, and `issue view`, `issue edit`, `issue close`, and `issue reopen` act on the pull request itself. This is why no separate `pr comment` exists. `issue list` is the exception, returning issues only. An agent that needs the distinction reads `is_pull_request` from the identity.

Assignee usernames are not resolved before mutation the way label and milestone names are; Forgejo validates them and rejects an unknown one. `--title` may not be empty on `issue create` or `issue edit`, and `--comment` may not be empty on `issue close`, since Forgejo has no empty-title or empty-comment state to reach.

`label create` reconciles: an existing label of that name is patched toward the requested color and description rather than duplicated, reporting `created=false`. A label already in the desired state is exit `0` and mutation-free. New labels default to color `#ededed` and an empty description. `--color` must be a six-digit hex color, validated before any request. `label edit --name` renames in place, preserving the label's issue assignments; renaming onto a name the repository already carries is refused with `LABEL_EXISTS` (exit `2`).

A run identity is `{id, url, api_url, title, event, branch, head_sha, run_number, status, started_at, completed_at}`. `url` and `api_url` are constructed from the configured canonical base URL and repository identity, not trusted response links. `branch` is the short name of the git ref the run was triggered from and `status` is the run state Forgejo reports, defaulting to `unknown`; `started_at` and `completed_at` are `null` while unset. A job identity is `{id, run_id, name, status}`, plus `log` when a log was requested and folded in.

`run list --status` accepts `unknown`, `waiting`, `running`, `success`, `failure`, `cancelled`, `skipped`, or `blocked`, validated before any request; `--branch` filters on the branch the run was triggered from. `run view --log` folds every job's log into its job entry and `--log-failed` folds only failed jobs' logs; the two cannot be combined. When job logs are requested but the host does not advertise the log route, the logs are omitted and `next` says so — an unsupported log is never an error and never alters the rest of the response.

`run cancel` reports `cancelled=true` only when the run was still actionable beforehand; cancelling an already finished run is exit `0`, `cancelled=false`, and returns the run unchanged.

`run download` writes each artifact to `{--dir}/{name}.zip`, creating `--dir` and its parents when missing, and narrows to one artifact with `--name`. An existing file is never overwritten: the download fails with `ARTIFACT_EXISTS` (exit `1`) naming the path. An artifact name Forgejo returns that would escape the directory is refused as `INVALID_RESPONSE`. Artifacts are written one at a time, so a failure partway through leaves the artifacts already written on disk.

Capabilities are runtime-probed booleans, never version assumptions. If the Swagger document is unavailable, forbidden, rate-limited, malformed, times out, or returns a server error after the API version probe succeeds, status returns all capability booleans false with `probe.complete=false` instead of failing the entire status command. Forgejo 15 reports Actions job logs and Actions runs unsupported; Forgejo 16 reports support only when its runtime document advertises each route. Unsupported logs never alter commit-status semantics.
