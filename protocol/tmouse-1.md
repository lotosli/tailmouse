# TMOUSE/1 wire protocol

TMOUSE/1 runs on one reliable, ordered Tailcat virtual TCP stream at port 44321. Tailcat supplies encryption, retransmission, and ordering. TMOUSE/1 adds none of those facilities and does not multiplex another stream.

All byte counts below are exact. Multi-byte integers are unsigned big-endian. Text is UTF-8. Unless a type defines another limit, the declared frame length is at most 1,048,576 bytes.

## Frame envelope

```text
offset  size  field
0       4     length: u32, excludes these 4 bytes
4       1     type: u8
5       1     flags: u8
6       ...   payload
```

`length` includes type, flags, and payload. It must be between 2 and 1,048,576 inclusive. A decoder validates the four-byte length before allocating the remainder. EOF after any part of a frame is rejected as `BAD_FRAME`; no partial payload is dispatched. The local decoder distinguishes transport truncation from invalid complete input without adding a wire field or error code. Before successful admission, the strict handshake or authentication rejection remains. On an established connection only, EOF or transport read failure within an otherwise not-yet-invalid header, envelope or payload is connection loss: discard partial bytes and connection-local input, close the stream and release its lease under the mode's disconnect policy. The browser may offer an explicit user-initiated fresh-stream handshake using its memory-only invitation and, for protected Leash, its memory-only access code. It must not automatically retry, resume a frame, reuse an authentication proof or replay old input. Complete malformed input, already detected framing/size/direction/state/capability violations and terminal peer ERROR frames remain terminal; peer error text or retry hints cannot select this local recovery path. In TMOUSE/1, flags must be zero. Unknown types, nonzero flags, illegal directions, and messages illegal in the current state are `BAD_FRAME` unless the registry names a more specific error.

For `TERM_INPUT` and `TERM_OUTPUT`, `length` is at most 32,768 bytes, so the raw payload is at most 32,766 bytes. Senders split larger terminal byte sequences into ordered frames. Empty terminal payloads are invalid.

Control JSON payloads are at most 16,384 bytes and must decode to one object with value nesting depth at most 32, counting the root as depth 1. Encoders emit compact UTF-8 JSON with the field order shown in this document. Decoders reject a BOM, invalid UTF-8, duplicate names, unknown names, wrong JSON types, non-integer integer fields, out-of-range values, and trailing non-whitespace data. Integer fields must evaluate to a safe integer; integral decimal or exponent spellings are accepted. Whitespace around or inside an otherwise valid object is accepted. Unknown fields require a later protocol version; v1 never treats them as silently granted capability.

## Version compatibility

Wire identifier `2` denotes TMOUSE/1.1, the retained legacy terminal protocol. MouseCard, HELLO and WELCOME select exactly `2..2`.

### Fail-closed Leash compatibility

Identifier-1 Leash peers fail closed before authentication, terminal disclosure or child startup. There is no downgrade. The removed game's mode and message types are unsupported; former game IDs are not reused. Resource sharing has its own TMOUSE/2 envelope documented in `docs/resource-sharing.md`.

## Connection states

Each new Tailcat stream starts in `await-client-hello` on the host and `await-server-response` in the browser.

```text
identifier 2 protected host: await-client-hello -> await-auth-proof -> active-leash -> closing -> closed
identifier 2 link-only host: await-client-hello -> active-leash -> closing -> closed

identifier 2 protected browser: await-server-response -> await-auth-input -> await-auth-result -> active-leash -> closing -> closed
identifier 2 link-only browser: await-server-response -> active-leash -> closing -> closed
```

The browser's first frame must be `CLIENT_HELLO`. An identifier-2 protected Leash Host replies with one `AUTH_CHALLENGE`, then accepts exactly one `AUTH_PROOF` before replying with `SERVER_WELCOME` or `ERROR`. An identifier-2 link-only Host sends no authentication frame and replies with `SERVER_WELCOME` or `ERROR`. No mode message, task metadata, capability or active-slot ownership is legal before WELCOME. A replacement uses a new Tailcat stream and repeats the complete handshake and authentication; it never resumes a partial frame or connection-local queue.

`CLOSE` moves the sender to `closing`; it sends no later application frame. The receiver may finish one already accepted write, may reply with `CLOSE`, and then closes the stream. Transport EOF without `CLOSE` follows the mode's connection-loss policy rather than inventing a protocol result. Phase-two Leash releases connection-local work and returns the live Host share to listening without starting a browser-absence deadline.

