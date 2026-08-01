# Security policy

## Supported versions

The most recent 1.x release receives security fixes. Older versions do not.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/escidmore/forgejo-axi/security/advisories/new).
Please do not open a public issue for a security problem.

Include the affected version, the Forgejo version you were talking to, and the
smallest reproduction you have. If a report involves a real host, redact its
name and any token before sending.

## Scope

This CLI holds Forgejo API credentials and talks to self-hosted forges, so the
protections most worth reporting against are:

- **Token disclosure.** Tokens are read only from environment variables and are
  never accepted as arguments or emitted in output, including in errors and
  diagnostics. A path that prints or logs a token is a vulnerability.
- **Token scope crossing.** Host keys hex-encode punctuation so that
  `forgejo.example` resolves to `FORGEJO_TOKEN_FORGEJO_2E_EXAMPLE` and cannot
  collide with a look-alike host. A case where one host's token reaches another
  host is a vulnerability.
- **Base URL and redirect handling.** Credentials, query strings, fragments,
  encoded separators, and dot segments are rejected in base URLs. Credentialed
  plain HTTP is restricted to loopback. Redirects are followed only when they
  stay same-origin. A bypass of any of these is a vulnerability.
- **Merge safety.** `pr merge` sends Forgejo's atomic `head_commit_id` so a
  merge cannot land on a head the caller did not verify. A path that merges
  without that guarantee is a vulnerability.

Reports that a command reads `FORGEJO_TOKEN` from the environment, or that a
token appears in your own shell history, describe intended behavior rather than
a vulnerability.
