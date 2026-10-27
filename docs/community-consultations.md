<!-- The current NGO consultation flow, website identity contract, signed reporting and verification boundaries. -->
# Community consultations

Designs and named plans can be shared without asking anyone to decide. To consult a community,
open a saved plan, choose Create agreement, then Rules → Ask the community. Enter a title, optional
deadline, organiser website and participation URL. The community rule hides settlement controls.
A community agreement has no land allocations, money lines or owner
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

## Voting on the site

The agreement editor's Voting codes section prepares a fixed electorate before publication.
Enter one person or contact label per line, or generate unassigned codes. Generation, local JSON
restore and distribution CSV exports run in the browser; names and contact details are never sent
to the API. Save the voter-list JSON before saving the draft. The organiser distributes codes using
its own channels and retains that file for recovery. There is no email or SMS delivery service.

Only `consultation.voting = { schema: 'community-voting/v1', id, codeHashes }` enters the agreement.
The identifier is a random UUIDv4; hashes are sorted, unique PBKDF2-HMAC-SHA256 verifiers with
600,000 iterations and salt `ugt-voting-code/v1\n<id>`. The raw credential has 15 uniformly sampled
letters from `ABCDEFGHJKMNPQRSTUVWXYZ` (about 66.9 bits), grouped by three. Spaces, dashes and
case are normalized. The slow verifier also protects the public list against offline guessing.
The maximum electorate is 10,000 codes; generation proceeds in batches of up to 100 with progress.

Published eligibility cannot be edited. Additions, removals and replacement codes require a new
agreement; existing votes remain with the original agreement. Lost codes can be recovered from
the organiser's local file. No wallet is needed to generate codes, publish a poll, or vote.

Code holders use the shared agreement page to inspect, cast and change Support / Oppose / Abstain
ballots. Every change remains in private history, including after the deadline. Possession is the
authorization: the system cannot distinguish the recipient from an organiser who retained the code.
Totals are public; per-code choices and history require the original code. Raw codes are received
over HTTPS for verification and are never written to application logs or database rows.

`GET /agreements/:cid/voting` reads totals. `POST …/voting/access` accepts only `{ code }` and returns
the ballot/version/history. `POST …/voting/ballot` accepts `{ code, choice, expectedVersion, requestId }`.
The version prevents overwriting an unseen change; a UUIDv4 request ID makes retries idempotent.
The successful ballot is read back before the UI confirms it. All responses use `no-store`.

PostgreSQL advisory locks serialize writes, including across API processes. Persistent limits cap
authentication attempts per client and agreement at 120 per five minutes; wrong guesses impose
1, 2, 4, … up to 60 seconds of cooldown, with 20 failures per five minutes and an additional
1,000-failure agreement-wide limit. Expensive checks are also capped at 1,500 per agreement per
five minutes across clients. A 429 response supplies Retry-After. A separate HTTP limiter
caps request traffic. No delayed requests or sleeping connections are queued. Valid ballots may
change at most once per second. `backend/db/community-voting-ddl.sql` defines ballot/history/limiter
tables and is included in deployment DDL. The server is trusted to retain and report history.

MCP authoring uses the existing `ugt_draft_agreement` and `ugt_edit_agreement` consultation field.
Generate codes locally using `frontend/js/community/voting.js` or the browser; only its
`configuration()` projection belongs in MCP arguments. `ugt_voting_status` reads totals or an
authorized code's history; `ugt_cast_community_vote` requires explicit confirmation, the observed
version, and a retry-stable request ID. Neither tool accepts names, email addresses or phone lists.

### Verification (2026-10-27)

- Headless unit tests: `community-voting.test.js` covers derivation, local-file recovery, verifier-only
  metadata, fixed eligibility, changing votes, history, concurrent versions, retry idempotence,
  deadlines, shared guessing limits and actual MCP input schemas.
- Targeted headless unit runs covered six files initially (185 passed, one missing-locale failure);
  the locale file then passed all 22 checks. Subsequent targeted runs covered MCP registration,
  discovery, resources, report relay and write-limit middleware. Early report failures exposed a
  stale unbalanced fixture and validation ordering; both were corrected. HTTP tests required local
  socket access. The final report file passed 11 checks; the middleware file passed 9, MCP server 9,
  and resource file 6. One agreement-list assertion failed in a combined run, then passed in
  isolation and in the complete targeted 63-test agreement-route file. No full suite was run.
- Four headless Playwright scenarios: two creation scenarios initially used a removed Agreements
  navigation button. Updated them to saved plan → Create agreement → Rules. Both reruns passed;
  the ballot/history and signed-report scenarios passed in the initial run. Creation coverage
  checks local download/restore, refusal to save an unsaved code list, and absence of names and raw
  codes from saved agreements and network requests. These four browser scenarios use mocked APIs.
- Live local API/PostgreSQL and a dedicated headed browser: published a browser-created agreement,
  authenticated, cast and changed votes, observed one counted ballot with both history entries,
  rejected a concurrent stale write, returned 401 then 429 with Retry-After for bad guesses, and
  retained the ballot/history across API restart. Checked the real source parcel response and
  desktop/390-pixel layouts. The initial Python preview dropped script loads; the installed
  no-cache static server loaded the app correctly.
- Added all 12 new voting control source sites to the control contract. The repository-wide static
  control audit still reports unrelated pre-existing navigation/control inventory mismatches.
  MCP parity is verified through the actual agreement-edit and ballot schemas and the shared API
  adapters; personal assignment management intentionally runs locally, outside hosted MCP.
