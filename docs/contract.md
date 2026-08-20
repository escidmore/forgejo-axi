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
forgejo-axi pr view [--repo OWNER/REPO] NUMBER|URL [--full]
forgejo-axi pr history [overview|list|detail|soft-delete] [--repo OWNER/REPO] NUMBER|URL [--comment-id ID] [--history-id ID] [--raw] [--yes]
forgejo-axi pr reviews [--repo OWNER/REPO] NUMBER|URL [--limit N|--full]
forgejo-axi pr diff [--repo OWNER/REPO] NUMBER|URL [--full]
forgejo-axi pr create --repo OWNER/REPO --title TITLE --head BRANCH --base BRANCH [--body BODY | --body-file PATH|-] [--draft]
forgejo-axi pr update [--repo OWNER/REPO] NUMBER|URL [--title TITLE] [--body BODY | --body-file PATH|-] [--base BRANCH] [--state open|closed]
forgejo-axi pr checks [--repo OWNER/REPO] NUMBER|URL
forgejo-axi pr mergeability [--repo OWNER/REPO] NUMBER|URL
forgejo-axi pr merge [--repo OWNER/REPO] NUMBER|URL --expected-head SHA [--method merge|squash|rebase]
forgejo-axi pr merged [--repo OWNER/REPO] NUMBER|URL
forgejo-axi label list --repo OWNER/REPO [--limit N|--full]
forgejo-axi label create --repo OWNER/REPO NAME [--color HEX] [--description TEXT]
forgejo-axi label edit --repo OWNER/REPO NAME [--name NEW] [--color HEX] [--description TEXT]
forgejo-axi label delete --repo OWNER/REPO NAME
forgejo-axi issue list --repo OWNER/REPO [--state open|closed|all] [--label NAMES] [--assignee USER] [--milestone NAME] [--limit N|--full] [--fields LIST|all]
forgejo-axi issue view --repo OWNER/REPO NUMBER [--full]
forgejo-axi issue history [overview|list|detail|soft-delete] --repo OWNER/REPO NUMBER [--comment-id ID] [--history-id ID] [--raw] [--yes]
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

With no arguments and no configured base URL, the CLI returns a configuration-free home document. With `FORGEJO_BASE_URL` or a single hosts-file entry configured, bare invocation performs the same runtime probes as `status` and may fail with a runtime exit. `--help` and `--version` are top-level, sole-argument invocations.

A bare `--` ends flag parsing; every remaining argument is a positional. A
separate value beginning with `-` remains reserved for flags, except the exact
`-` accepted by `--body-file` as its stdin marker. Inline values such as
`--body=-` remain values. Use `--` to address another value that begins with
`-`, such as a label named `-blocked`.

For `pr create` and `pr update`, `--body` and `--body-file` are mutually exclusive. `--body-file PATH` reads a UTF-8 file and `--body-file -` reads stdin; body-file content is forwarded verbatim. Input that cannot be read, or whose bytes are not valid UTF-8, is refused with `BODY_FILE_ERROR` (exit `2`) before any request is made, because the invocation named an unusable body source rather than the host failing. No other command accepts `--body-file`: `issue create`, `issue edit`, and `issue comment` take `--body` only.

A pull request `URL` supplies the repository and number for every command that accepts `NUMBER|URL`; it never changes the configured Forgejo base URL or where credentials are sent. The URL must use HTTP(S), contain no credentials, and carry an `OWNER/REPO/pulls/NUMBER` path, including beneath a path prefix or the API route. An explicit `--repo` may accompany a URL only when it names the same repository; a URL overrides `FORGEJO_REPOSITORY`.

Connection flags are `--base-url URL`, `--token-env NAME`, `--timeout-ms N`, `--ca-file PATH`, and `--json`. Environment defaults are `FORGEJO_BASE_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_TIMEOUT_MS`, and `FORGEJO_CA_FILE`. `--ca-file`/`FORGEJO_CA_FILE` supplies a replacement CA trust bundle, matching Node's TLS `ca` behavior; it does not append to the platform trust store.

