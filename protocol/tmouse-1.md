# TMOUSE/1 wire protocol

TMOUSE/1 runs on one reliable, ordered Tailcat virtual TCP stream at port 44321. Tailcat supplies encryption, retransmission, and ordering. TMOUSE/1 adds none of those facilities and does not multiplex another stream.

All byte counts below are exact. Multi-byte integers are unsigned big-endian. `f32` is IEEE 754 binary32 in big-endian byte order; NaN and infinities are invalid. Text is UTF-8. Unless a type defines another limit, the declared frame length is at most 1,048,576 bytes.

## Frame envelope

```text
offset  size  field
0       4     length: u32, excludes these 4 bytes
4       1     type: u8
5       1     flags: u8
6       ...   payload
```

`length` includes type, flags, and payload. It must be between 2 and 1,048,576 inclusive. A decoder validates the four-byte length before allocating the remainder. EOF after any part of a frame is rejected as `BAD_FRAME`; no partial payload is dispatched. The local decoder distinguishes transport truncation from invalid complete input without adding a wire field or error code. Before successful HELLO/WELCOME, the existing strict handshake rejection remains. On an established connection only, EOF or transport read failure within an otherwise not-yet-invalid header, envelope or payload is connection loss: discard partial bytes and connection-local input, close the stream and release its lease under the existing disconnect policy. The browser may offer an explicit user-initiated fresh-stream handshake using its memory-only invitation, within unchanged TTL, grace and capabilities. It must not automatically retry, resume a frame or replay old input. Complete malformed input, already detected framing/size/direction/state/capability violations and terminal peer ERROR frames remain terminal; peer error text or retry hints cannot select this local recovery path. In v1, flags must be zero. Unknown types, nonzero flags, illegal directions, and messages illegal in the current state are `BAD_FRAME` unless the registry names a more specific error.

For `TERM_INPUT` and `TERM_OUTPUT`, `length` is at most 32,768 bytes, so the raw payload is at most 32,766 bytes. Senders split larger terminal byte sequences into ordered frames. Empty terminal payloads are invalid.

Control JSON payloads are at most 16,384 bytes and must decode to one object with value nesting depth at most 32, counting the root as depth 1. Encoders emit compact UTF-8 JSON with the field order shown in this document. Decoders reject a BOM, invalid UTF-8, duplicate names, unknown names, wrong JSON types, non-integer integer fields, out-of-range values, and trailing non-whitespace data. Integer fields must evaluate to a safe integer; integral decimal or exponent spellings are accepted. Whitespace around or inside an otherwise valid object is accepted. Unknown fields require a later protocol version; v1 never treats them as silently granted capability.

## Version compatibility

Wire identifier `1` denotes the initial TMOUSE/1.0 contract. `protocol_min`, `protocol_max` and WELCOME `protocol` use bounded numeric wire identifiers, not application build versions. The current implementation and artifact metadata support only `1..1`. A wider compatible MouseCard range permits negotiation but never changes the client's implemented range or this contract's strict field/type rules.

For a later published same-major minor, assign and document its wire identifier together with exact negotiation and cross-version fixtures. Browser releases support the latest two available same-major minors; the initial candidate has only one and does not fabricate a preceding codec. Backward compatibility is achieved by negotiating an implemented common contract, not by ignoring unknown mandatory fields or treating any higher identifier as automatically supported. Breaking changes require a distinct version and explicit migration/rejection evidence. No additional minor is defined or reserved by this initial contract.

## Connection states

Each new Tailcat stream starts in `await-client-hello` on the host and `await-server-welcome` in the browser.

```text
await-client-hello -> active-escape | active-leash -> closing -> closed
await-server-welcome -> active-escape | active-leash -> closing -> closed
```

The browser's first frame must be `CLIENT_HELLO`. The host replies with exactly one `SERVER_WELCOME` or one `ERROR` and then closes on rejection. No mode message is legal before `SERVER_WELCOME`. Reconnect uses a new Tailcat stream and repeats the complete handshake; it never resumes a partial frame or connection-local queue.

`CLOSE` moves the sender to `closing`; it sends no later application frame. The receiver may finish one already accepted write, may reply with `CLOSE`, and then closes the stream. Transport EOF without `CLOSE` enters host reconnect-grace policy rather than inventing a protocol result.

## Message registry

