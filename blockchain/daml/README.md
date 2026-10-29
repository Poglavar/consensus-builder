# Canton / DAML contracts

DAML smart contracts for a single-parcel purchase on Canton. The map app's Canton integration was
removed on 2026-10-22; the model and the decisions that shape it are in
[docs/feature-daml-readme.md](../../docs/feature-daml-readme.md).

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

The DAR is deployed to the 5n sandbox DevNet validator through the **JSON Ledger API**
(`POST /v2/packages`) or the Seaport web IDE. The backend client that used to upload it
(`backend/canton/check.js`) was removed with the app integration. Bump `version` in `daml.yaml` on contract changes so
`#consensus-builder-daml` resolves to the newest; additive changes must stay
upgrade-compatible (e.g. new fields are `Optional`).

## Local ledger (optional, for offline dev)

```bash
daml sandbox --json-api-port 7575 --dar .daml/dist/consensus-builder-daml-0.3.0.dar
```
