# Auth + JSON Ledger API v2 spike

Goal: **de-risk the connection/auth before building any UI** — prove our Daml
contracts run on the real Canton stack (JSON Ledger API **v2**, OAuth2/JWT) end
to end: lens attests → buyer proposes (owner as observer) → owner sees it →
owner accepts → Sale.

`json-ledger-spike.mjs` is a zero-dependency Node harness (Node ≥ 18). It works
unchanged against **either** a local ledger **or** DevNet — only the env differs.

The risk splits into two layers:

| Layer | What it proves | Who runs it |
|---|---|---|
| **1 — API + JWT mechanics** | our DAR loads on Canton 3.x; v2 create/exercise/query; bearer auth; observer visibility | locally (this folder) |
| **2 — 5n sandbox / Loop specifics** | real OIDC issuer/client, your Loop Party ID, deploy via Seaport | you + your organizer |

> Note: the proposed route is Canton **3.x** (`dpm`, `@c7/ledger`, JSON API v2).
> Our M1 was built with SDK 2.10.4; the spike validates the 3.x toolchain.

---

## Layer 1 — local (what we can verify autonomously)

Run a local Canton 3.x ledger exposing the JSON Ledger API v2, upload the DAR,
and run the harness with auth disabled:

```bash
# from blockchain/daml/spike
set -a; . ./.env; set +a          # LEDGER_API_URL=http://localhost:7575, DAR_PATH=...
node json-ledger-spike.mjs
```

Expected tail: `SPIKE OK — auth + JSON Ledger API v2 + full purchase flow verified.`

This exercises everything except a real identity provider (auth disabled
locally). The OAuth code path is the same one used in Layer 2.

### Optional: full OAuth locally via cn-quickstart

To also exercise Keycloak → JWT locally:

```bash
git clone https://github.com/digital-asset/cn-quickstart.git
cd cn-quickstart/quickstart && make setup && make build && make start
```

LocalNet exposes JSON API on `…975` (app-user `2975`, app-provider `3975`) and
Keycloak at `http://keycloak.localhost:8082`. Get a token and point the harness
at it (see `.env.example`, Option 2 — `GRANT_TYPE`, `CLIENT_ID`, `CLIENT_SECRET`).

---

## Layer 2 — DevNet via Seaport (your manual steps)

These need a browser + org membership; they cannot be scripted from here.

1. **Loop wallet** — go to https://devnet.cantonloop.com, create a wallet, copy
   your **Party ID** (`abc123::122…34a`).
2. **Org** — give that Party ID to your organizer so they add you to the team org
   in Seaport.
3. **Deploy** — at https://app.devnet.seaport.to switch to the team org, create a
   project (or import this repo's `blockchain/daml`), **Build**, then **Deploy** to
   the **`5n sandbox`** validator.
4. **Get the validator config** — from Seaport's Validator Settings (or your
   organizer): **Ledger API URL**, **OIDC Issuer URL**, **OIDC Client ID**,
   **Client Secret**, **Scope** (`daml_ledger_api`), **API Audience** (often empty).
5. **Run the harness against DevNet** — fill `.env`:
   - `LEDGER_API_URL` = the validator's Ledger API URL
   - `TOKEN_URL` = `<OIDC Issuer URL>/protocol/openid-connect/token` (Keycloak)
   - `CLIENT_ID` / `CLIENT_SECRET` / `SCOPE=daml_ledger_api`
   - `*_PARTY` = your Loop Party ID(s) — do **not** auto-allocate on DevNet
   - leave `DAR_PATH` unset (the DAR is already deployed via Seaport)
   ```bash
   set -a; . ./.env; set +a; node json-ledger-spike.mjs
   ```

### Open Layer-2 question
Whether a **custom frontend** may connect directly to the 5n sandbox JSON API
with OIDC creds, or whether the demo must drive contracts through Seaport's
Contracts tab. If direct creds aren't handed out, the frontend integration (M2+)
talks to the validator the same way Seaport does — confirm with the organizer.
