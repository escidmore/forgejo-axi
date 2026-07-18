# forgejo-axi

Agent-facing, non-interactive CLI boundary for Forgejo pull request lifecycles. It emits concise [TOON](https://github.com/toon-format/spec) by default and the same stable data model as JSON with `--json`.

## Install from source

Requires Node.js 20 or newer.

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
export FORGEJO_TOKEN_FORGEJO_EXAMPLE=...
forgejo-axi status
```

Tokens are read only from environment variables: `--token-env NAME`, then `FORGEJO_TOKEN_<HOST_KEY>`, then `FORGEJO_TOKEN` only when the base URL came from `FORGEJO_BASE_URL`. Tokens are never accepted as arguments or emitted. `FORGEJO_TIMEOUT_MS` and `FORGEJO_CA_FILE` configure request timeouts and a custom CA; equivalent flags are available on every command.

## Pull request lifecycle

```console
forgejo-axi repo view --repo owner/repo
forgejo-axi pr find --repo owner/repo --head feature --base main
forgejo-axi pr create --repo owner/repo --title 'Add feature' --head feature --base main
forgejo-axi pr checks --repo owner/repo 42 --json
forgejo-axi pr mergeability --repo owner/repo 42
forgejo-axi pr merge --repo owner/repo 42 --expected-head abc123 --method squash
forgejo-axi pr merged --repo owner/repo 42
```

`pr create` and `pr update` reconcile existing state instead of duplicating mutations. `pr merge` requires the expected head SHA and sends Forgejo's atomic `head_commit_id`; repeated calls return merged-state proof. Empty statuses are `reported: 0, state: none`, not success, and missing required contexts never pass.

Lists fetch all Forgejo pages up to a documented safety ceiling and report completeness in `page_info`. TOON displays 30 items by default; `--limit`, `--full`, and `--json` control display without hiding whether fetching was complete.

## Raw API and capabilities

```console
forgejo-axi api GET 'repos/owner/repo/pulls?state=open'
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
