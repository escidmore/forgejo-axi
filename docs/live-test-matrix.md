# Future live-test matrix

Live tests are deliberately absent from default CI. Enabling them requires captain-approved, isolated endpoints and least-privilege test repositories; tests must never target production repositories or infer an endpoint from local configuration.

| Lane             | Runtime        | Required assertions                                                                                 |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `forgejo-15-lts` | Exactly 15.0.5 | PR/status/protection/expected-head merge APIs work; `actions_job_logs=false` from the runtime probe |
| `forgejo-16`     | Approved 16.x  | The same lifecycle assertions remain unchanged; Actions job logs match the probed route             |

The eventual `forgejo-16` target is `https://forgejo.samesies.gay`, currently Forgejo 16.0.1; the `forgejo-15-lts` target is `https://forgejo-15.samesies.gay`, running exactly 15.0.5. Naming them here is not authorization to access or mutate them; every live run still requires the inputs and explicit approval below.

## Validated by the approved issue-family run

A captain-approved run against the disposable `eve/forgejo-axi-test` repository on both hosts confirmed the runtime behaviours the issue family depends on, in both directions of the version split. The capability probe reported `actions_job_logs=false` on 15.0.5 and `true` on 16.0.1, matching the lanes above. Three assumptions that fixtures cannot prove held identically on both:

- The issue comments endpoint ignores `page` and `limit`. With 55 comments seeded, `?limit=10` returned all 55 with no `Link` header and `x-total-count: 55` on both hosts. Fetching the thread in one request is correct, and routing it through the paginating helper would have been wrong.
- `PUT /issues/{index}/labels` accepts integer label ids on 15.0.5, so label replacement does not need a name-based fallback.
- `milestone: 0` clears an issue's milestone rather than erroring, on both hosts.

The `state`, `label`, `assignee`, and `milestone` filters each demonstrably narrowed the returned set — the assertion that matters, because Forgejo answers an unrecognised filter with an unfiltered list rather than an error. `issue comment` against a real pull request number landed in that pull request's discussion, with Forgejo setting `pull_request_url` on the resulting comment.

Both runs deleted every issue, pull request, branch, label, and milestone they created, and both repositories were verified empty afterwards. Note that `status` reports `authenticated: false` for a token lacking `read:user` even when that token is fully able to perform repository and issue work; the auth probe reflects one scope, not overall usability.

Each lane should receive an explicit base URL, repository, host-scoped token secret, expected CA, and expected major/minor through protected CI environment variables. The harness should create a unique branch and PR only inside a pre-provisioned disposable repository, prove an expected-head race, delete its branch when safe, redact all captured traffic, and fail before mutation if the host identity or repository allowlist differs.

Capability expectations must be checked against the runtime Swagger probe, not derived from the expected version. A missing log route is an unsupported capability and must not alter commit-status results. Keep local fixture/fake-server coverage as the required PR gate; make live lanes manually approved, non-blocking until their isolation and cleanup controls are validated, and never share tokens or repositories between the 15 and 16 lanes.
