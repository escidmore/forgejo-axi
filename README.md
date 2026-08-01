# forgejo-axi

Agent-facing, non-interactive CLI boundary for Forgejo pull request lifecycles. It emits concise [TOON](https://github.com/toon-format/spec) by default and the same stable data model as JSON with `--json`.

## Install from source

Requires Node.js 20 or newer. Development checks also require an `openssl`
executable for the ephemeral custom-CA HTTPS test.

```console
npm ci
npm run build
npm link
```

No npm package or release is published yet.

## Configure

```console
export FORGEJO_BASE_URL=https://forgejo.example/git
export FORGEJO_REPOSITORY=owner/repo
export FORGEJO_TOKEN_FORGEJO_2E_EXAMPLE=...
forgejo-axi status
```

Tokens are read only from environment variables: `--token-env NAME`, then `FORGEJO_TOKEN_<HOST_KEY>`, then `FORGEJO_TOKEN` only when the base URL came from `FORGEJO_BASE_URL`. Host keys hex-encode punctuation (`forgejo.example` becomes `FORGEJO_2E_EXAMPLE`) to prevent look-alike hosts from sharing credentials. Tokens are never accepted as arguments or emitted. `FORGEJO_TIMEOUT_MS` configures request timeouts; `FORGEJO_CA_FILE` supplies a replacement CA trust bundle rather than extending the platform store.

## Pull request lifecycle

```console
forgejo-axi repo view --repo owner/repo
forgejo-axi pr find --repo owner/repo --head feature --base main
forgejo-axi pr list --repo owner/repo --fields number,title,state,head
forgejo-axi pr view --repo owner/repo 42 --full
forgejo-axi pr reviews --repo owner/repo 42 --full
forgejo-axi pr diff --repo owner/repo 42
forgejo-axi pr create --repo owner/repo --title 'Add feature' --head feature --base main
forgejo-axi pr checks --repo owner/repo 42 --json
forgejo-axi pr mergeability --repo owner/repo 42
forgejo-axi pr merge --repo owner/repo 42 --expected-head abc123 --method squash
forgejo-axi pr merged --repo owner/repo 42
```

`pr create` and `pr update` reconcile existing state instead of duplicating mutations. `pr merge` requires the expected head SHA and sends Forgejo's atomic `head_commit_id`; repeated calls return merged-state proof. Empty statuses are `reported: 0, state: none`, not success, and missing required contexts never pass.

`pr reviews` and `pr diff` are read-only. Reviews come back with their verdicts and the inline comments anchored to the file and position each one marks, and the diff is the one the forge generates, so no pull ref has to be fetched. Submitting, dismissing, and deleting reviews stay on the `api` path.

Lists fetch up to 100 Forgejo pages of 50 rows (5000 rows) and report completeness in `page_info`. TOON displays 30 rows by default and hints at `--full` when truncated; JSON displays every fetched row, and `--limit` is rejected with `--json`. Pull request lists use four fields by default and accept `--fields LIST|all`.

## Label taxonomy

```console
forgejo-axi label list --repo owner/repo --full
forgejo-axi label create --repo owner/repo bug --color '#d73a4a' --description 'Something is broken'
forgejo-axi label edit --repo owner/repo bug --name defect --color '#b60205'
forgejo-axi label delete --repo owner/repo wontfix
```

Labels are addressed by name; the numeric id is resolved for you. An unknown name is `LABEL_NOT_FOUND` and a duplicated name is `LABEL_AMBIGUOUS`, both usage errors that point at `label list`. `label create` reconciles an existing label of that name instead of duplicating it, and `label edit --name` renames in place so the label keeps its issue assignments.

## Issue loop

```bash
forgejo-axi issue list --repo owner/repo --label bug --state open
forgejo-axi issue view --repo owner/repo 7 --full
forgejo-axi issue create --repo owner/repo --title 'Race in scheduler' --label bug --milestone v1.0
forgejo-axi issue edit --repo owner/repo 7 --label bug,triage --assignee robot
forgejo-axi issue comment --repo owner/repo 7 --body 'Reproduced on 15.0.5'
forgejo-axi issue close --repo owner/repo 7 --comment 'Fixed in #42'
forgejo-axi issue reopen --repo owner/repo 7
```

Labels and milestones are addressed by name and resolved before anything is mutated, so an unknown name is a usage error rather than a half-applied edit or a filter Forgejo silently drops; assignee usernames go to Forgejo, which validates them. `issue list` returns issues only; `pr list` covers pull requests. `issue edit` sends only the fields that differ and reports `updated=false` when there is nothing to change. `issue close --comment` posts the comment before the state change. `issue comment` also accepts a pull request number, because Forgejo serves pull request discussion through the same endpoint.

## Raw API and capabilities

```console
forgejo-axi api GET 'repos/owner/repo/pulls?state=open'
forgejo-axi api GET repos/owner/repo/pulls --paginate --full
forgejo-axi api PATCH repos/owner/repo/pulls/42 --data '{"title":"New title"}'
```

`status` probes the runtime Swagger document rather than inferring features from the version. Forgejo 15.0.5 is supported and reports Actions job logs unavailable; Forgejo 16.x reports them only when the route is actually advertised. Unavailable logs are never treated as failed commit-status gating.

Self-hosted URLs may contain ports and path prefixes. Credentialed HTTP is restricted to loopback, redirects must remain same-origin, and credentials, query strings, fragments, encoded separators, and dot segments are rejected in base URLs.

See [`docs/contract.md`](docs/contract.md) for the machine-output compatibility contract and run `forgejo-axi --help` for the complete command surface.

## Development

```console
npm run check
npm pack --dry-run
```

Tests use local fake HTTP/HTTPS servers and versioned Forgejo 15/16 fixtures; they do not require or mutate a live Forgejo instance. [`docs/live-test-matrix.md`](docs/live-test-matrix.md) defines the separate, future opt-in 15.0.5 and 16.x lanes.
