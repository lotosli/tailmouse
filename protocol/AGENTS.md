# Protocol instructions

- Treat this subtree as the normative, language-neutral TMOUSE/1 contract. Do not import Go, TypeScript, Tailcat, DOM or platform implementation types.
- Every requirement defines framing, state, limits, invalid input behavior and compatibility in observable terms. Use exact byte/character units and canonical encodings.
- Store only synthetic, non-sensitive golden fixtures. Each fixture must be consumed by both Go and TypeScript conformance tests before it is normative.
- Additive fields require explicit unknown-field behavior. Breaking framing/state changes require a protocol version change and migration/rejection scenarios.
- Parsers fail before unbounded allocation or side effects. Truncation, overflow, duplicate/illegal transition and unsupported version cases are required tests.
- Do not generate SDKs or schemas merely to keep languages symmetric. Generate only when hand-maintained conformance has become a measured source of defects and an accepted design demonstrates lower total complexity.
