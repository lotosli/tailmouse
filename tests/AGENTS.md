# System test instructions

- Put a test here only when it crosses a runtime/process/platform boundary; keep unit tests next to their owning code.
- Use local hermetic Tailcat/DERP infrastructure, synthetic identities and redacted ConnBlob-shaped data. Never require public relays, personal accounts, production endpoints or real credentials.
- Make time, randomness, ports, terminal size and network impairment controllable. Bound every wait and emit the last meaningful state on timeout.
- E2E tests assert user-visible behavior and protocol outcomes, not CSS/layout internals or implementation call counts. Each test owns isolated processes, browser context and temporary data.
- Cover success plus cancellation, malformed/oversized frame, disconnect/reconnect, loss/reorder/latency, backpressure, denied browser capability and credential-leak paths.
- Coverage at or above 80% is a floor, not the test strategy. Do not add assertion-free execution, duplicate tests or exclusions to move the number.
- Stop on an environment invariant failure rather than cascading misleading assertions. Cleanup must be best-effort and must not hide the first failure.
