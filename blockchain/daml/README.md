# Canton / DAML contracts

DAML smart contracts for the Canton chain option (the third blockchain backend
alongside EVM and Solana). See `../../feature-daml.md` for the spec/plan and
`../../feature-daml-readme.md` for what's built and how it works.

SDK **3.4.11**; package **`consensus-builder-daml` 0.3.0** (the DevNet target).

## Templates (`daml/Proposal.daml`)

- **`OwnershipCertificate`** — the buyer-chosen **lens** attests that an owner owns
  a parcel. signatory `lens`, observer `owner`.
- **`PurchaseProposal`** — a buyer's offer for one parcel, referencing the cert.
  signatory `buyer`, observers `owner` + `lens`.
  - `Accept` (controller: owner) → archives the proposal, creates a `Sale`.
  - `Withdraw` (controller: buyer) → cancels the offer.
- **`Sale`** — the executed agreement. signatory `buyer` + `owner`; **`Optional lens`
  observer** (carried through `Accept`) so the lens still sees the completed sale,
  read-only, after acceptance. (Optional → package stays upgrade-compatible.)
- **`ProposalMarker`** — public **existence signal** for the map count: signatory
  `buyer`, observer a designated public registry party; carries only `parcelId` +
  an opaque proposal cid (no terms). Created with each proposal, archived on
  accept/withdraw. This is the selective-disclosure piece — existence is public,
  terms stay with stakeholders.

## Prerequisites

DAML SDK (installs the `daml` CLI):

```bash
curl -sSL https://get.daml.com/ | sh
```

## Build & test

```bash
daml build      # → .daml/dist/consensus-builder-daml-0.3.0.dar
daml test       # runs the Daml Script tests in daml/Test.daml
```

## Deploy

The DAR is deployed to the 5n sandbox DevNet validator via the **JSON Ledger API**
(`POST /v2/packages`) — the backend client does this:

```bash
DAR_PATH=blockchain/daml/.daml/dist/consensus-builder-daml-0.3.0.dar \
  node backend/canton/check.js      # uploads the DAR, then runs the full flow
```

(or via the Seaport web IDE). Bump `version` in `daml.yaml` on contract changes so
`#consensus-builder-daml` resolves to the newest; additive changes must stay
upgrade-compatible (e.g. new fields are `Optional`).

## Local ledger (optional, for offline dev)

```bash
daml sandbox --json-api-port 7575 --dar .daml/dist/consensus-builder-daml-0.3.0.dar
```
