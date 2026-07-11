# Feature: Walrus storage provider (alternative to IPFS/Pinata)

Spec + implementation plan for integrating **Sui Walrus** decentralized blob storage as a
selectable alternative to the current IPFS/Pinata and local-filesystem storage. Walrus becomes
a *config-selected option* — it does **not** replace or overwrite the existing Pinata/local
paths. We also build a script to mint all ~40k NYC parcels as NFTs with Walrus as the storage
backend, proving the end-to-end proposal/parcel flow works against Walrus.

> Status: **DRAFT — for review.** Implement after refinement.

---

## 1. Why / goals

- Add **Walrus** as a third, config-selectable storage backend for NFT metadata + images,
  alongside the existing Pinata/IPFS and local-filesystem options. Selecting it is a config flip;
  nothing existing is removed.
- Walrus is **chain-agnostic** — our NFT contracts stay on EVM/Solana and only store an opaque
  metadata URI string, so no contract changes are needed. This is exactly the integration shape
  Walrus expects.
- Substantive use of Walrus: **every parcel NFT and proposal NFT can store its JSON metadata +
  image on Walrus**, and the frontend reads it back through the Walrus aggregator.
- Prove it at scale by minting ~40k NYC parcels as NFTs with Walrus-backed metadata, then creating
  + funding a proposal over those parcels through the normal flow.

---

## 2. What Walrus is (the parts we use)

Walrus stores arbitrary **blobs**. Each stored blob gets a content-derived **`blobId`** (base64url
string) and a backing **Sui object** (object id). Blobs are stored for a number of **epochs**
(time-boxed) or **permanently**.

We interact via the **HTTP API** (publisher to write, aggregator to read) — no Sui SDK / wallet
needed for the basic flow, which keeps the integration small and matches our existing
"backend uploads, returns a URI" pattern.

### Write — publisher
```
PUT {publisher}/v1/blobs?epochs={N}
body: <raw bytes>
optional query: &permanent=true | &deletable=true | &send_object_to=0x<suiAddr>
```
Response (200), two shapes:
```jsonc
// first time this content is stored
{ "newlyCreated": { "blobObject": {
    "id": "0x<suiObjectId>",
    "blobId": "<blobId>",
    "size": 1234,
    "storage": { "endEpoch": 123, ... } },
    "cost": 1000 } }

// content already on Walrus (dedup by content)
{ "alreadyCertified": {
    "blobId": "<blobId>",
    "endEpoch": 123,
    "event": { "txDigest": "<sui tx>" } } }
```
Helper extracts `blobId` from `newlyCreated.blobObject.blobId` **or** `alreadyCertified.blobId`.

### Read — aggregator
```
GET {aggregator}/v1/blobs/{blobId}        -> raw bytes
GET {aggregator}/v1/blobs/by-object-id/{objectId}
```
Aggregator returns `application/octet-stream` by default; we set/serve the correct content-type
ourselves where it matters (our metadata is JSON, images are PNG/SVG).

### Public endpoints (defaults; override via env)
| Network | Publisher | Aggregator |
|---|---|---|
| Testnet | `https://publisher.walrus-testnet.walrus.space` | `https://aggregator.walrus-testnet.walrus.space` |
| Mainnet | `https://publisher.walrus-mainnet.walrus.space` | `https://aggregator.walrus-mainnet.walrus.space` |

Notes / gotchas to design around:
- **Public publishers cap blob size (~10 MiB)** and are rate-limited / best-effort. Fine for our
  metadata JSON + small parcel images, but the 40k batch needs throttling + retries (see §7).
- **Network default = testnet.** Testnet has free public publishers/aggregators (WAL from a
  faucet). **There is no public unauthenticated mainnet publisher** — mainnet writes require
  running our own (JWT-authed) publisher / upload relay / TS SDK with a funded account (see §2.1).
  Make the network and all endpoints fully env-configurable.
- **Epochs vs permanent:** testnet epochs are short (≈1 day); mainnet epochs ≈2 weeks. Use a
  generous `epochs` value, or `permanent=true` on mainnet. Expired testnet blobs disappear — fine
  for development, but call it out in the README.
- **Content-addressed / dedup:** Walrus keys blobs by content. Re-uploading identical bytes returns
  `alreadyCertified` with the **same blobId** — no duplicate storage, no extra cost. Our client
  handles both response shapes, so this needs no special handling (e.g. all parcels sharing a
  placeholder SVG collapse to one image blob).

