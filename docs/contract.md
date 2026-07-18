# `forgejo-axi` command contract

This document is the compatibility boundary for machine consumers. Additive object fields and new capability names are allowed; command names, field meanings, enum values, and exit semantics require a major release to change.

## Invocation and configuration

```text
forgejo-axi status [connection flags]
forgejo-axi repo view --repo OWNER/REPO [connection flags]
forgejo-axi api METHOD PATH [--data JSON] [--paginate] [connection flags]
forgejo-axi pr find --repo OWNER/REPO --head BRANCH [--base BRANCH] [--state STATE]
forgejo-axi pr list --repo OWNER/REPO [--state STATE] [--limit N|--full]
forgejo-axi pr view --repo OWNER/REPO NUMBER
forgejo-axi pr create --repo OWNER/REPO --title TITLE --head BRANCH --base BRANCH [--body BODY] [--draft]
forgejo-axi pr update --repo OWNER/REPO NUMBER [--title TITLE] [--body BODY] [--base BRANCH] [--state open|closed]
forgejo-axi pr checks --repo OWNER/REPO NUMBER
forgejo-axi pr mergeability --repo OWNER/REPO NUMBER
forgejo-axi pr merge --repo OWNER/REPO NUMBER --expected-head SHA [--method merge|squash|rebase]
forgejo-axi pr merged --repo OWNER/REPO NUMBER
```

Connection flags are `--base-url URL`, `--token-env NAME`, `--timeout-ms N`, `--ca-file PATH`, and `--json`. Environment defaults are `FORGEJO_BASE_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_TIMEOUT_MS`, and `FORGEJO_CA_FILE`. Authentication resolves `--token-env` first, then `FORGEJO_TOKEN_<HOST_KEY>`, then `FORGEJO_TOKEN` only when the base URL came from `FORGEJO_BASE_URL`; an explicitly named `--token-env` variable that is unset or empty is a usage error, and tokens are never accepted as command arguments or emitted.

`HOST_KEY` is the uppercase URL host including a non-default port, with every non-alphanumeric character replaced by `_`. HTTP authentication is accepted only for loopback hosts. Base URLs may contain a path prefix; credentials, query strings, fragments, encoded separators/dot segments, and cross-origin redirects are rejected.

## Output and exits

Default stdout is one concise TOON document. `--json` emits the same data model as one JSON document; both modes carry the same fields with the same meanings, though TOON list views stay concise by displaying a capped number of rows (reported via `page_info`) while JSON mode always displays every fetched entry. Diagnostics/progress use stderr only. Exit `0` means success or an idempotent no-op, `1` means runtime/API/security failure, and `2` means invalid invocation. Errors have this stable shape:

```json
{
  "error": "human-readable message",
  "code": "STABLE_CODE",
  "details": {},
  "help": ["complete command"]
}
```

List responses include `page_info: {complete, pages, fetched, total, displayed, truncated}`. The client fetches every API page up to its safety ceiling; if the ceiling is reached, `complete=false`. TOON lists display 30 entries by default (or `--limit N`) and report display truncation; `--full` and JSON mode display every fetched entry.

## Stable lifecycle objects

A pull request identity is `{number, url, api_url, state, draft, title, head, base, head_sha, mergeable, merged, merge_commit_sha, merged_at, merged_by}`. `url` and `api_url` are constructed from the configured canonical base URL and repository identity, not trusted response links.

Checks are `{sha, reported, state, statuses, required, required_state, passes, protection}`. `state` is `none|pending|failure|success`; an empty set is always `reported=0,state=none`. Each required pattern is `missing|pending|failure|success`; only `success` passes. `required_state` is `not_required|missing|pending|failure|success`, so missing required contexts can never be green.

Mergeability is `{number, url, head_sha, forgejo_mergeable, checks_pass, mergeable, reasons}`. `mergeable` is true only when Forgejo reports the pull mergeable and checks pass. `reasons` explains a false result with `already_merged`, `forgejo_not_mergeable`, and `checks_<state>` — the required state, or the overall state when no contexts are required.

Merge requires `--expected-head`; both the preflight and Forgejo's atomic `head_commit_id` guard are used. A successful or idempotently repeated merge returns merged-state proof `{merged, number, url, head_sha, merge_commit_sha, merged_at, merged_by}`. A head race is `HEAD_CHANGED`, never retried against the new head.

Capabilities are explicit booleans with a probe source. Forgejo 15 reports Actions job logs unsupported; Forgejo 16 may report them supported without changing commit-status/check semantics.
