# Canton / DAML — what's built (README)

This complements `feature-daml.md`: the **spec** says what to build; this README
describes **what exists and how it works**. It's a living doc — updated as we go.

> **Status:** a working vertical slice of a single-parcel purchase on the live
> **Canton DevNet** (5n sandbox), end-to-end through a web UI. Money is not yet
> moved (price is a Canton-Coin-denominated number); the slice runs **custodially**
> (all parties hosted on our validator, driven by the backend). See the
> [decisions log](feature-daml.md#12-decisions-log-build).

## At a glance

| Layer | Where | Status |
|---|---|---|
| DAML contracts | `blockchain/daml/daml/Proposal.daml` | ✅ built, `daml test` green |
| Ledger client (token + API) | `backend/canton/{token,ledger}.js` | ✅ verified on DevNet |
| Domain logic | `backend/canton/proposals.js` | ✅ list / create / accept |
| REST API | `backend/routes/canton.js` | ✅ mounted in the app |
| Web UI (standalone console) | `frontend/canton.html` + `js/canton/canton-read.js` | ✅ standalone page |
| Enter Canton mode (P0) | `js/canton/canton-mode.js` + `user-management.js` | ✅ network switch + identity picker |
| Parcel proposal-count signal (P1) | `ProposalMarker` + `/canton/parcel-counts` + `js/canton/canton-counts.js` | ✅ on-ledger marker → map badges |
| Create proposal via main app (P2) | `canton-mode.js` bridge + `proposals.js` routing | ✅ Canton mode mints via `/canton/proposals` (skips NFTs) |
| View/Accept on parcel (P3) | `js/canton/canton-parcel.js` + `parcel-panel.js` | ✅ panel section: details if stakeholder, "private" otherwise, owner Accept |
| Identity tooling (P4) | `canton-mode.js` identity picker | ✅ pick/paste/generate + Copy / CCView / Forget / Clear |
| Real Canton Coin transfer | — | ⛔ parked (needs scan/registry URL) |
| Standalone console (`canton.html`) | `frontend/canton.html` | ✅ kept as backup demo |
| Owner self-custody | — | ❌ out of scope (see decisions log) |

Integration phases (see [feature-daml.md §13](feature-daml.md#13-integration-plan-folding-canton-into-the-main-app)):
**P0** ✅ enter Canton mode · **P1** ✅ counts (Option B markers) · **P2** ✅ create via map · **P3** ✅ view/accept on parcel · **P4** ✅ identity tooling folded in (`canton.html` kept as backup).

## Architecture

```mermaid
flowchart LR
    UI["Browser — canton.html<br/>(read / create / accept / perspective)"]
    R["backend/routes/canton.js<br/>/canton/*"]
    C["backend/canton<br/>token.js · ledger.js · proposals.js"]
    L["Canton DevNet — 5n sandbox<br/>JSON Ledger API v2"]
    UI -->|fetch /canton/*| R --> C -->|JWT + v2 calls| L
```

The OIDC **client secret never leaves the backend**. The browser only calls
`/canton/*`. The backend exchanges the secret for an 8h JWT (cached/refreshed) and
talks to the validator's JSON Ledger API v2.

## The DAML model (`blockchain/daml/`)

SDK **3.4.11** (the DevNet target). Three templates in `daml/Proposal.daml`:

- **`OwnershipCertificate`** — signatory `lens`, observer `owner`. The buyer-chosen
  lens attests that `owner` owns `parcelId`.
- **`PurchaseProposal`** — signatory `buyer`, observers `owner` + `lens`. Choices:
  - `Accept` (controller `owner`) → archives the proposal, creates a `Sale`.
  - `Withdraw` (controller `buyer`).
- **`Sale`** — signatory `buyer` + `owner` (the executed agreement).

`daml test` covers the happy path, owner-only Accept, and Withdraw.

## The flow + privacy

```mermaid
sequenceDiagram
    participant L as Lens
    participant B as Buyer
    participant O as Owner
    L->>L: create OwnershipCertificate (owner observes)
    B->>B: create PurchaseProposal (owner + lens observe)
    O->>O: exercise Accept → Sale
```

Visibility is enforced by Canton, demonstrated live via the **perspective switcher**:
- Before Accept: **buyer, owner, lens** all see the proposal; a **stranger** sees nothing.
- After Accept: **owner** (and buyer) see the **Sale**; the **lens** sees nothing
  (not a stakeholder of `Sale`); stranger still sees nothing.

## Backend (`backend/canton/`, `backend/routes/canton.js`)

- **`token.js`** — `cantonConfig(env)` + `getAccessToken()` (OIDC client-credentials,
  cached until ~1 min before expiry, force-refreshed on 401).
- **`ledger.js`** — JSON Ledger API v2 calls: `uploadDar`, `allocateParty`,
  `grantActAs`, `submitAndWait` / `createContract` / `exerciseChoice`,
  `activeContracts(party, templateId)` (scoped by party+template — a wildcard query
  exceeds the node's 200-element cap on the shared validator).
- **`proposals.js`** — `listProposalsForParty`, `listSalesForParty`,
  `createProposal` (lens attest + buyer create; blanks auto-allocated),
  `acceptProposal`, `allocateDemoParty`.
- **Routes** (`setupCantonRoute`, mounted in `backend/index.js`, no DB):
  - `GET  /canton/ledger-end`
  - `GET  /canton/proposals?party=…`
  - `GET  /canton/sales?party=…`
  - `POST /canton/proposals` — `{ parcelId, price, buyer?, owner?, lens? }`
  - `POST /canton/proposals/:cid/accept` — `{ owner }`
  - `POST /canton/parties` — `{ hint? }` (demo/stranger party)
- Helpers: `check.js`, `check-route.js` (verify module + routes vs DevNet),
  `seed.js` (seed a demo proposal), `dev-serve.js` (static frontend + routes, no DB).

## Identity model (custodial)

Our M2M token authenticates as Canton user **`6`** (`participant_admin`, primaryParty
`5nsandbox-devnet-2::…`). The backend allocates `lens`/`owner`/`buyer` **on our
validator** and self-grants `actAs`, so it can act as all of them. This is what
makes the perspective switcher possible — and why real owner self-custody is out of
scope (a Loop-wallet party on another participant can't hold our contracts).

## Run it locally

```bash
# 1. (once) build the DAR
cd blockchain/daml && daml build

# 2. start the dev server (Canton creds read from backend/.env; no DB needed)
node backend/canton/dev-serve.js          # prints a free-port URL (e.g. :62025)
```

Open `…/index.html` → network pill → **Canton** → pick an identity → select a
parcel → **Create proposal**. Switch identity to the **owner** to **Accept** from
the parcel panel's "Canton proposals" section. (Standalone console: `…/canton.html`,
kept as a backup.) The DAR is deployed once via `seed.js`/`check.js` (`DAR_PATH`) or Seaport.

## Verified against live DevNet

- Module + routes via `backend/canton/check.js` and `check-route.js`.
- The full create → perspectives → accept → sale flow, in a real browser.

## Deferred / not built

- **Real money** — `price` is a Canton-Coin number; no transfer yet (M4, parked on
  the validator-app / scan-registry URL).
- **Owner self-custody** — out of scope: a Loop-wallet party can't hold our DAR
  (`PACKAGE_SELECTION_FAILED`). See decisions log.

## See also

- `feature-daml.md` — the spec + decisions log + integration plan (§13).
- `blockchain/daml/DEVNET-ACCESS.md` — endpoints, auth, Canton Coin findings.
- `backend/canton/README.md` — the server-side client + how to verify.