### 2.1 Cost & payment

- Storage price is **USD-pegged at the protocol level**, roughly **~$5/GB per epoch**, paid in
  **WAL** (~$0.08). Writes consume **WAL** (storage) + **SUI** (gas) from the account doing the
  write.
- Our blobs are tiny (metadata JSON a few KB, parcel image a few KB). 40k parcels × ~10 KB ≈
  400 MB raw. The real cost driver is Walrus's **minimum encoded storage unit** plus ~5× erasure-
  coding overhead, so per-blob cost is small-but-not-zero rather than proportional to a few KB.
  Total for the full 40k is expected to be single-digit dollars per epoch — **confirm with
  `walrus info` / the cost calculator before the full run** (investigation task, §9).
- **Testnet:** free via public publishers — the default for development and the 40k run.
- **Mainnet:** real WAL + SUI, and we must operate the writer. Plan = generate a **project-owned
  Sui keypair**, fund it with SUI + WAL, and either (a) run our own publisher, or (b) write via the
  TS SDK / upload relay. Endpoints + signing key all come from env. Mainnet is a deliberate,
  separately-funded step — not the default.

### Our URI scheme
Mirror the existing `ipfs://<CID>` convention:
- Canonical pointer stored on-chain / in DB: **`walrus://<blobId>`**
- Gateway/HTTP form for browsers: **`{aggregator}/v1/blobs/<blobId>`**

This slots into the exact same "metadataUri (canonical) + metadataGatewayUrl (browser)" pair the
code already passes around.

---

## 3. Current storage architecture (what we're extending)

There is **no storage-provider abstraction today**. Three backends each produce a metadata-URI
string the rest of the system treats opaquely:

| Backend | Where | Returns | Selected by |
|---|---|---|---|
| **Pinata/IPFS** | `backend/routes/ipfs.js` → `POST /ipfs/upload` | `ipfs://CID` + `gateway.pinata.cloud/ipfs/CID` | non-local chain id, or `target:'ipfs'` |
| **Local FS (assets)** | `backend/routes/assets.js` → `POST /assets/upload` | `http://host/...` URLs (mirrors IPFS response keys) | default / local chain (31337/1337) |
| **Local FS (generic)** | `backend/routes/file-storage.js` → `POST /images`,`/metadata`,`/models` | `http://host/...` URLs | direct fallback in parcel claim |

Common response contract that everything downstream depends on:
```jsonc
{ "imageUri":    "<canonical image pointer>",
  "imageGatewayUrl":    "<browser url>",
  "metadataUri":    "<canonical metadata pointer>",   // also accepted as metadataUrl
  "metadataGatewayUrl": "<browser url>" }
```

### What gets stored
- **Parcel NFT metadata** (JSON) + **parcel image** (PNG screenshot from frontend, or generated
  **SVG** of the polygon from mint scripts). Shape: `name, description, image, attributes[], parcelId,
  areaSquareMeters, geometryHash, geometry (GeoJSON)`.
- **Proposal NFT metadata** (JSON) + **proposal map screenshot** (PNG). Shape: `name, title,
  description, image, attributes[], properties{ proposalId, goal, parcelIds, offer, author, ... }`.
- (3D `.glb` models go to local disk only — out of scope for Walrus v1.)

### Flows that touch storage

```mermaid
flowchart TD
    subgraph Frontend
      P[proposals.js<br/>createProposal] --> AS[AssetService.uploadProposalAssets<br/>frontend/js/ipfs.js]
      C[parcels/ui/claim.js<br/>prepareParcelMintAssets] --> AS
    end
    AS -->|target=ipfs / non-local chain| IPFS[POST /ipfs/upload<br/>Pinata]
    AS -->|default / local chain| LOCAL[POST /assets/upload<br/>local FS]
    AS -. NEW .->|target=walrus| WAL[POST /walrus/upload<br/>Walrus publisher]

    IPFS & LOCAL & WAL --> URI[(metadataUri + gatewayUrl)]
    URI --> BR[ProposalChainBridge.mintProposal / ParcelNFT.mintBatch]
    BR --> CHAIN[(EVM/Solana NFT<br/>tokenURI = metadataUri)]
    BR --> DB[(proposals.onchain_data JSONB<br/>holds metadataUri/imageUrl)]

    subgraph Scripts
      MS[blockchain/scripts/mint-parcels.js<br/>createMetadataResource] -->|pinata| PIN2[Pinata]
      MS -->|filesystem| FS2[backend/uploads]
      MS -. NEW .->|walrus| WAL2[Walrus publisher]
    end
    MS --> CHAIN
```

