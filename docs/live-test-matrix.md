# Live-test matrix

The live lanes are the project's primary evidence of correctness — a fixture can only prove the code agrees with itself, and the run-family schema bugs showed both layers agreeing on shapes Forgejo never sends. Running both lanes locally is required before committing any change to API requests, response handling, or fixtures. They are deliberately outside `npm run check` and never gate a merge: CI runs them only when someone dispatches the `Live lanes` workflow and approves its environment. The endpoints are user-approved, isolated, least-privilege test repositories, and tests must never target production repositories or infer an endpoint from ordinary local configuration.

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

The first run-family lane run corrected a fixture in both directions: real 15.0.5 advertises `/actions/runs` and `/actions/runs/{run_id}` — the fixtures had claimed it carried no Actions routes at all — while lacking the jobs, cancel, artifacts, and logs subroutes that 16.0.1 has. That split is why the CLI probes run capabilities per route rather than as one flag.

The `state`, `label`, `assignee`, and `milestone` filters each demonstrably narrowed the returned set — the assertion that matters, because Forgejo answers an unrecognised filter with an unfiltered list rather than an error. `issue comment` against a real pull request number landed in that pull request's discussion, with Forgejo setting `pull_request_url` on the resulting comment.

Both runs deleted every issue, pull request, branch, label, and milestone they created, and both repositories were verified empty afterwards. Note that `status` reports `authenticated: false` for a token lacking `read:user` even when that token is fully able to perform repository and issue work; the auth probe reflects one scope, not overall usability.

## Validated by the extended run

Extending the lanes to branch protection, the remaining merge methods, reconcile, and the write `api` verbs confirmed six more behaviours on both 15.0.5 and 16.0.1.

- Branch protection provisions and tears down identically on both. `POST /branch_protections` with `enable_status_check` and `status_check_contexts` answers `201`, `GET /branches/{name}` then reports `protected`, `effective_branch_protection_name`, and the context list, and the protection has to be deleted before the branch it protects or the branch survives.
- A required context that nothing has reported reads `missing` with `passes: false`, and seeding an unrelated green status does not change that: aggregate `state` goes to `success` while `required_state` stays `missing`. A missing required context cannot read as green against a real server, not just against a fixture.
- `pr merge` behind a proven expected head works with `merge` and `rebase` as well as `squash`; Forgejo produced a merge commit for each. Readiness is per method, not per pull request: a pull request reporting `mergeable: true` still answered `405 please try again later` to a `rebase`, so the lane retries a 405 rather than treating it as a verdict. Every retry carries the same expected head, so a head that moved underneath is still refused rather than merged.
- Forgejo accepts a label `PATCH` carrying only `is_archived`, and `label edit` on an archived label leaves it archived — the resend that `applyLabel` performs is load-bearing against a real server.
- Forgejo permits two labels with the same name in one repository, which is what makes `LABEL_AMBIGUOUS` reachable rather than theoretical; both ids came back in `details.ids`.
- Forgejo refuses a second pull request for the same head and base with `409`, which is the conflict `pr create` absorbs. `pr create` reconciled onto a pull request opened out of band through the raw API, returning `created: false` and that pull request's number.

That last one has a limit worth recording. Forgejo's duplicate check is a read followed by an insert with no unique constraint behind it, so three fully overlapping `pr create` invocations all passed the check and all succeeded — three pull requests on the same head and base, on both hosts. The 409 only appears once a previous create has landed. `pr create` therefore cannot recover from a conflict Forgejo never raises; the lane asserts only that every concurrent caller gets a pull request back rather than an error, and records how many rows the host actually made. The `CONFLICT` race-recovery branch itself stays fixture-covered, because reaching it live would mean landing a competing create inside the window between one invocation's pre-check and its `POST`.

## What a lane covers

Each lane runs the whole issue family; `label` create, list, edit, and delete; `repo view`; `api --paginate` across a genuine page boundary; `pr` create, list, find, view, update, checks, mergeability, merge, merged, reviews, and diff; and runner-free `run` probes. The review probe submits the one verdict Forgejo lets an author record on their own pull request — a `COMMENT` review carrying an inline comment — and then asserts the reviewer, the verdict, and the file anchor come back through `pr reviews`. On a host advertising the runs capability, `run list` must decode Forgejo's real `{workflow_runs}` envelope and have its `--status` and `--branch` filters accepted, and a missing run must map to `NOT_FOUND`; on a host without the route, the family must report itself unsupported from the probe.

Each lane also provisions a protected base branch with a required status context and takes it down again, driving that context through missing, pending, failing, and passing to prove `checks.required`, `required_state`, and `protection` against real branch protection. It merges one pull request per method, so `merge` and `rebase` are proven behind an expected head alongside `squash`. It exercises reconcile in both families — `pr create` and `label create` against an already-desired state are exit `0` and mutation-free, a differing title or colour reconciles onto the existing record, `label edit` renaming onto a name the repository carries returns `LABEL_EXISTS`, an ambiguous name returns `LABEL_AMBIGUOUS` with both ids, and editing an archived label leaves it archived. Finally it drives `api` through `POST`, `PATCH`, and `DELETE` with `--data`, including the refusal to combine `--data` with `--paginate`.

