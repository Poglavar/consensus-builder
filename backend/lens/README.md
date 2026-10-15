# Reference lens member

Release status (2026-10-02): supporting devnet program upgrades are byte-verified. Production member services and schema registration are separate from the API/frontend deploy and have not been verified live in this release. Complete that setup and a real owner-signed journey before treating fixture-backed tests as attestation evidence. Update 2026-10-09: notary-01 and lifecycle-01 run on the production host as PM2 apps `consensus-builder-lens-member` / `consensus-builder-lifecycle-member`, are public under `https://api.urbangametheory.xyz/lens-members/{notary,lifecycle}` (nginx proxies to :3095/:3096) and announced themselves into the directory; the proposer picks its lens from there.

A **lens** is the list of public keys a proposal names at mint: whose attestations that proposal's
contract will accept. A **lens member** is one key in such a list, a notary, a court, a cadastre
office, a permit register or an imagery service, that states facts about parcels and proposals as
**attestations** (Solana Attestation Service records it signs). An **owner** is a wallet a lens member
has attested as the owner of a parcel; owners say yes by signing `accept_with_attestations`
themselves. Lens members never accept proposals. Design of record: `../../lens-model.md`.

This directory is one lens member as a process: one key, one SAS credential, three schemas, and
(with `--rights`) the off-chain facts behind abstract proposal approval, signed with the same key.

| Attestation | Kind | Layout | Who can get it |
|---|---|---|---|
| `ParcelOwnership-v1` | `ownership` | `string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt` | an owner wallet that passes the identity check; x402-priced |
| `ProposalVerdict-v1` | `verdict` | `string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt` | the member's operator only (`executed` or `expired`) |
| `MarketEvidence-v1` | `evidence` | `string recipeHash, string subject, string value, int64 eventTime, int64 sourceObservedAt, string sourceRef` | the member's operator only, with a fact from a source adapter |

## Files

- `member.js`: the member as a library (`createLensMember`). Derives the credential and schema PDAs,
  turns the identity adapter's owner set into the ownership fact, encodes the payload with
  `../oracle/lens-schemas.js`, issues through the injected issuer, re-parses the returned account
  bytes before recording anything.
- `identity/devnet-registry.js`: devnet stand-in. The owner set is `consensus.lens_devnet_owner`
  (or an in-memory list); the wallet proves control by signing a challenge (ed25519).
- `identity/certilia.js`: production adapter stub (Certilia eOsobna OIDC); refuses with "not configured".
- `issuers.js`: fake issuer (builds the exact SAS account bytes in memory) and the sas-lib issuer.
- `store.js`: issued attestations in `consensus.lens_attestation`, or in memory.
- `pricing.js`: x402 gate for `POST /lens/ownership`, same pattern as the other paid agent routes.
- `approval.js`: abstract proposal approval (`createApprovalAttester`): checks a proposal's pinned
  rights snapshot against this member's own registry of abstract owners and signs the rights and
  authority facts below. Statement formats and verification: `../../frontend/js/proposals/approval-proof.js`.
- `server.js`: the Express app (`createLensMemberApp`). `run.mjs`: the CLI.
- DDL: `../routes/lens-member-ddl.sql` (applied by `deploy-backend.sh`).
- `../evidence/sf-dbi-permits.js`: the first market evidence adapter (San Francisco DBI building
  permits); `../scripts/check-permit-evidence.mjs` runs it against a recipe and prints the fact.

## Market evidence rules

`MarketEvidence-v1` answers a milestone market's recipe (`lmsr-market.md`, "Evidence for kind 1"):

- `recipeHash` is the recipe's `sha256:` hash and `subject` its subject text; `value` is the outcome
  text the record supports (`outcomes.yes` or `outcomes.no`; the permit adapter only ever finds yes,
  because no is the absence of a record by the deadline). The program hashes `subject` and `value`
  and compares them with the market's commitments, so they are passed byte for byte, never trimmed.
- `eventTime` is the source's own time of the event (a permit's issued date), `sourceObservedAt` when
  the adapter read the source. `eventTime ≤ sourceObservedAt ≤ now`; neither is ever invented.
- The address is deterministic per (recipe hash, value, event time): a retry, even with a later
  `sourceObservedAt`, returns the stored attestation; the same key with another subject is refused (409).
- The payload travels in the `create_attestation` instruction, so it must fit one transaction: at most
  883 bytes, which leaves 780 for `subject`, `value` and `sourceRef` together. That is why a subject
  is the jurisdiction and the canonical parcel-set hash (`US-CA-SF|sha256:…`, about 80 bytes) and
  never the parcel ids; an oversized payload is still refused before anything is sent.