Key integration facts (verified):
- **Smart contracts need NO changes.** `ParcelNFT.mintParcel/mintBatch(... metadataURI)` and
  `ProposalNFT.mintAndFund(... imageURI)` (the `imageURI` field actually holds the *metadata* URI)
  store an **opaque non-empty string** and return it verbatim from `tokenURI`. We store
  **`walrus://<blobId>`** (see §4.0). Solana programs (`parcel_nft`, `proposal_nft`) likewise take
  a `metadata_uri` / `image_uri` string. Both require **non-empty** — our helper must always return
  a real URI or throw.
- **DB:** proposals persist the pointer inside `onchain_data JSONB` (`proposals-ddl.sql:66`); no
  schema change needed. Parcel mints are on-chain only.
- **Two seams to add Walrus to:**
  1. Backend HTTP (frontend flows) — new `/walrus/upload` returning the standard response contract.
  2. `mint-parcels.js` `createMetadataResource` (lines ~819–872) — new `walrus` branch returning
     `{ metadataURI, metadata, storage:'walrus' }`. `mint-proposals.js` has its own parallel Pinata
     code to extend the same way.
- **Display layer** special-cases `ipfs://` in `frontend/js/proposals.js:48`,
  `frontend/js/minted-proposals.js:41`, and `frontend/js/og-metadata.js`. These must learn to
  resolve `walrus://<blobId>` → `{aggregator}/v1/blobs/<blobId>`.

---

## 4. Design — a thin storage-provider abstraction

Introduce an explicit, named provider selected by config, **without touching the existing
`/ipfs/upload` and `/assets/upload` routes** (kept for backward compat). New code is additive.

### 4.0 On-chain pointer form (decided)
Store **`walrus://<blobId>`** as the canonical pointer on-chain and in the DB — host-independent,
content-addressed, future-proof, and consistent with the existing `ipfs://<CID>` convention.
**Also** persist/return the `gatewayUrl` (`{aggregator}/v1/blobs/<blobId>`) alongside it for
convenient rendering, exactly as we already do for IPFS. (A full aggregator URL on-chain would work
in third-party marketplaces without a resolver, but it bakes a specific aggregator host into
immutable data and rots if that host moves — rejected.)

### 4.1 Backend module: `backend/storage/`
```
backend/storage/
  index.js        # resolveStorageProvider(name) -> provider; reads STORAGE_PROVIDER default
  walrus.js       # NEW: putBlob(bytes, contentType) -> { blobId, suiObjectId, endEpoch, cost }
                  #      buildUri(blobId) -> 'walrus://<blobId>'
                  #      buildGatewayUrl(blobId) -> '{aggregator}/v1/blobs/<blobId>'
```
`walrus.js` is a small, dependency-free wrapper over `fetch` (Node 18+ global fetch, already used
in `ipfs.js`). One method uploads bytes to `{publisher}/v1/blobs?epochs=N` (plus optional
`&send_object_to=<addr>` / `&permanent=true`), parses `newlyCreated|alreadyCertified`, and returns
the blobId + Sui object info (so we can surface cost and the Sui object id).

### 4.2 New route: `backend/routes/walrus.js` → `POST /walrus/upload`
Same request body as `/ipfs/upload` (`{ imageData: base64 data URL, metadata: object, fileName? }`)
and **same response contract**:
1. Decode the base64 image → `putBlob(imageBytes, contentType)` → image `blobId`.
2. Enrich metadata: `image = walrus://<imageBlobId>`, `image_url = {aggregator}/v1/blobs/<imageBlobId>`,
   default `external_url`.
3. `putBlob(JSON.stringify(metadata), 'application/json')` → metadata `blobId`.
4. Respond:
   ```jsonc
   { "imageUri":"walrus://<imgBlobId>", "imageGatewayUrl":"{agg}/v1/blobs/<imgBlobId>",
     "metadataUri":"walrus://<metaBlobId>", "metadataGatewayUrl":"{agg}/v1/blobs/<metaBlobId>",
     "storage":"walrus", "suiObjectId":"0x...", "endEpoch":123, "cost":1000 }
   ```
   (extra fields are ignored by existing callers; useful for cost display + linking the Sui object).

