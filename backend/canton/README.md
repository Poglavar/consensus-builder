# backend/canton — Canton JSON Ledger API client + routes

Server-side client and REST routes for the Canton DevNet (5n sandbox) JSON Ledger
API v2. This is the keystone of the Canton chain option: the OIDC **client secret
stays here**, never in the browser — the frontend only ever calls `/canton/*`.

## Modules

- **`token.js`** — `cantonConfig(env)` reads `CANTON_*` config; `getAccessToken(cfg)`
  exchanges client-credentials for a JWT and caches it until ~1 min before expiry
  (force-refreshed on 401).
- **`ledger.js`** — JSON Ledger API v2 calls: `ledgerEnd`, `uploadDar`,
  `allocateParty`, `grantActAs`, `submitAndWait` / `createContract` /
  `exerciseChoice`, and `activeContracts(party, templateId)` (scoped — a wildcard
  ACS query exceeds the node's 200-element cap on the shared validator).
- **`proposals.js`** — domain logic: `listProposalsForParty`, `listSalesForParty`
  (sales carry the lens), `createProposal` (lens attest → buyer offer; blanks
  auto-allocated; also writes a `ProposalMarker`), `acceptProposal` (archives
  proposal + marker, creates the Sale), `listParcelCounts` (public count from
  markers), `allocateDemoParty`, and `getPublicParty` (stable registry party,
  cached in `.public-party.json`).
- **`load-env.js`** — loads `backend/.env` for the CLI scripts below.
- **`dev-serve.js`** — serves the frontend + `/canton` routes on a free port (no
  DB), for local testing without Docker.
- **`check.js` / `check-route.js` / `seed.js`** — CLI verification + demo seeding.

Routes are mounted by **`../routes/canton.js`** (`setupCantonRoute`, wired in
`backend/index.js`):

| Method | Path | Purpose |
|---|---|---|
| GET  | `/canton/ledger-end` | connectivity check |
| GET  | `/canton/proposals?party=` | a party's active proposals |
| GET  | `/canton/sales?party=` | a party's completed sales |
| GET  | `/canton/parcel-counts` | public parcel→count (markers) |
| GET  | `/canton/ccview/:party` | CCView explorer summary (proxied) |
| POST | `/canton/proposals` | create (lens attest + buyer offer) |
| POST | `/canton/proposals/:cid/accept` | owner accepts → Sale |
| POST | `/canton/parties` | allocate a demo party |

## Config (env)

All in **`backend/.env`** (loaded by the backend, and by the CLI scripts via
`load-env.js`): `CANTON_LEDGER_API_URL`, `CANTON_TOKEN_URL`, `CANTON_CLIENT_ID`,
`CANTON_CLIENT_SECRET`, `CANTON_AUDIENCE`, `CANTON_SCOPE` (default
`daml_ledger_api`), `CANTON_USER_ID` (the Canton ledger user, e.g. `6`), optional
`CANTON_PUBLIC_PARTY` / `CANTON_PACKAGE_REF`, plus `CCVIEW_API_URL` /
`CCVIEW_API_KEY` for the explorer proxy.

## Verify

```bash
# Config is read from backend/.env automatically (no sourcing needed).
DAR_PATH=blockchain/daml/.daml/dist/consensus-builder-daml-0.3.0.dar \
  node backend/canton/check.js   # DAR_PATH optional once deployed
# -> CHECK OK — backend/canton module verified end-to-end on DevNet.
```
