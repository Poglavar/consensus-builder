# backend/canton — Canton JSON Ledger API client

Server-side client for the Canton DevNet (5n sandbox) JSON Ledger API v2. This is
the keystone of the Canton chain option: the OIDC **client secret stays here**,
never in the browser. Later, `backend/routes/canton.js` will expose a thin proxy
on top of this module.

## Modules

- **`token.js`** — `cantonConfig(env)` reads config (CANTON_-prefixed, with
  unprefixed fallbacks); `getAccessToken(cfg)` exchanges client-credentials for a
  JWT and caches it until ~1 min before expiry. Force-refreshed on 401.
- **`ledger.js`** — typed calls proven in the spike: `ledgerEnd`, `uploadDar`,
  `allocateParty`, `grantActAs`, `submitAndWait` / `createContract` /
  `exerciseChoice`, and `activeContracts(party, templateId)` (scoped — a wildcard
  ACS query exceeds the node's 200-element cap on the shared validator).
- **`check.js`** — CLI verification that runs the full purchase flow through the
  module (not a route).

## Config (env)

`CANTON_LEDGER_API_URL`, `CANTON_TOKEN_URL`, `CANTON_CLIENT_ID`,
`CANTON_CLIENT_SECRET`, `CANTON_AUDIENCE`, `CANTON_SCOPE` (default
`daml_ledger_api`), `CANTON_USER_ID` (the Canton ledger user, e.g. `6`).
Unprefixed names also work, so the spike's `.env` can be sourced directly.

## Verify

```bash
cd backend/canton
set -a; . ../../blockchain/daml/spike/.env; set +a
export DAR_PATH=../../blockchain/daml/.daml/dist/consensus-builder-daml-0.1.0.dar  # optional
node check.js
# -> CHECK OK — backend/canton module verified end-to-end on DevNet.
```