Wire in `backend/index.js` next to `setupIpfsRoute` (`setupWalrusRoute(app)`).

### 4.3 Frontend: `frontend/js/ipfs.js`
- Add `uploadViaWalrus(base, payload)` → `POST /walrus/upload`.
- Extend `uploadProposalAssets({..., target})`: support `target:'walrus'`.
- Add a **configurable default provider** so callers don't have to pass `target` everywhere:
  read `window.STORAGE_PROVIDER` (injected via existing config mechanism / `getBackendBase` sibling)
  defaulting to current behavior. `target:'auto'` resolution order becomes:
  explicit `target` → `window.STORAGE_PROVIDER` → existing chain-id heuristic.
- Keep the existing IPFS/local fallback behavior intact when provider is unset.

### 4.4 Display layer — resolve `walrus://`
Add a shared helper (e.g. `resolveBlobUri(uri)`) that maps `walrus://<id>` →
`{aggregator}/v1/blobs/<id>` and leaves `ipfs://` / `http(s)://` handling as-is. Use it in
`proposals.js`, `minted-proposals.js`, `og-metadata.js`. The aggregator base is read from config
(`window.WALRUS_AGGREGATOR`), defaulting to the public testnet aggregator.

### 4.5 Mint scripts — `blockchain/scripts/mint-parcels.js`
- Add a `walrus` branch to `createMetadataResource`:
  - build SVG image → `putBlob` → image `walrus://`/gateway, set `metadata.image`/`image_url`.
  - `putBlob(JSON.stringify(metadata))` → `metadataURI = walrus://<blobId>` (per §4.0).
    Return `{ metadataURI, metadata, storage:'walrus', blobId, suiObjectId }`.
  - Walrus client for scripts is a **CJS module** `blockchain/scripts/walrus-storage.js`, `require`d
    by the mint scripts — matching the repo convention (scripts are CJS, backend is ESM, no
    cross-boundary sharing; e.g. `mint-proposals.js` already requires helpers from `mint-parcels.js`).
    Backend keeps its own ESM `backend/storage/walrus.js`. The ~30 lines of duplication is
    intentional and follows existing practice.
- Selection: a new `--storage=walrus|pinata|local` flag (and/or `STORAGE_PROVIDER` env), layered
  on top of the existing `useLocalUploadService` / `skipIpfsUploads` logic. `walrus` takes
  precedence when set; otherwise behavior is unchanged.
- `mint-proposals.js`: mirror the same `walrus` branch in its Pinata upload path.

### 4.6 Config (env)
Backend `.env` and `blockchain/.env` (additive; existing Pinata vars untouched):
```
STORAGE_PROVIDER=pinata          # pinata | local | walrus   (default stays pinata/local heuristic)
WALRUS_NETWORK=testnet           # testnet | mainnet
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
WALRUS_EPOCHS=5                  # storage duration; or WALRUS_PERMANENT=true on mainnet
WALRUS_SEND_OBJECT_TO=0x...      # project-owned Sui address that receives the Blob objects
# Mainnet only (no public publisher): one of — our own authed publisher URL above,
# or a funded Sui signing key for TS-SDK/relay writes:
# WALRUS_SUI_PRIVATE_KEY=suiprivkey1...   # project Sui keypair, funded with SUI + WAL
```
Frontend reads `WALRUS_AGGREGATOR_URL` + default provider via the existing config-injection path
(same mechanism as `getBackendBase`). Document all of this in README + `.env.example`.

**Project Sui address:** generate a dedicated Sui keypair for this project (e.g. `sui client
new-address ed25519`), record its address in `WALRUS_SEND_OBJECT_TO` so the created `Blob` Sui
objects are owned by us (lets us renew/extend/delete blobs). For mainnet, this same keypair is
funded with SUI + WAL and used to sign writes. Keep the private key in `.env` only (gitignored).

---

## 5. Impact summary (files to add / change)

