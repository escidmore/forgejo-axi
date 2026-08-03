# 4. Plaintext HTTP is refused for non-loopback hosts

Status: Accepted (2026-08-03)

Recorded for FJA-20, which offered two options and asked for "a decision, not
just a patch." It got neither option.

## Context

`resolveConnection` refused plaintext only when a token was configured, so the
guard protected the credential and nothing else. Anonymous `http://` access to a
non-loopback host was served normally.

An on-path attacker authors every field of a plaintext response. The fields an
agent acts on are merge proofs: `mergeable` and `checks_pass` from
`pr mergeability`, the required-context states from `pr checks`, `merged` from
`pr view`, and the `{proof}` documents from `pr merge` and `pr merged`. An agent
that reads one of these proceeds to the next step of a flow on the strength of
it. The distance between "the CLI showed me stale data" and "the CLI told me the
checks passed" is what makes this a transport decision rather than a display
one.

## Considered options

**Emit a `transport: 'insecure'` field in status and merge-proof outputs.**
Rejected. The field sits inside a document whose every other field is
attacker-authored, so it does not qualify the proof — it negates it. Compare the
annotations the contract already carries: `page_info.complete=false` and
`{supported: false}` mark an _honest_ answer that is incomplete, and the rows
that did arrive are real. Here nothing is real. A field meaning "every other
field in this document may be fabricated" is a refusal that still hands the
agent `mergeable: true` to act on, and it only works at all if the agent both
notices the field and knows to weight it.

**Refuse mutation commands over non-loopback plaintext.** Rejected as aimed at
the wrong axis. `INSECURE_AUTH` protected a secret leaving the machine; this is
about trusting an answer coming back. Same transport, different harm, so
inheriting that posture inherits the wrong distinction: an on-path attacker
needs no credential to forge a response. Two of the three forgeries FJA-20 names
— passing required checks, and `merged: true` — reach the agent through reads,
so refusing mutations alone would have left most of the stated threat reachable.

**Refuse the connection.** Accepted. Over non-loopback plaintext no command is
trustworthy, so there is no safe subset to carve out, and the axis is
trusted-transport versus not rather than read versus mutate. Dropping the
`tokenResolution.token &&` condition is also smaller than either offered option:
no new field, no schema addition, and no per-command classification of what
counts as a merge proof to keep correct as that surface grows.

## Consequences

An anonymous non-loopback plaintext invocation that used to exit `0` with data
now exits `1`. This document's own compatibility rule reserves exit-semantics
changes for a major release, and this lands at `0.1.0` before the first public
npm release — the only window in which the change is free. Tightening after a
release would not be.

The code is `INSECURE_TRANSPORT` rather than `INSECURE_AUTH`. The refusal is not
about the credential, and a code naming auth would tell an agent to drop its
token and retry anonymously, which is also refused. `INSECURE_AUTH` appeared in
no published surface — not `docs/contract.md`, `README.md`, or the skill — so
the rename retires an internal string rather than a documented enum value. It is
recorded here because three independent reviews read it as a stable-surface
change, and the answer should not have to be re-derived each time.

The refusal names its escape hatches: an `https://` base URL, adding `--ca-file`
when the host presents a private CA, or forwarding the host to loopback. There
is deliberately no `--insecure-transport` opt-in. Adding one later is additive
and non-breaking, whereas tightening later is not, so the flag waits for a
deployment that actually cannot serve TLS.

Loopback plaintext is unchanged with or without a token, so local development
and the fake-server tests are unaffected, and both live lanes already run
`https`.

Two findings from the investigation, neither of which changed the decision but
both of which would have shaped the rejected first option:

- `pr checks` is the only merge-proof output carrying no URL field. `MergedProof`,
  mergeability, and the pull identity all carry a `url` built from the canonical
  base URL, so the scheme was already visible in them. A `transport` marker would
  have been most needed exactly where the scheme is invisible and nearly
  redundant where it is not.
- Mid-flight scheme downgrade was already closed. The redirect guard compares
  `target.origin !== url.origin`, and `URL.origin` includes the protocol, so an
  `https` → `http` redirect already fails `CROSS_ORIGIN_REDIRECT`. The gap was
  only ever the initially configured base URL.