```bash
cd backend
# dry run over saved rows (the observation time is stated, never read from a row), or --live-fetch
node scripts/check-permit-evidence.mjs --recipe recipe.json --fixture rows.json --observed-at 2026-10-12T01:12:30Z
# with the served recipe (it carries hash) and evidence found, it prints the body to post:
curl -s -H "x-lens-operator-token: $LENS_OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d @evidence.json localhost:3095/lens/market-evidence
```

## Ownership rules

- `ownerCount` is the member's recognised owner count for the parcel. Every registry row of the
  parcel must carry the same `owner_count`, and it may not be below the number of rows. A co-owned
  parcel yields one attestation per owner, all with the same count.
- `sourceObservedAt` is when that owner set came to be: the latest `established_at` among the
  parcel's rows. A row without `established_at` makes the parcel unattestable; the time is never
  taken from the clock.
- `evidenceRef` is `sha256:` over the owner set (parcel, count, time, sorted wallets). Opaque.
- The attestation address is deterministic per (fact kind, parcel, owner, count, source time), so a
  retry returns the stored attestation instead of issuing a twin, and is not charged again.

## API

| Route | Notes |
|---|---|
| `GET /lens/status` | key, kind, credential, schema PDAs, identity adapter, counts, pricing |
| `POST /lens/challenge {parcelUid, owner}` | `{challenge, message, expiresAt}`; the wallet signs `message` (UTF-8). 404 unknown parcel, 403 wallet not recorded. Valid 5 minutes. |
| `POST /lens/ownership {parcelUid, owner, signature, challenge}` | signature base58 or base64. Signature, registry and source-time checks run before the x402 gate, so refusals are free. 201 with `address`, `payload`, `accountHash` (sha256 over the account bytes), `issuedAt` (chain time), `payment`. |
| `POST /lens/verdict {proposalAccount, verdict, evidenceRef, sourceObservedAt}` | header `x-lens-operator-token: $LENS_OPERATOR_TOKEN`; 503 when the token is unset. |
| `POST /lens/market-evidence {recipeHash, subject, value, eventTime, sourceObservedAt, sourceRef}` | same operator header as verdicts. Times are Unix seconds (integers only). 201 issued, 200 already issued (`reused`), 409 same key with another subject, 422 invalid or too large. |
| `GET /lens/attestations?parcelUid=&proposalAccount=&owner=&recipeHash=&kind=` | issued attestations from the store; `kind` is `ownership`, `verdict` or `evidence` |
| `POST /lens/approval/rights {cadastreParcelIds, approvalConfig, lens}` | Needs `--rights`; 503 otherwise. The member recomputes the approval context hash, requires its own key in `lens`, and compares every in-scope parcel with its registry (complete owner list, exact shares, area). 201 `{rights}`: a signed `lens-rights-attestation/v1`. Free; names no wallet. 409 `rights_mismatch` / `area_mismatch` / `not_in_lens`, 404 `unknown_parcel`, 422 `rights_incomplete`. |
| `POST /lens/approval/challenge {wallet, contextHash}` | `{challenge, message, expiresAt}`; the wallet signs `message` (UTF-8). Valid 5 minutes, single use. |
| `POST /lens/approval/authority {wallet, challenge, signature, cadastreParcelIds, approvalConfig, lens}` | After the signature verifies: 201 `{rights, authority: [...]}`, one signed `lens-authority-attestation/v1` per in-scope owner the registry lets this wallet act for. 403 `not_authorized` when there is none; the wallet learns no other owner. |

Approval routes accept bodies up to 2 MB (an approval context carries the whole rights snapshot);
every other route keeps the 32 kB limit and answers 413 above it.

## Run in dry-run

No key, no chain, no payment: a fake issuer, an in-memory store, an ephemeral authority.

```bash
cd backend
echo '[{"parcelUid":"HR-335550-1/1","owner":"<wallet>","ownerCount":1,"establishedAt":"2026-06-01T00:00:00Z"}]' > /tmp/owners.json
LENS_OPERATOR_TOKEN=dev npm run lens:member -- --dry-run --owners /tmp/owners.json --port 3095
curl -s localhost:3095/lens/status
```

Without `--owners` the registry is read from `consensus.lens_devnet_owner` via `DATABASE_URL`.

## Register the schemas, then run live

1. Register the credential and the schemas under the member's key (dry run first):
   `node scripts/register-lens-schemas.mjs --keypair <member.json> --schemas ownership,verdict,evidence`,
   then the same with `--live`. Use the same `--credential-name` as the member (default `LensMember`).
2. Run `npm ci` in `backend/`; `sas-lib` is a declared dependency, loaded by the live issuer.
3. Set `X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_PAY_TO` (and CDP credentials for the CDP
   facilitator), optionally `LENS_OWNERSHIP_PRICE_USDC` (default `0.01`) and `LENS_OPERATOR_TOKEN`.
   Without the x402 settings a live member answers 503 on `POST /lens/ownership` instead of issuing free.
