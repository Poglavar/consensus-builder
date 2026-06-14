# 5n sandbox — Canton DevNet validator access

Machine-to-machine (M2M) access to the **5N Seaport shared `5n sandbox`**
validator's **JSON Ledger API v2**. This lets us deploy DARs, create contracts,
query the ACS, and stream updates **directly via API** — no Seaport browser UI
required for ledger operations.

> **Secret handling.** The OIDC **client secret is NOT in this file or in git.**
> It lives in `spike/.env` (gitignored). Treat it like a production credential:
> it grants validator Ledger API access. **Never ship it to the browser** — see
> [Approach impact](#approach-impact).

## Endpoints

| Purpose | URL |
|---|---|
| Ledger REST API (v2) | `https://ledger-api.validator.devnet.sandbox.fivenorth.io/` |
| Ledger WebSocket | `wss://ledger-api.validator.devnet.sandbox.fivenorth.io` |
| OIDC token endpoint (Authentik) | `https://auth.sandbox.fivenorth.io/application/o/token/` |

## Auth — get a JWT (client_credentials)

- **Grant:** `client_credentials`
- **Client ID:** `validator-devnet-m2m`
- **Client Secret:** in `spike/.env` (`CLIENT_SECRET`)
- **Audience:** `validator-devnet-m2m`
- **Scope:** `daml_ledger_api`
- **Token TTL:** **8 hours** (`expires_in=28800`) → app must detect 401 and refresh.

```bash
curl -X POST 'https://auth.sandbox.fivenorth.io/application/o/token/' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials' \
  --data 'client_id=validator-devnet-m2m' \
  --data "client_secret=$CLIENT_SECRET" \
  --data 'audience=validator-devnet-m2m' \
  --data 'scope=daml_ledger_api'
```

## Use the API

```bash
# REST: pass the JWT as a Bearer token
curl 'https://ledger-api.validator.devnet.sandbox.fivenorth.io/v2/state/ledger-end' \
  -H "Authorization: Bearer <token>"

# WebSocket: subprotocols, ORDER MATTERS: jwt first, then daml.ws.auth
wscat --connect 'wss://ledger-api.validator.devnet.sandbox.fivenorth.io/v2/state/active-contracts' \
  -s 'jwt.token.<token>' -s 'daml.ws.auth'
```

Our `spike/json-ledger-spike.mjs` already drives this — `set -a; . ./spike/.env; set +a`
then run it (it exchanges the token, optionally uploads the DAR, and runs the
purchase flow).

## CCView — data indexing APIs

Canton data indexing / explorer APIs at https://docs.ccview.io. DevNet API key is
in `spike/.env` (`CCVIEW_API_KEY`). Useful for **reading/indexing ledger data**
(querying contracts, history) without scanning the raw Ledger API — directly
relevant to buyer-side discovery and listing proposals.

## Verified so far — FULL FLOW on live DevNet ✅

The spike (`spike/json-ledger-spike.mjs`) ran the **entire purchase flow** against
the 5n sandbox:

- ✅ Token exchange (Authentik) → JWT, `expires_in=28800` (8h).
- ✅ `GET /v2/state/ledger-end`, `GET /v2/parties`, `GET /v2/users`.
- ✅ `POST /v2/packages` — **DAR deployed via API** (no Seaport browser UI needed).
- ✅ `POST /v2/parties` — allocated lens/owner/buyer on our validator.
- ✅ `POST /v2/users/6/rights` — self-granted `CanActAs`.
- ✅ `POST /v2/commands/submit-and-wait` — created cert + proposal, exercised Accept.
- ✅ Owner-as-observer **visibility confirmed**; Sale created, proposal archived.

### Auth/usage gotchas learned (important for the frontend/backend)

1. **Our Canton user is `"6"`** (`primaryParty = 5nsandbox-devnet-2::…`,
   `participant_admin`). Command submissions must set **`userId: "6"`** — a wrong
   `userId` returns a vague `403 "security-sensitive error"`.
2. **`actAs` rights are required per party.** Admin (upload/allocate) ≠ actAs.
   After allocating a party, grant `CanActAs` via
   `POST /v2/users/6/rights` with body `{userId:"6", rights:[{kind:{CanActAs:{value:{party}}}}]}`.
3. **Scope ACS queries** to one party + one template (`filtersByParty` +
   `TemplateFilter`). A wildcard query blows past the node's **200-element cap**
   (`413 JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED`) because our primaryParty
   is a stakeholder on many shared contracts.
4. **Token TTL 8h** → detect `401` and refresh.

## Approach impact

These are **machine credentials**, not a per-user wallet. That changes two things:

1. **Backend proxy, not direct-browser.** Because the secret must never reach the
   browser, the client secret + token refresh belong in a **thin backend** that
   proxies Ledger API calls (or mints short-lived scoped tokens for the frontend).
   This revives §6 **option B** for anything beyond local dev.
2. **Party hosting for the MVP.** The M2M identity acts on **our** validator, so
   the simplest demo hosts the `lens` / `owner` / `buyer` parties **on the 5n
   sandbox** (allocated via `POST /v2/parties`) and drives them from the backend.
   True owner **self-custody** (owner's own Loop wallet on another participant,
   named as cross-participant observer over the shared synchronizer) remains the
   production direction, deferred past the hackathon MVP.