|   Type | Name              | Direction       | Encoding | Payload limit | Legal state                                               |
| -----: | ----------------- | --------------- | -------- | ------------: | --------------------------------------------------------- |
| `0x01` | `CLIENT_HELLO`    | Browser to host | JSON     |          4096 | first frame only                                          |
| `0x02` | `SERVER_WELCOME`  | Host to browser | JSON     |          4096 | response to valid HELLO only                              |
| `0x03` | `ERROR`           | Either          | JSON     |          1024 | host rejection during handshake; either peer while active |
| `0x04` | `PING`            | Either          | binary   |            16 | active                                                    |
| `0x05` | `PONG`            | Either          | binary   |            16 | active                                                    |
| `0x06` | `CLOSE`           | Either          | JSON     |           512 | active or closing                                         |
| `0x10` | `TERM_RESET`      | Host to browser | JSON     |          1024 | active-leash                                              |
| `0x11` | `TERM_OUTPUT`     | Host to browser | bytes    |        32,766 | active-leash                                              |
| `0x12` | `TERM_INPUT`      | Browser to host | bytes    |        32,766 | active-leash with `terminal_input`                        |
| `0x13` | `TERM_RESIZE`     | Browser to host | binary   |             4 | active-leash with `resize`                                |
| `0x14` | `PROCESS_CONTROL` | Browser to host | JSON     |           512 | active-leash with the matching capability                 |
| `0x15` | `PROCESS_STATE`   | Host to browser | JSON     |          1024 | active-leash                                              |
| `0x16` | `OUTPUT_DROPPED`  | Host to browser | JSON     |           512 | active-leash                                              |
| `0x20` | `GAME_INIT`       | Host to browser | JSON     |        16,384 | first mode frame in active-escape                         |
| `0x21` | `GAME_INPUT`      | Browser to host | binary   |            24 | active-escape with `game_input`                           |
| `0x22` | `GAME_SNAPSHOT`   | Host to browser | binary   |            44 | active-escape after GAME_INIT                             |
| `0x23` | `GAME_EVENT`      | Either          | JSON     |          1024 | active-escape after GAME_INIT                             |
| `0x24` | `GAME_RESULT`     | Host to browser | JSON     |          2048 | active-escape, exactly once per round                     |

An exact-size binary payload with any other size is `BAD_FRAME`. Receiving a mode-family message in the other mode is `MODE_MISMATCH`. Missing host capability is `UNAUTHORIZED_CAPABILITY`, or the more specific `READONLY`, `RESTART_DISABLED`, or `TERMINATE_DISABLED` where applicable.

## Handshake JSON

`CLIENT_HELLO` has this exact shape; `terminal` is omitted for escape and may be omitted for leash until the browser has measured its viewport.