`~/.config/forgejo-axi/hosts.json` is resolved from `HOME`, not the current directory or a platform home lookup. Its top-level keys are URL hosts (including non-default ports); every entry contains matching non-empty `base_url` and `token` strings. A single entry supplies the base URL when neither `--base-url` nor `FORGEJO_BASE_URL` is set; multiple entries require one of those selectors. The file is optional, but when present it must be a regular file with mode `0600` and valid JSON.

Authentication resolves `--token-env` first, then `FORGEJO_TOKEN_<HOST_KEY>`, then `FORGEJO_TOKEN` when the base URL came from `FORGEJO_BASE_URL`, then the matching hosts-file entry. An explicitly named `--token-env` variable that is unset or empty is a usage error. Tokens are never accepted as argument values or emitted. The CLI reads but never writes the hosts file.

`HOST_KEY` is the uppercase URL host including a non-default port. Each non-alphanumeric ASCII character is encoded as `_HH_` using its hexadecimal code point, so `forgejo.example:8443` becomes `FORGEJO_2E_EXAMPLE_3A_8443` and cannot collide with `forgejo-example:8443`. Plaintext `http://` base URLs are accepted only for loopback hosts, with or without a token: a non-loopback plaintext base URL is refused with `INSECURE_TRANSPORT` (exit `1`) before any request is made, because an on-path attacker authors every field of a plaintext response. `docs/adr/0004-plaintext-transport-is-refused.md` records that decision. Base URLs may contain a path prefix; credentials, query strings, fragments, encoded separators/dot segments, and cross-origin redirects are rejected. Same-origin `301`/`302` redirects are followed only for `GET`/`HEAD`, ambiguous mutation redirects are rejected, `303` switches to `GET`, and `307`/`308` preserve the method and body. Internally encoded `/` characters are accepted only for trusted Forgejo path segments such as branch names; raw `api PATH` input remains strict.

## Output and exits

Default stdout is one concise TOON document. `--json` emits the same fields and meanings as one JSON document. TOON list views display a capped number of rows while JSON displays every fetched row; `page_info` makes that difference explicit. `--limit` is TOON-only and fails loudly when combined with `--json` or `--full`. Diagnostics and progress use stderr only.

Because TOON is the default, its encoded form is part of this contract. Control characters in the C0 range (`0x00`–`0x1f`) are emitted escaped as `\uXXXX` rather than raw, so server-controlled text cannot carry a terminal control sequence into a reading agent's stdout; `DEL` (`0x7f`) and the C1 range (`0x80`–`0x9f`), which neither encoder escapes, are stripped from the rendered document instead, so no server-controlled control character reaches stdout in either output mode. An empty array is `key: []`. A scalar beginning with `#` is quoted, because a `#` that opens a line is stripped as a TOON comment on decode. `docs/adr/0003-toon-encoder-version.md` records the encoder version these rules come from, and a golden test pins them byte-for-byte.

Exit `0` means success or an idempotent no-op, `1` means runtime/API/security failure, and `2` means invalid invocation. Errors have this stable shape:

```json
{
  "error": "human-readable message",
  "code": "STABLE_CODE",
  "details": {},
  "help": ["complete command"]
}
```

Response bodies are bounded at the transport: 16 MiB parsed, 64 MiB raw. A body past its ceiling is refused with `RESPONSE_TOO_LARGE` (exit `1`) rather than buffered without limit. Artifact downloads stream to disk and are subject to neither ceiling.

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

