# Future live-test matrix

Live tests are deliberately absent from default CI. Enabling them requires captain-approved, isolated endpoints and least-privilege test repositories; tests must never target production repositories or infer an endpoint from local configuration.

| Lane             | Runtime        | Required assertions                                                                                 |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `forgejo-15-lts` | Exactly 15.0.5 | PR/status/protection/expected-head merge APIs work; `actions_job_logs=false` from the runtime probe |
| `forgejo-16`     | Approved 16.x  | The same lifecycle assertions remain unchanged; Actions job logs match the probed route             |

The eventual `forgejo-16` target is `https://forgejo.samesies.gay`, currently Forgejo 16.0.0. Naming it here is not authorization to access or mutate it; every live run still requires the inputs and explicit approval below.

Each lane should receive an explicit base URL, repository, host-scoped token secret, expected CA, and expected major/minor through protected CI environment variables. The harness should create a unique branch and PR only inside a pre-provisioned disposable repository, prove an expected-head race, delete its branch when safe, redact all captured traffic, and fail before mutation if the host identity or repository allowlist differs.

Capability expectations must be checked against the runtime Swagger probe, not derived from the expected version. A missing log route is an unsupported capability and must not alter commit-status results. Keep local fixture/fake-server coverage as the required PR gate; make live lanes manually approved, non-blocking until their isolation and cleanup controls are validated, and never share tokens or repositories between the 15 and 16 lanes.