## Message registry

|   Type | Name              | Direction       | Encoding | Payload limit | Legal state                                               |
| -----: | ----------------- | --------------- | -------- | ------------: | --------------------------------------------------------- |
| `0x01` | `CLIENT_HELLO`    | Browser to host | JSON     |          4096 | first frame only                                          |
| `0x02` | `SERVER_WELCOME`  | Host to browser | JSON     |          4096 | admitted response to HELLO or valid proof                 |
| `0x03` | `ERROR`           | Either          | JSON     |          1024 | Host rejection before admission; either peer while active |
| `0x04` | `PING`            | Either          | binary   |            16 | active                                                    |
| `0x05` | `PONG`            | Either          | binary   |            16 | active                                                    |
| `0x06` | `CLOSE`           | Either          | JSON     |           512 | active or closing                                         |
| `0x07` | `AUTH_CHALLENGE`  | Host to browser | JSON     |           512 | identifier 2 protected Leash after valid HELLO            |
| `0x08` | `AUTH_PROOF`      | Browser to host | JSON     |           512 | identifier 2 protected Leash once in `await-auth-proof`   |
| `0x10` | `TERM_RESET`      | Host to browser | JSON     |          1024 | active-leash                                              |
| `0x11` | `TERM_OUTPUT`     | Host to browser | bytes    |        32,766 | active-leash                                              |
| `0x12` | `TERM_INPUT`      | Browser to host | bytes    |        32,766 | active-leash with `terminal_input`                        |
| `0x13` | `TERM_RESIZE`     | Browser to host | binary   |             4 | active-leash with `resize`                                |
| `0x14` | `PROCESS_CONTROL` | Browser to host | JSON     |           512 | active-leash with the matching capability                 |
| `0x15` | `PROCESS_STATE`   | Host to browser | JSON     |          1024 | active-leash                                              |
| `0x16` | `OUTPUT_DROPPED`  | Host to browser | JSON     |           512 | active-leash                                              |

An exact-size binary payload with any other size is `BAD_FRAME`. Receiving a retired game message type is `BAD_FRAME`. Missing host capability is `UNAUTHORIZED_CAPABILITY`, or the more specific `READONLY`, `RESTART_DISABLED`, or `TERMINATE_DISABLED` where applicable.

## Handshake JSON

`CLIENT_HELLO` has this exact shape; `terminal` may be omitted until the browser has measured its viewport. The Leash form selects identifier 2.

```json
{
  "protocol_min": 2,
  "protocol_max": 2,
  "session_id": "000102030405060708090a0b0c0d0e0f",
  "mode": "leash",
  "client": {
    "name": "tailmouse-web",
    "version": "0.1.0",
    "platform": "ios",
    "user_agent": "synthetic-test-agent"
  },
  "terminal": { "cols": 80, "rows": 24 }
}
```

- `protocol_min` and `protocol_max` are integers from 1 through 65535 and minimum must not exceed maximum.
- `session_id` is exactly 32 lowercase hexadecimal characters representing the 16 MouseCard bytes.
- `mode` is `leash` and must match host state.
- Client `name`, `version`, and `platform` are non-empty and at most 64, 32, and 32 UTF-8 bytes respectively. `user_agent` is at most 512 UTF-8 bytes and may be empty. None is an authority input.
- Terminal `cols` is 20 through 500 and `rows` is 5 through 200.

The Host accepts only the exact identifier defined for the selected mode. A valid Leash HELLO performs only preliminary session, mode and protocol validation: it does not acquire the active slot, disclose task state or trigger browser-mediated startup.

### Identifier-2 access authentication

A protected Leash Host creates a fresh 32-byte cryptographically random challenge for each valid HELLO. `AUTH_CHALLENGE` is the exact compact JSON object below. `challenge` is canonical unpadded base64url whose decoded value is exactly 32 bytes.

```json
{
  "scheme": "hmac-sha256-v1",
  "challenge": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
}
```