- `status`: `{host:{url,api_url}, auth:{configured,authenticated,source}, server:{version}, capabilities:{pull_requests,commit_statuses,branch_protection,expected_head_merge,actions_job_logs,runs,run_jobs,run_cancel,run_artifacts,probe:{source,complete}}}`.
- `repo view`: `{repository:{full_name,url,api_url,description,private,archived,default_branch,has_actions,has_pull_requests,open_pull_requests}}`.
- `api` (single request): `{status,data}`. Paginated `api`: `{data,page_info,next?}`.
- `pr find`: `{found,pull_request,search_info:{complete,pages,fetched,total}}`; `pull_request` is an identity or `null`.
- `pr list`: `{pull_requests,page_info,next?}`. Default rows are `{number,title,state,head}`; `--fields` selects other identity fields and `--fields all` selects all of them.
- `pr view`: `{pull_request:{...identity,body,body_length,body_truncated,edit_history_count},next?}`. `body` is a 500-Unicode-code-point preview by default and complete with `--full`; `body_length` is measured in Unicode code points. `edit_history_count` and the runnable `next` hint are present only when content history exists. The lookup is best-effort and never fails the view: a host without the content-history routes, or one that refuses or fails to answer them, returns the same document without those fields.
- `pr history` and `issue history`: `overview` returns `{overview:{counts:[{comment_id,count}],total}}`; `list` returns `{comment_id,revisions:[{history_id,summary}]}` newest first; `detail` returns `{revision:{history_id,previous_history_id,can_soft_delete,before,after,diff_html?}}`; `soft-delete` returns `{deleted,already_deleted?,comment_id,history_id,message?}`. The default operation is `list` and the default comment id is `0`, the body. `before` and `after` are reconstructed from Forgejo's diff HTML with `gd` omitted from `after` and `gi` omitted from `before`; raw HTML is included only with `--raw`. Soft-delete requires `--yes`, never prompts, checks `can_soft_delete`, and exits `0` for an already-deleted no-op; a host that withholds that permission is refused with `CONTENT_HISTORY_DELETE_REFUSED` before anything is posted. A host too old to serve the routes reports `CONTENT_HISTORY_UNSUPPORTED`; a repository the web root itself cannot read reports `CONTENT_HISTORY_AUTHORIZATION`, since that interface authenticates by session rather than by API token and answers for a private repository with the same 404. A revision that does not exist on a host that does serve the routes is `CONTENT_HISTORY_NOT_FOUND`, and diff HTML that cannot be reconstructed is `CONTENT_HISTORY_MALFORMED_DIFF` rather than a silently partial `before` or `after`.
- `pr create`: `{created,updated,pull_request}`. `pr update`: `{updated,pull_request}`. Existing desired state is exit-0 and mutation-free. Creation refuses with `PAGINATION_INCOMPLETE` if either its initial duplicate search or its post-conflict race-recovery search reaches the pagination ceiling without finding the pull request.
- `pr checks`: `{checks}`; `pr mergeability`: `{mergeability}`; `pr merge` and `pr merged`: `{proof}`.
- `pr reviews`: `{reviews,page_info,next?}`. A pull request with no reviews is `reviews: []` with `page_info.fetched=0` and exit `0`.
- `pr diff`: `{diff,diff_info:{lines,displayed,truncated},next?}`. An empty diff is `diff: ""` with `diff_info.lines=0` and exit `0`.
- `label list`: `{labels,page_info,next?}`. A repository with no labels is `labels: []` with `page_info.fetched=0` and exit `0`.
- `label create`: `{created,updated,label}`. `label edit`: `{updated,label}`. `label delete`: `{deleted,label}`.
- `issue list`: `{issues,page_info,next?}`. Rows carry the selected identity fields, defaulting to `number,title,state,labels`. A repository with no matching issues is `issues: []` with `page_info.fetched=0` and exit `0`.
- `issue view`: `{issue,comments,comment_info,next?}`. `issue` is an issue identity plus `body`, `body_length`, `body_truncated`, and `edit_history_count` when content history exists, on the same best-effort terms as `pr view`. `comment_info` is `{fetched,displayed,truncated}`; `next` includes a runnable history-list hint when the count is positive.
- `issue create`: `{issue}`. `issue edit`: `{updated,issue}`. `issue close` and `issue reopen`: `{updated,issue}`, plus `comment` when `--comment` posted one. `issue comment`: `{comment}`.
- `run list`: `{runs,page_info,next?}`, sharing the `page_info` shape above. Rows carry the selected identity fields, defaulting to `id,title,status,branch`. A repository with no matching runs is `runs: []` with `page_info.fetched=0` and exit `0`.
- `run view`: `{run,jobs,next?}`. `jobs` is an ordered array of job identities.
- `run cancel`: `{cancelled,run}`. `run download`: `{run_id,dir,downloaded}`, where `downloaded` rows are `{name,size_in_bytes,path}`.
- Each `run` command returns the unsupported document described above, with `capability: "runs"`, when the host does not advertise the Actions runs API.

