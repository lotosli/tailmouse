# MouseCard v1

MouseCard is the bounded bearer invitation used to bootstrap one TailMouse session. It contains connection and routing data only. It never grants mode capabilities; the host grants those in `SERVER_WELCOME` after validating the card fields received in `CLIENT_HELLO`.

## URL envelope

The invitation URL is:

```text
<web-base-url>#/v1/<base64url-without-padding(canonical-CBOR(MouseCard))>
```

The complete UTF-8 URL must be fewer than 1400 bytes. The ConnBlob and MouseCard must appear only after `#`; they must never appear in a query, request target, referrer, cache key, browser storage, diagnostic, metric, or error report.

The browser must reject an empty, malformed, unsupported, or oversized fragment before unbounded decoding. It then copies only the minimum required values into memory and calls `history.replaceState` before starting transport work. Reload after that replacement requires a new invitation. This no-persistence rule is the accepted security correction to the source PRD's conflicting `sessionStorage` text.

The base64url alphabet is `A-Z`, `a-z`, `0-9`, `-`, and `_`; padding and nonzero unused trailing bits are forbidden. A raw CBOR decoder accepts at most 1050 bytes; a URL or fragment decoder also enforces its stricter envelope budget before decoding.

## Canonical CBOR map

The payload is one definite-length CBOR map with exactly eight text keys. Encoders use deterministic CBOR ordering, so the one-byte keys appear as `a`, `e`, `m`, `p`, `s`, `t`, `v`, `z` in the encoded map. No tag or self-described-CBOR prefix is used.

| Key | Meaning                    | CBOR type        | v1 constraint                                                                            |
| --- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `v` | Card version               | unsigned integer | exactly `1`                                                                              |
| `m` | Initial mode hint          | text string      | exactly `escape` or `leash`                                                              |
| `t` | Full Tailcat ConnBlob      | text string      | non-empty, self-contained, and bounded by the URL limit                                  |
| `p` | TailMouse virtual TCP port | unsigned integer | exactly `44321`                                                                          |
| `s` | Session identifier         | byte string      | exactly 16 cryptographically random bytes; all-zero is invalid                           |
| `e` | Expiration                 | unsigned integer | Unix seconds in `0..9007199254740991`; `0` means host lifetime, otherwise a future value |
| `a` | Minimum protocol           | unsigned integer | exactly `1` for Escape and exactly `2` for phase-two Leash                               |
| `z` | Maximum protocol           | unsigned integer | exactly equal to `a` for the selected mode                                               |

The card must not contain command, argv, cwd, environment, username, log, process, terminal content, relay credentials beyond the opaque ConnBlob, capability, or authorization fields.

## Decoder rules

A v1 decoder must:

1. enforce the complete URL and encoded-fragment bound before base64 or CBOR allocation;
2. reject invalid alphabet, padding, trailing base64 data, trailing CBOR data, indefinite-length items, duplicate keys, missing keys, unknown keys, tags, wrong types, non-canonical integer encodings, and non-canonical map ordering;
3. validate every value against the table above;
4. reject an expired nonzero `e` as `EXPIRED` and other card failures as `BAD_MOUSE_CARD` without returning any original payload text;
5. retain the opaque `t` value only for the bounded Tailcat dial lifetime and erase application references during teardown.

Changing `m` does not grant another mode. The host compares the HELLO session ID and mode with its authoritative session and returns `MODE_MISMATCH` on disagreement. Protocol selection is mode-specific connection metadata: Escape cards use only `a=1,z=1`, while phase-two Leash cards use only `a=2,z=2`. A decoder rejects mixed-mode identifiers, wider ranges, and old Leash identifier 1 before transport. No global `1..2` range is advertised or inferred. The shared `fixtures/v1/mousecards.json` corpus is consumed by both Go and TypeScript tests and includes exact pairs, mixed-mode pairs, wider ranges, and a recognizable access-code field that must be rejected.

## QR presentation

The terminal QR uses error correction level M, at least a 33 by 33 module symbol when the payload requires it, and a four-module quiet zone. The complete URL is deliberately exposed only by the QR and one `Open:` line. Any construction or rendering failure produces no partial invitation and maps to native exit code 3.