```json
{
  "protocol_min": 1,
  "protocol_max": 1,
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
- `mode` is `escape` or `leash` and must match host state.
- Client `name`, `version`, and `platform` are non-empty and at most 64, 32, and 32 UTF-8 bytes respectively. `user_agent` is at most 512 UTF-8 bytes and may be empty. None is an authority input.
- Terminal `cols` is 20 through 500 and `rows` is 5 through 200.

The host selects the highest mutually supported version. v1 currently has overlap only when both ranges contain 1. A valid HELLO atomically acquires the session's single browser slot before any mode side effect.

`SERVER_WELCOME` has this exact shape:

```json
{
  "protocol": 1,
  "mode": "leash",
  "session_state": "active",
  "expires_at": 1788252800,
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
  ]
}
```

- `protocol` is the selected version and `mode` is authoritative.
- `session_state` is `active` for a newly accepted stream.
- `expires_at` is safe-integer Unix seconds from 0 through 9,007,199,254,740,991; zero means host lifetime.
- Relay `mode` is `official`, `custom-host`, or `custom-map`; `host` is a validated diagnostic hostname of at most 253 ASCII bytes; browser path is exactly `derp` in v1.
- Capabilities are unique strings in lexicographic order. Escape may grant `dash`, `game_input`, and `game_view`. Leash may grant `interrupt`, `resize`, `restart`, `terminal_input`, `terminal_output`, and `terminate`. The host checks the applicable capability again before every side effect.

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

## Escape binary payloads

`GAME_INPUT` is exactly 24 bytes:

```text
offset  size  field
0       4     input_sequence: u32, starts at 1 and strictly increases
4       8     client_time_ms: u64, diagnostic only
12      4     velocity_x: f32, -1.0..1.0
16      4     velocity_y: f32, -1.0..1.0
20      1     flags: bit 0 dash; bits 1..7 zero
21      3     reserved: all zero
```

The velocity magnitude is normalized to at most 1.0; receivers permit at most `0.000001` rounding tolerance in the squared magnitude of the decoded f32 components. Client time never determines authority or simulation time. Sequence zero and wrap are invalid for one session. A latest-only sender may replace only a queued movement with no dash bit; it must preserve an accepted dash event in order. The host ignores stale or duplicate input sequences and applies its no-input decay/stop/pause policy from receipt time.

The browser assigns input sequences when writing, not when replacing queued movement. It samples current intent every 50 ms, permits one game-input write in flight, and retains at most one replaceable movement plus eight ordered dash requests. Overflow rejects the new dash locally without discarding an accepted one. Host acceptance is also bounded to eight pending dash requests; overload is `BACKPRESSURE` before changing accepted sequence or receipt time. Expired or cooldown-blocked dash requests produce rejection feedback rather than being replayed as a burst. Disconnect revokes pending discrete work. Receipt age preserves direction with linear speed decay from 150 through 500 ms, stops movement at 500 ms, freezes the simulation at three seconds, and terminates the round at 30 seconds. Ping traffic and stale input cannot extend that deadline; fresh authorized input before it resumes one fixed step without replaying missed ticks.

A completed stream write may still be buffered in TCP. After an active input gap longer than 150 ms, the host therefore waits for a validated PONG for a regular PING sent after that gap before accepting more movement. The ordered PONG drains earlier buffered input; it is not a timestamp or one-way-latency estimate. Old movement is ignored and old dash requests receive `dash_rejected`. Neither ignored packets nor PONG updates the simulation's last accepted input time. The confirmation is valid for at most 150 ms until fresh input arrives, so another outage before that first input cannot reuse it indefinitely. New input after the boundary resumes normal receipt-time policy, and another gap needs another boundary. A newly negotiated stream has no inherited boundary or buffered input. The one-hertz PING cadence and all wire payloads are unchanged.

`GAME_SNAPSHOT` is exactly 44 bytes:

```text
offset  size  field
0       4     server_sequence: u32, starts at 1 and strictly increases
4       4     accepted_input_sequence: u32, zero before any accepted input
8       8     server_elapsed_ms: u64 active round time, excluding countdown/pauses
16      4     mouse_x: f32
20      4     mouse_y: f32
24      4     cat_x: f32
28      4     cat_y: f32
32      4     remaining_ms: u32
36      4     dash_cooldown_ms: u32, 0..5000
40      1     collected_mask: bits 0..1 are cheeses; bits 2..7 zero
41      1     phase: 0 countdown, 1 running, 2 paused
42      1     flags: bit 0 exit-open; bits 1..7 zero
43      1     reserved: zero
```

Coordinates must be finite and inside the 48 by 18 map's continuous bounds. The exit-open bit must equal `collected_mask == 0x03`. Sequence zero is malformed; a valid sequence not newer than the last applied snapshot is discarded without changing browser state. `remaining_ms` is at most the configured 30,000 through 45,000 millisecond round duration. The u64 time fields are decoded losslessly (not through a binary64 number). Stateful freshness, round-duration consistency and legal tile occupancy are enforced by the session after structural decoding.

A connection receives `GAME_INIT` before any other game message and an initial snapshot before sending input. Reconnection starts with empty browser queues and continues input sequences after the snapshot's accepted-input sequence; the host separately rejects work from an old connection lease. Snapshot and event sequences continue within the host session, including round restarts. Within a round, active elapsed time, accepted input and collected cheese bits never decrease, and running cannot transition back to countdown. Snapshot positions must occupy floor cells in the initialized map. Countdown snapshots have zero active elapsed time, collected mask and dash cooldown. Active elapsed time is rounded down to whole milliseconds; `remaining_ms` equals initialized round duration minus that elapsed value. The wire duration rounds a sub-millisecond CLI duration upward without altering simulation precision. Snapshot scheduling preserves its 100 ms cadence under tick jitter and never replays a missed snapshot backlog.

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

`GAME_INIT` is a compact object containing exactly `seed`, `map`, `mouse`, `cat`, `cheeses`, `exit`, `round_duration_ms`, `countdown_ms`, `constants`, and `presentation`. Seed is the signed CLI int64 rendered as a base-10 string. Map contains `name`, `width` 48, `height` 18, and exactly 18 UTF-8 rows of 48 cells using `#` for wall and `.` for traversable floor. Mouse, cat, the two cheeses, and exit each contain finite numeric `x` and `y` coordinates at legal distinct traversable positions. Round duration is 30,000 through 45,000; countdown is 3000. Constants contain the fixed v1 values `mouse_speed` 6.0, `cat_base_speed` 5.3, `cat_max_speed` 6.2, `dash_multiplier` 2.2, `dash_duration_ms` 350, and `dash_cooldown_ms` 5000.

