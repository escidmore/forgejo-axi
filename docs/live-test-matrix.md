# Live-test matrix

The live lanes are the project's primary evidence of correctness — a fixture can only prove the code agrees with itself, and the run-family schema bugs showed both layers agreeing on shapes Forgejo never sends. Running both lanes locally is required before committing any change to API requests, response handling, or fixtures. They stay out of automated CI only because CI lacks the hosts; the endpoints are user-approved, isolated, least-privilege test repositories, and tests must never target production repositories or infer an endpoint from ordinary local configuration.

| Lane             | Runtime  | Required assertions                                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `forgejo-15-lts` | `15.0.x` | PR/status/protection/expected-head merge APIs work; `actions_job_logs=false` from the runtime probe |
| `forgejo-16`     | `16.0.x` | The same lifecycle assertions remain unchanged; Actions job logs match the probed route             |

Neither lane's host is named in this repository. Each is supplied at run time through the environment — `FORGEJO_BASE_URL` for `forgejo-16` and `FORGEJO_15_BASE_URL` for `forgejo-15-lts` — so a published document never discloses internal infrastructure. A lane is identified here only by the version it requires, and the harness confirms that version against the host that actually answers.

## Validated by the approved issue-family run

A captain-approved run against a disposable test repository on both lane hosts confirmed the runtime behaviours the issue family depends on, in both directions of the version split. The capability probe reported `actions_job_logs=false` on 15.0.5 and `true` on 16.0.1, matching the lanes above. Three assumptions that fixtures cannot prove held identically on both:

- The issue comments endpoint ignores `page` and `limit`. With 55 comments seeded, `?limit=10` returned all 55 with no `Link` header and `x-total-count: 55` on both hosts. Fetching the thread in one request is correct, and routing it through the paginating helper would have been wrong.
- `PUT /issues/{index}/labels` accepts integer label ids on 15.0.5, so label replacement does not need a name-based fallback.
- `milestone: 0` clears an issue's milestone rather than erroring, on both hosts.

`pr merge --expected-head` with a stale head was refused with `HEAD_CHANGED` on both hosts, and the pull request was still unmerged afterwards — the race guard proven against real servers rather than a fake one.

The `state`, `label`, `assignee`, and `milestone` filters each demonstrably narrowed the returned set — the assertion that matters, because Forgejo answers an unrecognised filter with an unfiltered list rather than an error. `issue comment` against a real pull request number landed in that pull request's discussion, with Forgejo setting `pull_request_url` on the resulting comment.

Both runs deleted every issue, pull request, branch, label, and milestone they created, and both repositories were verified empty afterwards. Note that `status` reports `authenticated: false` for a token lacking `read:user` even when that token is fully able to perform repository and issue work; the auth probe reflects one scope, not overall usability.

## What a lane covers

Each lane runs the whole issue family; `label` create, list, edit, and delete; `repo view`; `api --paginate` across a genuine page boundary; `pr` create, list, find, view, update, checks, mergeability, merge, and merged; and runner-free `run` probes. On a host advertising the runs capability, `run list` must decode Forgejo's real `{workflow_runs}` envelope and have its `--status` and `--branch` filters accepted, and a missing run must map to `NOT_FOUND`; on a host without the route, the family must report itself unsupported from the probe.

Two of those exist only because a real server behaves unlike a fake one. Pagination is walked against 55 seeded labels, so the shared helper is proven to cross a page boundary without dropping a row — worth asserting because one Forgejo endpoint is already known to ignore `page` and `limit` entirely. And Forgejo computes mergeability in the background, answering `405 please try again later` until it settles, so the lane waits for the server rather than racing it. Checks are aggregated from a commit status seeded through the statuses API, which also pins down that an empty status set reads as `none` rather than as a failure.

Not yet covered live, each needing more than a disposable repository: branch protection and required status contexts; Actions runs with real content — job logs, cancel, and artifact download — which need a runner and a real workflow run; Actions run list, view, cancel, and download on 16, which needs the same runner and a run that produces an artifact; the `rebase` and `merge` methods, since only `squash` is exercised; the reconcile and race-recovery paths in `pr create` and `label create`; non-`GET` `api` verbs; and transport behaviour — CA files, path prefixes, and redirects. Wiring the lanes into CI as manually-approved, non-blocking jobs is also outstanding.

## Running a lane

`npm run test:live -- 15` or `npm run test:live -- 16`. It is deliberately outside `npm run check`.

Endpoints and tokens come from the environment, never from the script: `FORGEJO_BASE_URL`/`FORGEJO_TOKEN` for the 16 lane and `FORGEJO_15_BASE_URL`/`FORGEJO_15_TOKEN` for the 15 lane, so the two lanes cannot share a credential. This repository supplies them from a sops-encrypted `.env.json` loaded by mise; the file is tracked because every value in it is ciphertext.

Two independent guards run before anything is written. The harness targets `FORGEJO_LIVE_REPO` rather than the ordinary `FORGEJO_REPOSITORY`, so everyday configuration cannot arm it by accident, and it refuses unless the host that actually answered reports the version its lane expects — pointing a run at the wrong host is the failure that cannot be undone. Both guards exit `2` without mutating. The harness redacts the token from everything it prints, creates a uniquely named branch, and deletes every object it created on the way out.

Each lane should receive an explicit base URL, repository, host-scoped token secret, expected CA, and expected major/minor through protected CI environment variables. The harness should create a unique branch and PR only inside a pre-provisioned disposable repository, prove an expected-head race, delete its branch when safe, redact all captured traffic, and fail before mutation if the host identity or repository allowlist differs.

Capability expectations must be checked against the runtime Swagger probe, not derived from the expected version. A missing log route is an unsupported capability and must not alter commit-status results. Fixture/fake-server coverage remains the automated CI gate for speed, but the live lanes are the required local gate for any API-touching change, and never share tokens or repositories between the 15 and 16 lanes.