**New**
- `backend/storage/walrus.js` — Walrus HTTP client (put/read, URI builders).
- `backend/storage/index.js` — provider resolver.
- `backend/routes/walrus.js` — `POST /walrus/upload`.
- `blockchain/scripts/mint-parcels-nyc.js` — NYC city script (see §6).
- `blockchain/scripts/walrus-storage.js` — CJS Walrus helper for scripts (`require`d by mints).
- Tests (see §8).

**Changed (additive, no behavior change when provider unset)**
- `backend/index.js` — wire `setupWalrusRoute`.
- `frontend/js/ipfs.js` — `uploadViaWalrus` + `target:'walrus'` + default-provider config.
- `frontend/js/proposals.js`, `frontend/js/minted-proposals.js`, `frontend/js/og-metadata.js` —
  resolve `walrus://`.
- `blockchain/scripts/mint-parcels.js` — `walrus` branch in `createMetadataResource` + `--storage`.
- `blockchain/scripts/mint-proposals.js` — `walrus` branch.
- `backend/.env.example`, `blockchain/.env.example`, `readme.md` — new vars + Walrus section.

**Unchanged (intentionally)**
- All smart contracts (EVM + Solana) — opaque URI string, no migration.
- `backend/routes/ipfs.js`, `assets.js`, `file-storage.js` — Pinata/local paths stay as-is.
- DB schema — pointer still lives in `proposals.onchain_data`.

---

## 6. NYC parcel mint script (~40k parcels on Walrus)

**Goal:** mint every NYC parcel as a `ParcelNFT`, each with metadata stored on Walrus, then show a
proposal over NYC parcels minting + funding end-to-end with Walrus-backed metadata.

**Data source (verified):** tables `parcel_nyc_geom` (`geom_id, shape_length, shape_area, geom`)
and `parcel_nyc_unit` (`geom_id, swis_sbl_id, swis_print_key_id, sbl, primary_owner`), joined on
`geom_id`. Parcel id format **`US-NY-<swis_sbl_id>`** (see `backend/routes/parcel-nyc.js`,
`nyc-condo-owners.js` for owner resolution). Geometry served as GeoJSON via
`ST_AsGeoJSON(ST_Transform(geom,4326))`.

**Approach:** reuse the existing harness `createMintParcelsService(cityConfig)` — it already handles
batching (`--batch-size`, default 20), `--dry-run`, bbox filter, ETA logging, idempotent skip of
already-minted parcels (`ownerOf` check), owner distribution across the configured account pool
(`ACCOUNT_1..6_ADDRESS`), and calls `ParcelNFT.mintBatch`. We only supply three functions,
mirroring `mint-parcels-zg.js`:
- `buildParcelSelectionQuery({limit, offset, bbox})` → SQL over `parcel_nyc_geom ⋈ parcel_nyc_unit`,
  ordered by `geom_id`, with optional bbox `ST_Intersects`.
- `mapDbRowToParcel(row)` → `{ parcelId:'US-NY-'+swis_sbl_id, tokenId, owner(primary_owner),
  areaSqM(shape_area), geometryHash(MD5 of geom), geometry(GeoJSON), cityName:'New York' }`.
- `buildParcelMetadata(parcel, helpers)` → standard parcel metadata + NYC attributes
  (`Borough/Block/Lot` parsed from SBL, `Primary Owner`).

Run with `--storage=walrus`. For 40k:
- Start small: `--limit=20 --dry-run`, then `--limit=20` real, confirm Walrus blobIds resolve in a
  browser via the aggregator, and inspect cost from the publisher response.
- Scale up in chunks (`--batch-size`, `--limit`/`--offset` windows), **one chunk at a time**, with
  throttling + retry/backoff on publisher 429/5xx (public publisher is rate-limited). Log
  per-chunk count, elapsed, ETA, and (if available) cumulative Walrus cost. Idempotent skip means
  reruns resume safely.
- **Do not fire all 40k at the public testnet publisher unconditionally** — add a concurrency cap
  (e.g. 2–4 in flight) and inter-request delay; investigate whether a self-hosted publisher is
  needed for the full set (§9). Default to confirming throughput on a few hundred first.

**Acceptance:** after minting a slice of NYC parcels on Walrus, create a proposal over some of those
parcels through the normal frontend flow with the Walrus provider selected, mint + fund it, and
confirm the NFT `tokenURI` resolves to Walrus-hosted JSON + image in the UI.

---

## 7. Reliability / cost (per AGENTS.md conventions)