4. `npm run lens:member -- --live --keypair <member.json> --cluster devnet`.

## Deploying your own member (a notary, a cadastre office)

A lens member is a business anyone can enter: run this process with your own key, your own
credential name, your own identity adapter and your own `X402_PAY_TO`. Proposers add your key to
their lens; the contract then accepts your ownership attestations for their proposals. Nobody has to
approve you, and being listed costs you nothing: an attestation you never issue is simply absent.
Your key is the credential authority, so keep the keypair off shared hosts and out of git; the
schema PDAs are derived from it (`GET /lens/status` prints them).

No database is needed: `--owners` holds your owner set in a JSON file and `--store` keeps issued
attestations in another, rewritten atomically on every issue.

```bash
git clone <this repo> && cd <repo>/backend && npm ci
solana-keygen new -o ~/lens-member.json          # fund it with devnet SOL for rent
node scripts/register-lens-schemas.mjs --keypair ~/lens-member.json --credential-name MyNotary --live
X402_NETWORK=solana-devnet X402_FACILITATOR_URL=<facilitator> X402_PAY_TO=<your wallet> \
node lens/run.mjs --live --keypair ~/lens-member.json --credential-name MyNotary \
  --owners ~/owners.json --store ~/attestations.json --host 0.0.0.0 --port 3095 \
  --announce https://api.urbangametheory.xyz --public-url https://lens.example.org --name "My notary office"
```

`--announce` signs a registration with the member key once the server listens and posts it to the
directory's `/agent/lenses/members`. The directory checks the signature, that the credential and the
schema your `--kind` issues exist on chain, and that `--public-url/lens/status` answers live with the
same key, credential and kind; then the proposal picker lists you. The public URL must be https (put
the process behind any TLS proxy). A refusal is printed with its reason and the member keeps serving,
so proposers can still paste your key by hand. Re-announcing with new text replaces your entry.

## Proposal approval facts (`--rights`)

A proposal with an approval setup pins a parcel-rights snapshot (abstract owner IDs with exact
shares). Owners accept for themselves; a lens member only states two separate facts about them,
each an Ed25519 signature by the member key over a canonical statement:

- **Rights** (`lens-rights-attestation/v1`): for this approval context, the snapshot's in-scope
  parcels match the member's registry exactly.
- **Authority** (`lens-authority-attestation/v1`): this wallet may act for this abstract owner in
  this context. Issued only after the wallet signs a challenge.

Both carry `issuedAt`/`expiresAt` (`--approval-validity-days`, default 7). The owner's decision is
the wallet's own signature (`ed25519-wallet/v1`); a receipt counts only when all three signatures
verify and both members are in the proposal's lens. Rights and authority may come from different
members. A dry run signs with an ephemeral key, which `/lens/status` reports as the member key.

The registry (`lens-rights-registry/v1`) holds no names: opaque owner IDs, exact fractions, areas,
and which wallets act for which owner. One owner may hold several parcels; one wallet may act for
several owners.

```json
{
  "schema": "lens-rights-registry/v1",
  "parcels": [
    { "parcelId": "HR-335550-1/1", "areaM2": 412, "owners": [{ "ownerId": "owner-7f3a", "share": "1/1" }] },
    { "parcelId": "HR-335550-2/1", "areaM2": 260, "owners": [
      { "ownerId": "owner-7f3a", "share": "1/2" }, { "ownerId": "owner-c19e", "share": "1/2" }
    ] }
  ],
  "signers": [
    { "ownerId": "owner-7f3a", "wallet": "<base58 wallet>" },
    { "ownerId": "owner-c19e", "wallet": "<base58 wallet>" }
  ]
}
```

```bash
cd backend
node lens/run.mjs --dry-run --owners /tmp/owners.json --rights /tmp/rights.json --port 3095
curl -s localhost:3095/lens/status   # .approval: { enabled, parcels, owners, signers, validitySeconds }
```

The live notary-01 persona (`agents/lens-member-run.mjs --persona notary-01 --live`) reads its registry
from the persona's `service.rights` path, `~/.config/ugt/notary-01-rights.json` on its host, and refuses
to start when that file is missing. The registry lists signer wallets, so it stays on the host, like the keypair.

## Privacy

- No person on chain. Attestations carry wallets, hashes and opaque references only.
- No name, OIB or other personal identifier is ever written to an attestation, the store, a log or a
  response. `evidenceRef` is a hash or the member's own case id.
- `lens_devnet_owner.note` is operator free text for devnet bookkeeping and must not hold a name or OIB.
- The Certilia adapter, when built, matches the OIB inside this process and discards it.
