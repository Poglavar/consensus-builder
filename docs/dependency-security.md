# Dependency security review

Reviewed on 2026-10-27 against the backend's committed npm dependency graph.
The initial audit reported 23 affected packages: one critical, 17 high and five
moderate. After the compatible updates, `cd backend && npm audit` reports nine
high findings and no critical or moderate findings. The nine remaining findings
are one unresolved Zod advisory propagated through dependent packages, not nine
independent vulnerabilities. They remain visible in the ordinary audit output.

## Repairs

The lockfile now resolves the patched versions of `proxy-addr` (2.0.8),
`body-parser` (1.20.9), `undici` (7.30.1), `follow-redirects` (1.16.2),
`fast-uri` (3.1.9), `ip-address` (10.7.5), `source-map-js` (1.2.2),
Vite (8.3.5), Vitest and its coverage/mocker packages (4.1.12), and the
application's direct Zod dependency (4.6.7). Compatible Coinbase, x402 and Solana
updates are included in the lockfile. Vitest's major version stays at 4.

The critical [proxy-addr advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
concerns incorrect trust of IPv4 clients through certain IPv6 subnet forms. The
application already trusts one proxy hop rather than those subnet forms; the
dependency is patched as well. A regression test exercises the vulnerable subnet
form and checks that an arbitrary client cannot supply its own forwarded address.

Solana's buffer-layout dependency still pulls in the unpatched native
[`bigint-buffer` implementation](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg).
The npm override pins `@exodus/bigint-buffer@1.1.5-exodus.1` under that dependency
name. Inspection of the published artifact confirmed that its exported
conversions always use JavaScript, with no native binding loader, native dependency
or install hook. This removes the vulnerable native conversion path. The exact
package integrity is pinned in the lockfile. Tests resolve the replacement through
the actual Solana dependency, round-trip both byte orders across short and large
buffers, and preserve the full unsigned 64-bit token amount through its layout.

## Unresolved upstream Zod 3 dependency

[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
covers excessive allocation while validating collections. The application and MCP
schemas use patched Zod 4.6.7; their constrained-array regression test checks that
an oversized array fails before accumulating one error per element.

Coinbase CDP SDK 1.60.0 and x402 2.28.0 still require Zod 3.25.76. At the time of
review these were their latest releases, and no patched Zod 3 release was
available. The audit reports `zod`, `abitype`, `@coinbase/cdp-sdk`, and the six
direct `@x402/*` packages as affected. Do not interpret the removal of the other
findings as resolution of this remaining resource-exhaustion risk.

Overriding these consumers to Zod 4 is incompatible: x402 uses the Zod 3
single-argument `z.record(valueSchema)` contract, among other version-specific
behavior. The audit's forced recommendations include downgrades to x402 0.0.1 and
Coinbase SDK 1.7.0; these do not preserve the payment protocol used by this app.
Neither an incompatible override nor those downgrades was applied.

The remaining consumers include payment-envelope validation and facilitator
response validation. HTTP size and rate limits reduce ingress but do not prove
the advisory unreachable, particularly for responses from a configured remote
service. Resolve this item with a compatible upstream security patch or a
separately verified payment-library replacement. Do not suppress the advisory or
declare the dependency audit clean in the meantime.

## Verification scope

`backend/test/dependency-security.test.js` covers the security behavior and the
Solana replacement. Targeted payment, oracle, discovery, Solana and MCP tests cover
the affected integrations. `npm ci --ignore-scripts --dry-run --no-audit --no-fund`
checks manifest/lockfile agreement without replacing a running development
environment. This is not a full-suite or production-deployment clearance.

MCP parity: dependency and test-index maintenance adds no editable field or
authoring operation. Existing MCP schemas and payment behavior are retained; no
new tool or schema is required.