The browser accepts access-code input case-insensitively, removes only ASCII space and hyphen separators, uppercases the result and requires exactly 16 symbols from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`. It derives:

```text
key = SHA-256(UTF-8("tailmouse-access-key-v1\0" + canonical_code))
message = UTF-8("tailmouse-access-proof-v1\0") || session_id_bytes || challenge_bytes
proof = HMAC-SHA-256(key, message)
```

`session_id_bytes` is the exact 16-byte MouseCard session identifier. For the synthetic code `2345-6789-ABCD-EFGH`, the session ID and challenge shown above, `AUTH_PROOF` is the exact compact JSON object below. `proof` is canonical unpadded base64url whose decoded value is exactly 32 bytes.

```json
{
  "scheme": "hmac-sha256-v1",
  "proof": "V0OMGOWhH9n8r-cwHjkH06dDCyNQrZQgrlxJXDmzl4s"
}
```

The Host compares all 32 proof bytes without data-dependent early exit and consumes a challenge on the first proof attempt. A challenge and proof are valid only on their issuing stream. Wrong-length, malformed, unknown-field, unknown-scheme, duplicate, replayed, cross-stream or cross-session authentication data fails closed. The access code itself is never transmitted.

Each stream has a 30-second authentication deadline and may deliver at most 4096 bytes before admission. One share permits at most four concurrent unauthenticated streams. Ten failed proofs across that share start one non-extending 30-second cooldown; further attempts receive `AUTH_THROTTLED` with the current remaining duration. Cooldown rejection does not extend the deadline. Cooldown completion or a valid proof resets the failure count. Every rejection releases its connection state without ending the share, stopping the task or changing an active browser.

A protected Host attempts active-slot acquisition only after a valid proof. If another admitted stream owns the slot, the new stream receives `SESSION_BUSY` and no task data. A Host launched explicitly in link-only mode creates no code or challenge and attempts slot acquisition immediately after a valid identifier-2 HELLO. Browser input, invitation fields, missing old-peer support and authentication failure cannot select link-only mode.

Identifier-2 `SERVER_WELCOME` has this exact shape:

```json
{
  "protocol": 2,
  "mode": "leash",
  "session_state": "active",
  "expires_at": 0,
  "relay": {
    "mode": "official",
    "host": "tc302a.ipn.dev",
    "browser_path": "derp"
  },
  "capabilities": [
    "interrupt",
    "resize",
    "restart",
    "terminal_input",
    "terminal_output",
    "terminate"
  ],
  "access_mode": "code"
}
```

- `protocol` is the mode's selected identifier and `mode` is authoritative. Identifier 2 requires `access_mode`.
- `session_state` is `active` for a newly accepted stream.
- `expires_at` is safe-integer Unix seconds from 0 through 9,007,199,254,740,991; zero means host lifetime.
- Relay `mode` is `official`, `custom-host`, or `custom-map`; `host` is a validated diagnostic hostname of at most 253 ASCII bytes; browser path is exactly `derp` in v1.
- Capabilities are unique strings in lexicographic order. Leash may grant `interrupt`, `resize`, `restart`, `terminal_input`, `terminal_output`, and `terminate`. The Host checks the applicable capability again before every side effect.
- Identifier-2 `access_mode` is exactly `code` for a successfully authenticated protected share or `link` for an explicit link-only share. It is Host-authoritative and appears only after admission.

## Common binary payloads

`PING` and `PONG` are exactly 16 bytes:

```text
offset  size  field
0       8     sequence: u64
8       8     sender_monotonic_ns: u64
```

`PONG` echoes both fields unchanged. Only a PONG matching an outstanding PING contributes a sample. RTT EWMA uses alpha 0.2; jitter EWMA uses alpha 0.2 over the absolute difference between consecutive RTT samples; p50 and p95 use only the latest 60 valid RTT samples. Neither peer derives one-way latency.

`TERM_RESIZE` is exactly four bytes:

```text
offset  size  field
0       2     columns: u16, 20..500
2       2     rows: u16, 5..200
```

Invalid sizes have no PTY effect.

## Mode JSON payloads

`TERM_RESET` is `{"generation":1,"cols":80,"rows":24}`. Generation is 1 through 4,294,967,295 and dimensions use the resize bounds. It precedes one consistent scrollback snapshot and live output on every accepted or replacement leash stream.

The first reset initializes a fresh connection without an additional handshake. Every later reset clears pending browser input and rearms synchronization until the new process state and an ordered PONG sent after that state. Starting and running can each replace the snapshot in the same generation; a PONG preceding the second reset does not authorize its input. This uses the existing heartbeat, not a new message or generation increment.

`PROCESS_CONTROL` is `{"action":"interrupt","generation":1}`. Action is `interrupt`, `restart`, or `terminate`; generation must match the current process generation. It contains no argv, cwd, environment, or other command data.

`PROCESS_STATE` has the following required field set and may additionally contain `title`:

```json
{
  "generation": 1,
  "state": "running",
  "pid": 48271,
  "started_at": 1788238400,
  "exit_code": null,
  "signal": null
}
```

State is `waiting`, `starting`, `running`, `interrupting`, `terminating`, `exited`, `restarting`, `failed`, or `closing`. PID is a positive safe integer only while known, otherwise null. `started_at` is non-negative Unix seconds or null. Exit code is an integer from 0 through 4,294,967,295 or null, preserving the full native Windows result as well as Unix statuses. Negative, fractional and larger values are `BAD_FRAME`; no truncation or signed reinterpretation occurs. Signal is a platform-neutral name matching `[A-Z0-9_]{1,32}` or null.

Optional `title` is a nonempty display string of at most 256 UTF-8 bytes after JSON decoding, with no U+0000-U+001F or U+007F-U+009F characters. It is the immutable command basename or explicit host title, never argv, cwd or environment. JSON's unmatched UTF-16 surrogate escapes normalize to U+FFFD before display and byte counting. A missing title renders the neutral Terminal label; null, wrong types, empty/oversized/control-containing titles and all other unknown fields are `BAD_FRAME`. The entire payload remains bounded to 1024 bytes. This completes the unreleased v1 payload without changing framing, message IDs or capabilities; existing title-less payloads remain valid.

`OUTPUT_DROPPED` is `{"generation":1,"dropped_bytes":290816}`. The count is a non-negative safe integer and is cumulative for that process generation.

## Common control JSON

`ERROR` is:

```json
{
  "code": "SESSION_BUSY",
  "message": "Another browser is controlling this session.",
  "retryable": true
}
```

The code must be from the stable error table below. Message is non-empty, at most 256 UTF-8 bytes, and must contain no credential, URL, token, access code, derived key, challenge, proof, terminal bytes, browser input, command environment, or upstream error. Retryable means only that a user-initiated bounded retry can be meaningful; it never authorizes automatic retry or a side effect. Every code except `AUTH_THROTTLED` has exactly these three fields. `AUTH_THROTTLED` additionally requires `retry_after_ms`, an integer from 1 through 30000 containing the current non-extending cooldown remainder; other codes reject that field.

`CLOSE` is `{"reason":"mode_complete","message":"Session closed."}`. Reason is `normal`, `mode_complete`, `local_revoke`, `expired`, `protocol_error`, or `transport_error`. Message follows the same redaction and 256-byte limit as ERROR.

## Stable errors

| Code                      | Default safe meaning                                 | Retryable |
| ------------------------- | ---------------------------------------------------- | --------- |
| `BAD_MOUSE_CARD`          | Invitation is invalid or unsupported.                | false     |
| `EXPIRED`                 | Session has expired.                                 | false     |
| `MODE_MISMATCH`           | Invitation mode does not match the host session.     | false     |
| `PROTOCOL_MISMATCH`       | No supported protocol version overlaps.              | false     |
| `SESSION_BUSY`            | Another browser is controlling this session.         | true      |
| `AUTH_REQUIRED`           | Access authentication is required.                   | false     |
| `AUTH_FAILED`             | Access authentication failed.                        | true      |
| `AUTH_THROTTLED`          | Access attempts are temporarily limited.             | true      |
| `UNAUTHORIZED_CAPABILITY` | This session does not grant that action.             | false     |
| `FRAME_TOO_LARGE`         | Frame exceeds the supported limit.                   | false     |
| `BAD_FRAME`               | Frame is malformed or invalid in this state.         | false     |
| `PROCESS_NOT_RUNNING`     | No process is available for that action.             | true      |
| `RESTART_DISABLED`        | Restart is disabled for this session.                | false     |
| `TERMINATE_DISABLED`      | Terminate is disabled for this session.              | false     |
| `READONLY`                | Browser control is disabled for this session.        | false     |
| `BACKPRESSURE`            | Input is paused until bounded capacity is available. | true      |
| `INTERNAL`                | Session failed safely.                               | false     |

When safe, `FRAME_TOO_LARGE` is sent after reading only the declared length and before allocating its body. Other malformed input maps to `BAD_FRAME`. After either code, the receiver accepts no further application message and closes the stream. Internal and transport errors are classified at their boundary; their original text never enters a protocol frame.
