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

All in **`backend/.env`** (loaded by the backend, and by the CLI scripts via
`load-env.js`): `CANTON_LEDGER_API_URL`, `CANTON_TOKEN_URL`, `CANTON_CLIENT_ID`,
`CANTON_CLIENT_SECRET`, `CANTON_AUDIENCE`, `CANTON_SCOPE` (default
`daml_ledger_api`), `CANTON_USER_ID` (the Canton ledger user, e.g. `6`), plus
`CCVIEW_API_URL` / `CCVIEW_API_KEY` for the explorer proxy.

## Verify

```bash
# Config is read from backend/.env automatically (no sourcing needed).
DAR_PATH=blockchain/daml/.daml/dist/consensus-builder-daml-0.2.0.dar \
  node backend/canton/check.js   # DAR_PATH optional
# -> CHECK OK — backend/canton module verified end-to-end on DevNet.
```