## Stable lifecycle objects

A pull request identity is `{number, url, api_url, state, draft, title, head, base, head_sha, mergeable, merged, merge_commit_sha, merged_at, merged_by}`. `url` and `api_url` are constructed from the configured canonical base URL and repository identity, not trusted response links.

Checks are `{sha, reported, state, statuses, required, required_state, passes, protection}`. Status rows are `{context,state,description,target_url,updated_at}`; required-context rows are `{context,state,matched}`; protection is `{protected,rule,status_checks_enabled}`. Nullable status metadata and `protection.rule` are emitted as `null`. `state` is `none|pending|failure|success`; an empty set is always `reported=0,state=none`. Each required pattern is `missing|pending|failure|success`; only `success` passes. `required_state` is `not_required|missing|pending|failure|success`, so missing required contexts can never be green. Required patterns are matched in Forgejo's own dialect — `glob.Compile` with no separator — so `*` and `?` cross `/`, a leading dot is ordinary, `[abc]`, `[a-z]` and `[!abc]` are classes, `{a,b}` alternates, `\` escapes the next character, and a leading `!` is a literal rather than a negation. `?` spans one rune, so a character outside the basic plane is a single unit. A pattern that dialect rejects — an unterminated class, an unbalanced brace, a trailing backslash — matches nothing and reads `missing`; Forgejo instead drops it, so a malformed rule blocks here and does not there. A reversed range such as `[z-a]` is not rejected by either side: both read it as a range nothing satisfies. Checks query the current base branch protection; if that branch no longer exists, the command fails `NOT_FOUND` rather than fabricating required-context semantics, including for an already-merged pull request.

Mergeability is `{number, url, head_sha, forgejo_mergeable, checks_pass, mergeable, reasons}`. `mergeable` is true only when Forgejo reports the pull mergeable and checks pass. Checks are evaluated even for already-merged pull requests; `checks_pass` is never fabricated. Reasons include `already_merged`, `forgejo_not_mergeable`, and `checks_<state>` using the required state, or the overall state when no contexts are required.

Merge requires `--expected-head`. The expected SHA is verified before returning any proof, including already-merged and post-error recovery paths, and Forgejo's atomic `head_commit_id` guard is sent for the mutation. A head mismatch is `HEAD_CHANGED` and is never retried against the new head.

Merged-state proof always has `{merged, number, url, head_sha, merge_commit_sha, merged_at, merged_by}`. For an unmerged pull request, `merged=false` and unavailable merge fields are `null`; consumers never receive a smaller undocumented shape.

A review identity is `{id, api_url, user, team, state, stale, official, dismissed, commit_id, submitted_at, updated_at, body, body_length, body_truncated, comments}`. `api_url` is constructed from the configured canonical base URL and repository identity, not trusted response links. `user` names the reviewer; a review requested from a team names the team in `team` and leaves `user` `null`, so a record is never left with nobody on it. `state` carries Forgejo's verdict verbatim. The values Forgejo defines today are `APPROVED`, `REQUEST_CHANGES`, `COMMENT`, `PENDING`, and `REQUEST_REVIEW`; a Forgejo release that adds another passes it through rather than discarding it, so a consumer must tolerate a value outside that list. `state` is `null` only when Forgejo reports no verdict at all, which it signals with an empty string rather than by omitting the field. `submitted_at` is `null` when Forgejo has recorded no submission time, which is how a review requesting a reviewer is reported, and `updated_at` reports the last change to the record, including a dismissal. `body` follows the same preview rules as `pr view`, and `--full` expands review and comment bodies as well as displaying every review.

