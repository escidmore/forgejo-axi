# The TOON encoder is pinned at 4.x

TOON is `forgejo-axi`'s default output format — `--json` is opt-in — so for most
invocations the encoder is the output contract. Its only consumer is `render` in
`src/cli.ts`. The suite asserted parsed structure through `parseJson` and never
encoded bytes, so a change in how the encoder writes a document altered what
every agent reads and no test failed.

That is what happened. PR #15 moved `@toon-format/toon` from 2.1.0 to 4.1.0 and
merged as `dfdf938` on the claim that "breaking changes are decode-side; this
repo only uses `encode`". That claim was incorrect: encode-side output changed
in four ways, measured below. This record is Accepted rather than proposed: the
bump has shipped, and 4.x's output is the contract.

## Evidence

Both majors were installed side by side outside the repo and `encode` compared
byte-for-byte across the six document shapes this codebase produces, the
zero-result and `#`-scalar cases, and a 4000-structure seeded fuzz. Every
observed difference reduces to one of four rules.

| rule                                  | 2.1.0        | 4.1.0                      | reaches output                                                                |
| ------------------------------------- | ------------ | -------------------------- | ----------------------------------------------------------------------------- |
| C0 control characters (`0x00`–`0x1f`) | raw byte     | escaped `\uXXXX`           | any server-controlled string                                                  |
| empty array framing                   | `labels[0]:` | `labels: []`               | every zero-result document, and `help` on every error carrying no suggestions |
| `#`-prefixed scalar quoting           | `#d73a4a`    | `"#d73a4a"`                | every label color, and any title beginning with `#`                           |
| object-valued row folding             | `- a:` block | tabular header and CSV row | nothing today; latent                                                         |

`DEL` (`0x7f`) and the C1 range (`0x80`–`0x9f`) are emitted raw by both majors.

The three live rules are improvements. Escaping C0 closes the terminal-escape
half of FJA-17: a server-controlled string can no longer carry a control
sequence into a reading agent's stdout. `labels: []` is the notation
`docs/contract.md` already used for zero-result responses, so TOON moved toward
the documented shape rather than away from it.

Quoting a leading `#` is what keeps the output decodable under 4.x, which also
added full-line `#` comment stripping on decode. Measured: 4.1.0's decoder eats
a tabular row whose first column begins with `#` and then fails on the row
count, so the unquoted form `labels[1]{color,name}:` followed by `  #d73a4a,bug`
throws. 2.1.0 neither quoted nor stripped, so its own output round-tripped. Each
major is internally consistent and the pair is incompatible for that shape. A
`#` in a key-value position such as `title: #123 x` is not a comment in either.

The fourth rule reaches no documented shape, since every list row in the
contract holds scalars or arrays; it goes live the first time a row gains an
object-valued field.

## Considered options

Reverting to 2.x. Rejected because it returns the C0 escaping that output safety
now rests on, in exchange for two behaviors that were worse.

Stripping the added quotes from `#` scalars in `render`. Rejected for the reason
the quotes exist: it would reintroduce output that a 4.x decoder cannot read
back once the value lands in the first column of a tabular row.

## Consequences

The 4.x escaping is load-bearing for output safety, so a golden test in
`test/cli.test.ts` pins the encoded bytes rather than leaving them to the next
`npm update`. `docs/contract.md` states the three live rules, so the
compatibility authority describes the encoded form and not only the parsed one.
The residual — raw `DEL` and C1 — is tracked in FJA-17.
