# Hackathon build and verification

These instructions reproduce the reviewable hackathon code. Live actions use Solana devnet and may
also require PostgreSQL data and operator-held credentials; the default verification path does not
spend funds or call an LLM.

## 1. Checkout

Requirements for the core review are Git, Node.js 20, and npm.

```sh
git clone --branch colosseum-worlds-fair https://github.com/Poglavar/consensus-builder.git
cd consensus-builder
git diff --stat 3ee1855...HEAD
```

`3ee1855` is the disclosed pre-hackathon baseline. [`HACKATHON.md`](../HACKATHON.md) lists the
features and public proof links added after it.

## 2. Install and run the fast tests

```sh
cd backend
npm ci
npm test
```

The backend suite uses Vitest. Network, signing, database, and live-ledger behavior is mocked unless
a test explicitly documents an opt-in environment flag.

For only the hackathon protocol and documentation contracts:

```sh
cd backend
npx vitest run \
  test/hackathon-repository.test.js \
  test/hackathon-demo.test.js \
  test/hackathon-deck.test.js \
  test/agent-proposals.test.js \
  test/agent-discovery-route.test.js \
  test/agent-x402-demo.test.js \
  test/agent-run-policy.test.js \
  test/land-events-route.test.js \
  test/proposal-lifecycle-oracle.test.js \
  test/proposal-market-layout.test.js \
  test/proposal-pledge-layout.test.js
```

## 3. View the frontend

The frontend is static HTML, CSS, and JavaScript; there is no compile step.

```sh
python3 -m http.server 8080 --directory frontend
```

Then open:

- <http://localhost:8080/deck.html> for the pitch;
- <http://localhost:8080/hackathon-demo.html> for the judge path; or
- <http://localhost:8080/> for the parcel map.

The locally served Demo Center targets `http://localhost:3000`. Use the public demo if you only want
to inspect the deployed evidence without configuring the database-backed API.

## 4. Run the API locally (optional)

The API expects PostgreSQL/PostGIS and the existing Urban Game Theory datasets. Create an ignored
`backend/.env` containing at least:

```dotenv
PGHOST=localhost
PGPORT=5432
PGUSER=consensus
PGPASSWORD=replace-me
PGDATABASE=consensus
API_PORT=3000
ENABLE_DEV_CORS=true
```

Never commit that file. With the required database schemas and data loaded:

```sh
cd backend
npm start
```

Useful read-only checks:

```sh
curl http://localhost:3000/health
curl http://localhost:3000/docs/agents.json
curl 'http://localhost:3000/oracle/events?limit=5'
```

x402 settlement additionally requires the `X402_*` and hosted CDP facilitator variables described
by `/docs/agents`; `X402_PRICE_ORACLE_FACT` independently prices verified-fact reads (`$0.01` on the
hackathon deployment). Agent signing requires a dedicated low-value devnet keypair. Neither is required
for unit tests or dry-run planning. The repository never contains production or persona keys.

## 5. Inspect or dry-run an agent

Agent planning can be deterministic and does not require an Anthropic key:

```sh
cd backend
PGHOST=localhost node agents/run.mjs --dry-run
node agents/support-run.mjs --dry-run --api https://api.urbangametheory.xyz
npm run demo:x402 -- --dry-run --url https://api.urbangametheory.xyz
```

The first command needs the local geodata database to generate candidates. The x402 dry run reads
discovery and the payment challenge but does not sign, pay, or write. Explicit `--controller llm`
is optional and is the only path that reads Anthropic credentials.

An MCP-capable host can use the same action adapters without an Anthropic key:

```sh
cd backend
npm run mcp
```

That default is read-only and exposes eleven tools. Paid proposal/fact tools and signed
pledge/donation/forecast tools remain disabled unless the MCP process has `UGT_MCP_LIVE=1`, an
external `UGT_AGENT_KEYPAIR`, and the individual call supplies `confirm: true`. The per-action cap
defaults to `0.25` devnet USDC and can be lowered with `UGT_MCP_MAX_USDC_PER_ACTION`.

## 6. Build the Solana programs (optional)

The programs use Anchor crates `0.30.1`; the checked-in workspace is known to build with Anchor CLI
`0.32.1` and stable Rust.

```sh
cd blockchain/solana
npm ci
rustup default stable
avm install 0.32.1
avm use 0.32.1
anchor build
```