- **Verbose, timestamped logging** in the mint script: per-chunk progress, blobId, Sui object id,
  cost, ETA. Log only failures in the hot path; full detail per chunk boundary.
- **Restartable / progressive:** rely on existing idempotent already-minted skip; never lose
  progress on crash. Save work as we go (on-chain mint *is* the checkpoint).
- **Cost tracking:** Walrus publisher returns `cost` per newly-created blob. Accumulate and print
  per-chunk + running total so we can decide whether to continue before spending more — same
  discipline as our AI-batch rule.
- **Retries with backoff** on publisher 429/5xx; **fail loudly** on unexpected errors (no silent
  swallow). A blob that won't store must stop that parcel's mint (contract requires non-empty URI).
- **Small-batch-first:** never submit the full 40k without an explicit go-ahead after a costed
  trial run.

---

## 8. Testing

- **Unit (backend):** mock `fetch`; assert `walrus.js` parses both `newlyCreated` and
  `alreadyCertified`, builds `walrus://` + gateway URLs, throws on missing blobId / non-2xx.
- **Route test:** `POST /walrus/upload` with a tiny base64 PNG + metadata → asserts response
  contract keys, with the Walrus client mocked. Follow existing `backend/test/*.test.js` style.
- **Frontend:** `uploadProposalAssets({target:'walrus'})` hits `/walrus/upload`; `resolveBlobUri`
  maps `walrus://id` → aggregator URL.
- **Integration (manual / opt-in):** real testnet PUT of a small blob, GET it back from the
  aggregator, assert byte-equality. Gated behind an env flag so CI doesn't depend on the public
  publisher.
- **Mint script:** `--dry-run` over NYC produces valid metadata + `walrus://` URIs without writing;
  a `--limit=2` live run against testnet mints 2 parcels and the tokenURIs resolve.

---

## 9. Decisions & open questions

**Decided**
- **Pointer form:** store `walrus://<blobId>` on-chain/DB + also expose `gatewayUrl` (§4.0).
- **Code sharing:** separate ESM (`backend/storage/walrus.js`) and CJS
  (`blockchain/scripts/walrus-storage.js`) modules; small duplication, matches repo convention (§4.5).
- **Sui object ownership:** route created `Blob` objects to a project-owned Sui address via
  `send_object_to` so we control blob lifecycle (§4.6).
- **Dedup:** no special handling — content-addressing returns the same blobId for identical bytes;
  client handles `alreadyCertified` (§2 notes).
- **Default network:** testnet (free public publisher) for development and the 40k run.

**Open — to investigate**
1. **40k throughput:** is the public testnet publisher enough with throttle/retry + a concurrency
   cap, or do we need a self-hosted publisher (funded Sui/WAL key)? Probe with a few hundred parcels
   first; decide the realistic target count and whether the full 40k runs on testnet or mainnet.
2. **Exact cost:** confirm per-blob + total cost for the 40k via `walrus info` / the cost calculator
   before the full run (tiny blobs hit the minimum-encoded-unit floor — see §2.1).
3. **Epoch duration vs `permanent`:** testnet blobs expire (~1-day epochs). Pick an `epochs` value
   large enough to outlast our needs, or commit to mainnet `permanent=true` (real WAL/SUI +
   our own writer). Tied to #1.
4. **Mainnet writer mechanism (if/when we go mainnet):** own authed publisher vs upload relay vs
   TS-SDK write with the project signing key — decide alongside #1.

---

## 10. Phased implementation plan

1. **Walrus client + route (backend):** `backend/storage/walrus.js`, `backend/routes/walrus.js`,
   wire in `index.js`, env vars. Unit + route tests. Manual testnet round-trip.
2. **Frontend wiring:** `target:'walrus'` + default-provider config in `ipfs.js`; `walrus://`
   resolver in `proposals.js`/`minted-proposals.js`/`og-metadata.js`. Verify a proposal mints with
   Walrus metadata and renders.
3. **Mint-script support:** `walrus` branch in `mint-parcels.js` (and `mint-proposals.js`) +
   `--storage` flag; shared CJS Walrus helper.
4. **NYC city script:** `mint-parcels-nyc.js`. Dry-run → small live slice on testnet → costed
   scale-up in chunks.
5. **End-to-end verification + docs:** NYC proposal over Walrus-backed parcels mints + funds and
   renders correctly; README Walrus section + `.env.example` updates.
