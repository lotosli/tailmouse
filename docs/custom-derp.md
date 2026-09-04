# Custom DERP for TailMouse

The default uses Tailcat's official relay selection. Custom DERP is an operator-managed advanced option; TailMouse configures a connection but does not deploy or administer a relay. Web hosting and DERP are independent services. Browser connections remain DERP WebSocket-only, even when the host and phone share a LAN.

## Operator prerequisites

The supported configuration requires a directly reachable public hostname and publicly trusted TLS certificate. DNS A/AAAA records must point to the relay, with any advertised IPv6 address actually reachable. Do not place it behind an ordinary HTTP reverse proxy, Cloudflare Proxy or a global load balancer; for Cloudflare DNS choose **DNS only**. Allow inbound TCP 80/443, UDP 3478 and inbound/outbound ICMP. Plan patching, certificate renewal, uptime monitoring and bandwidth/egress limits. These network requirements follow the [upstream DERP guide](https://tailscale.com/docs/reference/derp-servers/custom-derp-servers), checked 2026-09-03.

Follow that guide's installation and service-management procedure on a relay host you administer. TailMouse does not require editing a tailnet policy or installing `tailscaled` on each TailMouse host/browser. Keep the operator's relay version and configuration under its own update process. Monitor relay logs, bandwidth and egress bills for unexpected use; never add TailMouse invitations or terminal content to those logs.

**`derper --verify-clients` is not a supported TailMouse combination.** It restricts traffic to a tailnet's devices; unaffiliated Tailcat/TailMouse browser clients cannot satisfy it. Expect connection failure, not an application bypass. Do not weaken an existing private tailnet relay for this purpose. A separate unverified relay may be used by others who discover it, so accepting that abuse/cost risk and managing capacity is an explicit operator decision. See [upstream client verification](https://tailscale.com/docs/reference/derp-servers/custom-derp-servers#optional-verify-client-traffic-to-the-custom-derp-server).

`pnpm test:transport` includes this rejection boundary using the recorded upstream DERP server and real Tailcat Wasm. A controlled local membership API admits only the fixture's Host and native positive-control keys; the unaffiliated browser fails before any application connection. This verifies the upstream client-verification path, not a deployed operator's tailscaled membership or public hostname. No test disables verification on an existing relay.

## Select an existing relay

These hostnames are illustrative `.invalid` placeholders, not live infrastructure. Replace them with your configured Web origin and relay before running:

```sh
tailmouse escape --web-base-url https://web.example.invalid/ --derp-host derp.example.invalid
tailmouse leash --web-base-url https://web.example.invalid/ --derp-host derp.example.invalid --readonly -- vim
tailmouse escape --web-base-url https://web.example.invalid/ --derp-map-url https://map.example.invalid/derp.json
```

Hostname mode builds a custom region with ID 900, code `mouse`, name `TailMouse Custom DERP`, DERP port 443 and STUN port 3478 by default. The configuration file can change supported region/port values. Map mode delegates selection to Tailcat. Both modes embed the selected region's node data in the invitation, so the browser does not need to download the map separately. A hostname is not a URL; supplying both effective host and map settings fails validation. See [configuration](configuration.md).

Use normal public TLS validation. Self-signed relay certificates and production TLS-verification bypasses are unsupported. A hosting provider serving a valid static page is not evidence that its relay protocol also works. Check Native and Web revision metadata, the redacted relay/connection status and both mode flows before relying on a new relay. Keep invitations and PTY content out of diagnostics. Public-host and physical-device acceptance remain separate from the repository's loopback relay tests.

Map downloads use verified HTTPS for the initial request and every redirect, without URL credentials or fragments. They are bounded to ten requests, ten seconds and an eight-MiB body. A rejected certificate, plaintext redirect, invalid map, `InsecureForTests` node or raw self-signed-certificate override stops startup before relay selection. Failure does not reuse an older map. The same checks apply to the official map; there is no flag to disable them.

DERP forwards encrypted traffic but can observe endpoint metadata, timing and traffic volume. Running your own relay changes its operator, not the browser transport model or TailMouse's bearer-link authorization.