A review comment identity is `{id, api_url, path, position, original_position, commit_id, original_commit_id, diff_hunk, diff_hunk_length, diff_hunk_truncated, user, resolved_by, created_at, updated_at, body, body_length, body_truncated}`. `path` names the file the comment marks. A comment on a line the change adds is anchored by `position` and `commit_id`; a comment on a line the change removes is anchored by `original_position` and `original_commit_id` instead, so a consumer locating a comment reads whichever pair is non-null. Forgejo reports an anchor it does not have as an empty string or a zero rather than by omitting the field, and both are normalized to `null` here so that a missing anchor cannot be read as line `0`. `resolved_by` is a username or `null`. `diff_hunk` is the excerpt Forgejo anchors the comment to; it observes the same preview ceiling as a body, so the capped view cannot emit an unbounded hunk and `--full` returns it whole. `diff_hunk_length` and `diff_hunk_truncated` measure it the way `body_length` and `body_truncated` measure a body — the length in Unicode code points, reported whole in both views — so a capped hunk is never mistaken for a whole one. A review reporting no inline comments is not queried for them, so `comments: []` costs no request.

Reviews are read-only. Submitting, dismissing, and deleting reviews are reachable only through `api`, so no review write path exists in the command surface.

`pr diff` returns the unified diff Forgejo generates for the pull request, so no pull ref has to be fetched. The TOON view prints the first 30 lines and `diff_info` reports the elision; `--full` and `--json` each return every line. `diff_info.lines` counts the complete diff, not the displayed excerpt. When nothing is elided the diff is emitted as Forgejo sent it, trailing newline included, so a patch saved from `--json` still applies; a truncated excerpt carries no such promise. The control-character strip above is the one exception, and it applies to a diff body like any other server-controlled text: a patch carrying `DEL` or a C1 byte in its content loses that byte. Output safety outranks byte-exactness here, because a diff is the most attacker-controllable document this CLI prints. TOON encodes the diff as one escaped scalar, as it does any multi-line text, so a consumer that wants raw patch bytes decodes the TOON value or reads `--json`.

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

`run list --status` accepts `unknown`, `waiting`, `running`, `success`, `failure`, `cancelled`, `skipped`, or `blocked`, validated before any request; `--branch` filters on the branch the run was triggered from. `run view --log` folds every job's log into its job entry and `--log-failed` folds only failed jobs' logs; the two cannot be combined. When job logs are requested but the host does not advertise the log route, the logs are omitted and `next` says so — an unsupported log is never an error and never alters the rest of the response. Capabilities are probed per route: a host that lists runs without the jobs route (Forgejo 15.0.5 does) gets `run view` with `jobs: []` and `next` saying so, while `run cancel` and `run download` report `{supported: false}` with capabilities `run_cancel` and `run_artifacts` when their routes are missing.

`run cancel` reports `cancelled=true` only when the run was still actionable beforehand; cancelling an already finished run is exit `0`, `cancelled=false`, and returns the run unchanged.

`run download` writes each artifact to `{--dir}/{name}.zip`, creating `--dir` and its parents when missing, and narrows to one artifact with `--name`. An existing file is never overwritten: the download fails with `ARTIFACT_EXISTS` (exit `1`) naming the path. An artifact name Forgejo returns that would escape the directory is refused as `INVALID_RESPONSE`. Each artifact streams to its file rather than being held in memory, and a download that fails partway removes the file it was writing. Artifacts are written one at a time, so a failure partway through leaves the artifacts already written on disk.

Capabilities are runtime-probed booleans, never version assumptions. If the Swagger document is unavailable, forbidden, rate-limited, malformed, times out, or returns a server error after the API version probe succeeds, status returns all capability booleans false with `probe.complete=false` instead of failing the entire status command. On the validated Forgejo 15.0.5 host, the runtime document advertises the Actions run list and detail routes but not the run-jobs or job-log routes; Forgejo 16 support is likewise reported independently for each advertised route. Unsupported logs never alter commit-status semantics.