Presentation contains exactly `control` (`touch` or `tilt`), `phone_render` (boolean), and `show_net` (boolean). These are the host's initial PRD configuration, not capability grants: disabling rendering preserves authorized controls and text state; selecting tilt still requires the user's explicit permission gesture and touch fallback. The browser may switch its local control preference. Missing, additional, null, or incorrectly typed fields are `BAD_FRAME`; no value is coerced. This is part of the unreleased v1 definition, not an optional extension understood by older partial implementations. Older payloads missing this object are rejected before gameplay. Terminal rendering is host-local and is not transmitted.

Seed uses canonical decimal spelling: no leading plus, leading zeroes or negative zero, and the inclusive range is -9223372036854775808 through 9223372036854775807. Map name is one of `courtyard`, `pantry`, `corridors`, `switchbacks`, and `crossroads`. Outer cells are walls; the five entities occupy different floor cells. Arrays have exactly the stated lengths. All listed nested objects have exactly their listed keys, and null is invalid except where explicitly allowed. Initial JSON coordinates retain their finite numeric values; live snapshots use the f32 layout above.

On the same connection another `GAME_INIT` is legal only after the previous round's result. It clears round-local intent, snapshot, event presentation and result state, but does not rewind session sequence numbers. A result stops input until such initialization and the next initial snapshot arrive. A result's relay matches the authoritative WELCOME relay, and its elapsed time is at least the last applied snapshot's elapsed time and at most the initialized round duration. Structurally valid stale snapshots/events are ignored even after a result; a new snapshot/event after a result and before another initialization is malformed.

`GAME_EVENT` contains exactly `sequence`, `event`, and `value`. Sequence is a positive u32 scoped to the sender. The browser-to-host `exit_requested` event has a null value. Host-to-browser values are: `countdown`, integer 0 through 3; `cheese_collected`, integer 0 or 1; `dash_rejected`, integer remaining cooldown milliseconds from 0 through 5000; and `exit_opened`, `connection_paused`, or `connection_resumed`, each null. Unknown events or mismatched value types are `BAD_FRAME` in v1.

`GAME_RESULT` contains exactly `outcome`, `elapsed_ms`, `relay`, `rtt_p50_ms`, `rtt_p95_ms`, `jitter_ms`, and `message`. Outcome is `escaped`, `caught`, `timeout`, or `connection_lost`; elapsed and metric fields are non-negative safe integers, with jitter nullable when unavailable. Relay is a validated diagnostic hostname or `official`. Message is one PRD result message of at most 256 UTF-8 bytes. One round emits exactly one result.

The result message is exactly `The cat was always <rtt_p50_ms>ms too late.` for `escaped`, `The connection was too good.` for `caught` or `timeout`, and `Connection lost.` for `connection_lost`. The integer in the escaped message has canonical decimal spelling. A different message is malformed, not text to display or log. The disconnect message supplies the neutral status omitted from the PRD's two illustrated ending screens. RTT p95 must not be less than p50. Codecs check numeric bounds; the session enforces result timing and exactly-once delivery.

## Common control JSON

`ERROR` is:

```json
{
  "code": "SESSION_BUSY",
  "message": "Another browser is controlling this session.",
  "retryable": true
}
```

The code must be from the stable error table below. Message is non-empty, at most 256 UTF-8 bytes, and must contain no credential, URL, token, terminal bytes, browser input, command environment, or upstream error. Retryable means only that a user-initiated bounded retry can be meaningful; it never authorizes automatic retry or a side effect.

`CLOSE` is `{"reason":"mode_complete","message":"Session closed."}`. Reason is `normal`, `mode_complete`, `local_revoke`, `expired`, `protocol_error`, or `transport_error`. Message follows the same redaction and 256-byte limit as ERROR.

## Stable errors

| Code                      | Default safe meaning                                 | Retryable |
| ------------------------- | ---------------------------------------------------- | --------- |
| `BAD_MOUSE_CARD`          | Invitation is invalid or unsupported.                | false     |
| `EXPIRED`                 | Session has expired.                                 | false     |
| `MODE_MISMATCH`           | Invitation mode does not match the host session.     | false     |
| `PROTOCOL_MISMATCH`       | No supported protocol version overlaps.              | false     |
| `SESSION_BUSY`            | Another browser is controlling this session.         | true      |
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
