<!-- The current NGO consultation flow, website identity contract, signed reporting and verification boundaries. -->
# Community consultations

Designs and named plans can be shared without asking anyone to decide. To consult a community,
open Agreements → Ask the community, choose the applied designs and enter a title, optional
deadline, organiser website and participation URL. The editor starts with the decision rule and
hides settlement controls. A community agreement has no land allocations, money lines or owner
approval configuration. Existing owner agreements keep their own decision and settlement flow.

The organiser field accepts a public HTTPS website, a domain, or a `did:web` identifier, including a
purpose path such as `did:web:community.example:ugt`. Publication commits the normalized DID and
HTTPS participation URL in `agreement/v1.consultation`. Either field can be absent; an agreement
without a named organiser has no organiser-result reporting. Drawing remains unrestricted.

## The shared page

The agreement link shows its designs, non-binding scope, organiser, deadline, any available
before/after preview and an external Take part link. Community consultation does not provide owner
consent, transfer land or trigger settlement. Social previews describe the non-binding consultation.
A binding owners' agreement can separately reuse the same designs if implementation is pursued.

## Website setup

The organiser serves its DID document at the standard DID Web URL:

| Identifier | Document |
| --- | --- |
| `did:web:community.example` | `https://community.example/.well-known/did.json` |
| `did:web:community.example:ugt` | `https://community.example/ugt/did.json` |

The page's Set up website reporting disclosure generates an example for the connected Solana
wallet and selected network. Retain existing verification methods when adding a reporting wallet.
The document must have the requested DID as its `id`; its `assertionMethod` must reference a
verification method controlled by that DID and naming the wallet in `blockchainAccountId`.
An authentication-only method does not authorize reporting. Network references use the first
32 characters of the Solana cluster genesis hash, per CAIP-2.

The browser fetches the document directly, over HTTPS, without credentials, redirects or a server
relay. The website must allow cross-origin access, for example `Access-Control-Allow-Origin: *`.
Resolution is capped at 64 KiB and 15 seconds. Root domains, ASCII purpose paths and encoded HTTPS
ports are supported; local hosts, IP addresses, traversal and ambiguous URLs are refused.

References: [DID Web](https://w3c-ccg.github.io/did-method-web/),
[DID verification relationships](https://www.w3.org/TR/did-core/#verification-relationships),
[CAIP-10](https://chainagnostic.org/CAIPs/caip-10),
[Solana CAIP-2](https://namespaces.chainagnostic.org/solana/caip2).

## Reporting and history

Report a result accepts a plain-text statement of at most 280 Unicode characters and an optional
HTTPS link to the organiser's detailed report. The browser checks the website before requesting a
Solana message signature. Signing needs no mint, program deployment, escrow or transaction fee.
EVM result signing is not implemented.

A `community-result/v1` report signs its exact agreement CID, organiser DID, network-qualified
wallet, statement, URL, signing time and SHA-256 of the canonical DID-document snapshot. The
signature is domain-separated from owner consent. The snapshot and signature travel with the
record; the server pins its exact canonical bytes and appends it to `consensus.community_report`.
Reports are accepted after the consultation deadline. The source's `postedAt` is retained; receipt
times remain separate database timestamps. The browser reads the report back before showing success.

`GET /agreements/:cid/community-reports` returns `{ agreementCid, reports: [{ cid, content }] }`.
`POST` to the same path accepts `{ cid, content }`; identical reports are idempotent. The server
checks CID, shape, signature and snapshot consistency before indexing, and checks that the indexed
agreement names the same organiser. It never fetches the organiser website. Deployments apply
`backend/db/community-report-ddl.sql` as `geo_user`, after the agreement table.

Readers recompute each report CID, verify its signature and independently resolve the current
website document. The latest currently authorized statement takes precedence; earlier statements
remain in history. When the site removes a wallet or is unavailable, its badge becomes neutral and
the statement is attributed to a signed wallet with unverified website attribution. A stored DID
snapshot alone cannot prove that a website ever served it. A green badge establishes current wallet
listing only. Eligibility, counting, methods and result correctness remain the organiser's responsibility.

The former proposal kinds, chain-account report subjects and vote mints are not read or migrated.
Changed experimental records must be recreated with the current agreement contract.