Do **not** run `anchor keys sync`. The original deployment keypairs are intentionally absent, so a
fresh build creates throwaway keys and syncing them would rewrite the checked-in devnet program IDs.
The committed IDLs are under `blockchain/solana/idl/`.

Local validator tests are deliberately not part of the fast default. If you choose to run them,
start from the warning and instructions in [`blockchain/solana/README.md`](../blockchain/solana/README.md).

## 7. Live demonstration

The safest judge path is the deployed [Demo Center](https://urbangametheory.xyz/hackathon-demo.html).

For a bounded, read-only command-line walkthrough of the same public evidence:

```bash
cd backend
npm run demo:judge
```

The machine-readable scope is `/hackathon/proof.json`; the privacy-preserving prospective resolver
state is `/oracle/markets/prospective/status`. Neither endpoint exposes the private parcel recipe,
wallets, credentials or RPC configuration.
It links the Bazaar discovery record, paid agent proof, proposal and support transactions, market
state, unified activity, hashed recipe, and court-oracle aggregate. Missing dependencies remain
visibly pending.

The same public evidence can be checked without trusting the Demo Center UI:

```sh
cd backend
npm run audit:hackathon -- --url https://api.urbangametheory.xyz
```

The audit reads seven unauthenticated endpoints, requires exact Bazaar resource matches, and exits
non-zero when any required proof is absent. Add `--json` for a machine-readable report. It signs no
transactions and reads neither local keys nor private database state.

For a single proposal, open read-only **Details** on the map. The **From possible future to public
fact** timeline merges the public activity feed and proposal-lifecycle oracle into proposed, backed,
forecast and resolved stages. A missing stage remains pending; transaction-backed stages link to
Solana Explorer.

All tokens and programs used by the hackathon flow are on devnet. Do not reuse the deployment or
operator configuration for assets with real value.

To validate the external court-market path without writing to chain, provide the configured devnet
RPC in the environment and run:

```bash
node blockchain/solana/scripts/external-market-lifecycle.mjs
```

The redacted dry run checks the SAS account owner, credential, schema, issuer, expiry and payload
shape, then derives the exact market commitments. `--live` additionally creates a fresh two-sided
0.02 devnet-USDC integration market, waits for its close, resolves it and claims the winning pool.
Because that runner starts from an existing attestation, it is not a prospective forecast. It
intentionally does not print the parcel, decision, operation, legal-record link or
credential-bearing RPC URL.

For a temporally honest market, use the separate two-phase runner. The open phase does not accept or
read an attestation:

```bash
PROSPECTIVE_PARCEL_UID='…' \
PROSPECTIVE_YES_OPERATION='…' \
PROSPECTIVE_NO_OPERATION='…' \
PROSPECTIVE_CLOSES_AT='2026-09-30T18:00:00Z' \
PROSPECTIVE_BETTOR_KEYPAIR='…' \
node blockchain/solana/scripts/prospective-external-market.mjs --open
```

Add `--live` only after reviewing the redacted plan. It creates the market and two stakes, then
writes a gitignored mode-0600 state file. After close, provide a newly issued attestation:

```bash
PROSPECTIVE_ATTESTATION='…' \
PROSPECTIVE_BETTOR_KEYPAIR='…' \
node blockchain/solana/scripts/prospective-external-market.mjs --settle
```

The runner requires the five-field `CourtParcelOperationV2` schema and refuses settlement unless
both its committed `sourceObservedAt` and the attestation's first Solana transaction are at or after
market close. The deployed devnet program independently enforces
`market.closesAt <= sourceObservedAt <= resolution time` on-chain. The registered V2 schema is
`G747jAqNr6ZwBiNAdeW1Bc4PWQH7arfvq5cjDXDcSoMG`, and the runner uses it by default. The scraper now
stores the official source timestamp and the dedicated attester can publish it as an `int64` Unix
second. The first live V2 market is `Atps3gg4ZCvDMtbosTK5Evrb1PAwY2shUBvkzjihkaNQ`; both outcomes
were staked before its 2026-09-22 21:00 UTC close. The remaining step is necessarily temporal: wait
for a matching court record officially published after it closes. The opt-in production schedules
then run deterministic court interpretation and V2 attestation at 22:15 UTC and the idempotent
resolver hourly at `:45`; each writes an atomic outcome record for the central monitor. The existing
settled market remains an honest retrospective V1 integration proof until that later record exists.