Two of those exist only because a real server behaves unlike a fake one. Pagination is walked against 55 seeded labels, so the shared helper is proven to cross a page boundary without dropping a row — worth asserting because one Forgejo endpoint is already known to ignore `page` and `limit` entirely. And Forgejo computes mergeability in the background, answering `405 please try again later` until it settles, so the lane waits for the server rather than racing it. Checks are aggregated from a commit status seeded through the statuses API, which also pins down that an empty status set reads as `none` rather than as a failure.

Not yet covered live, each needing more than a disposable repository: Actions runs with real content — job logs, cancel, and artifact download — which need a runner and a real workflow run; Actions run list, view, cancel, and download on 16, which needs the same runner and a run that produces an artifact; the `CONFLICT` race-recovery branch in `pr create`, which needs a competing create landed inside one invocation's pre-check-to-`POST` window; reviews from a second account, so the `APPROVED` and `REQUEST_CHANGES` verdicts and the stale and dismissed flags stay fixture-only; and transport behaviour — path prefixes, redirects, and CA files, which the CI workflow wires up for a host behind a private CA but which no run has yet exercised.

Of those, cancel is the one the code now routes around rather than waits on:
`run cancel` returns an already-finished run unchanged without sending the
request, so the contracted no-op holds whatever a real host would answer. This
lane would still be the only thing that could tell us what that answer is.

## Running a lane

`npm run test:live -- 15` or `npm run test:live -- 16`. It is deliberately outside `npm run check`.

Endpoints and tokens come from the environment, never from the script: `FORGEJO_BASE_URL`/`FORGEJO_TOKEN` for the 16 lane and `FORGEJO_15_BASE_URL`/`FORGEJO_15_TOKEN` for the 15 lane, so the two lanes cannot share a credential. This repository supplies them from a sops-encrypted `.env.json` loaded by mise; the file is tracked because every value in it is ciphertext.

Three independent guards run before anything is written. The harness targets `FORGEJO_LIVE_REPO` rather than the ordinary `FORGEJO_REPOSITORY`, so everyday configuration cannot arm it by accident; it refuses unless the host that actually answered reports the version its lane expects — pointing a run at the wrong host is the failure that cannot be undone; and it refuses unless the host's own response for the armed repository names that repository back, so a lane pointed at a host that does not serve it stops before writing. That last guard asks the host directly rather than reading `repo view`, whose `full_name` falls back to the name the caller supplied and whose `url` is rebuilt from the caller's own base URL — both would agree with the caller no matter what the host actually holds. Every guard exits `2` without mutating. The harness redacts the token from everything it prints, names every branch and file it creates after the run, and deletes every object it created on the way out.

## Running the lanes in CI

The `Live lanes` workflow is `workflow_dispatch` only, so it can never gate a merge, and each lane binds to a deployment environment — `forgejo-15-lts` and `forgejo-16` — whose required reviewers are what make the run manually approved. Configure both environments with required reviewers; without them the workflow starts as soon as it is dispatched.

Each environment carries its own values, which is how the lanes are kept from sharing anything: `FORGEJO_BASE_URL`, `FORGEJO_LIVE_REPO`, `FORGEJO_TOKEN`, and — when the host sits behind a private CA — `FORGEJO_CA_PEM` as secrets, with `FORGEJO_EXPECT_VERSION` as a variable. The endpoint and the repository are secrets even though neither is a credential: this repository is public, its run logs are public with it, the harness prints the host it reached, and only secrets are masked. That is what keeps the promise above — that nothing published here names a lane host — true of the logs and not just of the source. When `FORGEJO_CA_PEM` is set the workflow writes it to a file and points `--ca-file` at that file, and skips the step entirely when it is unset. Give each environment a distinct repository and a distinct host-scoped token; a shared credential or a shared repository would let one lane's failure corrupt the other's evidence. `FORGEJO_EXPECT_VERSION` is the major.minor the host must report, supplied alongside the endpoint it belongs to rather than compiled into the harness, so a lane pointed at a new host is told what that host must be.

A dispatch runs both lanes in parallel with `fail-fast: false`, so one runtime failing still produces the other's evidence, and the workflow's concurrency group queues a second dispatch behind the first rather than letting two runs mutate the same host at once.

Capability expectations must be checked against the runtime Swagger probe, not derived from the expected version. A missing log route is an unsupported capability and must not alter commit-status results. Fixture/fake-server coverage remains the automated CI gate for speed, but the live lanes are the required local gate for any API-touching change, and never share tokens or repositories between the 15 and 16 lanes.
