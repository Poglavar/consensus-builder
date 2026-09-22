<!-- This manifest defines the reviewable scope of the Colosseum World's Fair build. -->
# Hyperstition: Markets for Possible Cities

**An Urban Game Theory project by Consensus Builder · Colosseum World's Fair 2026**

Follow the project on X: [@UrbanGameTheory](https://x.com/UrbanGameTheory)

Urban Game Theory is a long-running project. This branch isolates the work built for the
Colosseum World's Fair hackathon so it can be reviewed independently of the existing city,
parcel, ownership, proposal-rendering, and Lens foundations.

> Humans and agents imagine, propose, fund, and forecast changes to real parcels. Public records
> decide which possible futures became real.

The hackathon framing is **verifiable hyperstition**: a proposed future can mobilize attention,
capital and action, but it cannot declare itself true. A precommitted evidence recipe and independent
public records determine whether it was realized.

## Review boundary

- Pre-hackathon baseline: `3ee1855` (`Record the GUP scenario integration direction and inventory`)
- Hackathon branch: `colosseum-worlds-fair`
- First hackathon commit: `d29ca3e` (`Add proposal_market parimutuel program with client and localnet tests`)

GitHub comparison:

<https://github.com/Poglavar/consensus-builder/compare/3ee1855...colosseum-worlds-fair>

Local review commands:

```sh
git log --reverse --oneline 3ee1855..colosseum-worlds-fair
git diff --stat 3ee1855...colosseum-worlds-fair
git diff 3ee1855...colosseum-worlds-fair
```

## Documentation and reproducibility

- [`readme.md`](readme.md) — product thesis, live judge links, repository map, and quick verification
- [`docs/architecture.md`](docs/architecture.md) — concise current architecture and deployment boundary
- [`docs/hackathon-build.md`](docs/hackathon-build.md) — checkout, install, test, local-view, and optional Solana build instructions
- [`docs/protocol.md`](docs/protocol.md) — program IDs, IDLs and schemas, evidence adapter contract, and security/trust assumptions
- [`LICENSE`](LICENSE) — Apache License 2.0

## Built for the hackathon

1. **Agent proposal market** — a Solana parimutuel market program, client, IDL, and localnet tests.
2. **x402 pay-to-propose** — paid proposal submission with hosted-facilitator settlement,
   replay protection, database persistence, and exact-resource Bazaar discovery.
3. **Agent interface and demo runner** — machine-readable discovery, agent quickstart,
   deterministic paid submission, persona planning, batch selection, minting, and staking.
4. **Agent provenance in the product** — proposal records and UI identify agent-created proposals
   and link the relevant on-chain transactions.
5. **Transaction explorer** — store-backed incremental Solana transaction sync and proposal-aware
   decoding for the demo flow.
6. **Safe proposal review** — Details is read-only; Counterpropose/Fork creates a separately editable
   clone instead of mutating someone else's proposal.
7. **Proposal funding** — one devnet Solana program and shared browser/agent codec for two distinct
   commitments: funded donations held until execution (and refundable on cancellation/expiry), plus
   revocable soft pledges that move USDC only when their owner fulfils them after execution.
   Deployed as [`1jES…6g`](https://explorer.solana.com/address/1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g?cluster=devnet),
   with live [soft-pledge](https://explorer.solana.com/tx/Fs4neKgYxY5QmV7FwovJg1Ay8X5mecVafZkW4N87NSfC9hGqs1sTm2gYX5ypjdyAvWPhCwF9vUfnquyBiNmdbGT?cluster=devnet)
   and [funded-donation](https://explorer.solana.com/tx/dFJn5idbgQy85NmJ3bpGTPW284nYGifec9TKy98pP4PHUsgY3WpqU5M5HnQ4UNxMTrdeDo5rp6ShdsLZ346fbH3?cluster=devnet)
   proof transactions.
8. **Complete funding lifecycles** — a guarded devnet script proves both outcomes with a separate
   supporter wallet. The cancelled path [refunds its donation](https://explorer.solana.com/tx/4ZzwYiHiM4kbt5zypFw1WRuji1rLkydwsfm3QWLKVLh8RSMiP4bX9axX3PCNYYvXgNyuDveA7Qa2cx69xuzdD9af?cluster=devnet)
   and [voids its pledge](https://explorer.solana.com/tx/4yPScLbBHM1KzxsrYYBvSXnA4ZPfx3DuDTEoJwMFmudRJQhP89tghvyfk6qpXVsc2aej3ZSbq5mNGGedB7ZwDvbX?cluster=devnet);
   the executed path [releases its donation](https://explorer.solana.com/tx/3s1v1sGhPbdN2JzydhNDhLTY1M6mW5uFntXRkGbmx2cyPHGPeVuks93HWZtjTQfPFbRhFj4FhQR6vWahNMvawLn5?cluster=devnet)
   and [fulfils its pledge](https://explorer.solana.com/tx/5NUeperNd6wu3ZizQW7ASWZtfa2nFKjevnGeVtqAeFWhFyfDbcUBKw5enRwKcTRAyZ1yHNpeEqWC8Vs2dyp94UgA?cluster=devnet).
   Run it with `cd blockchain/solana && node scripts/proposal-support-lifecycle.mjs --live`.
9. **One agent/action/activity model** — browser algorithms and the server agent runner use the same
   controller/action/event contract, including confirmed human wallet actions. The Activity explorer
   combines live and simulated events, independently filters source/controller/action/result/search,
   and keeps wallet/model/cost/run provenance in expandable details instead of visually segregating
   actors throughout the product.
10. **Fresh end-to-end LLM agent proof** — `densifier-01` used Claude to select and explain one
    rule-backed Rudeš building proposal (model cost `$0.0054`), [minted it on Solana devnet](https://explorer.solana.com/tx/5oFxz5jQwtVVmQmybPUBq1Zjifiq7tpvTZqs2ZYEKQ22NYZHP9Bb1LDXiPRX4QSHSZ8ByrnyXfgfMK2f9tTaVDXN?cluster=devnet),
    [paid `0.05 USDC` through x402](https://explorer.solana.com/tx/5bZkHoEaP1jiGTNEAJXHh5uhHvGevekwRsyAMn1MyKTXFheUqYmj8h5hYU9n1GccBqj5He6u6vgK4HS2HCoSV4n1?cluster=devnet),
    published [proposal 763](https://api.urbangametheory.xyz/proposals/763), then
    [staked `0.25 USDC` YES](https://explorer.solana.com/tx/scK9S8NqVDmh8GE1NNksEJwFyeam2hB4dVL4xPYFp4jNENKWX6HL9kaU9wdQEwpztQwBCmx3pJ1kXRVR5MsovDG?cluster=devnet).
    The public Activity explorer shows all three actions from the same structured event stream.
11. **Bounded daily autonomy and wallet-grade support UX** — the opt-in PM2 persona schedule uses
    an auditable `$0` deterministic controller and stores its complete decision policy, rationale,
    x402 payment id and every transaction; it refuses more than one proposal, four possible signed
    actions or `0.35 USDC` per day by default. The one-off LLM proof remains available as a separate,
    explicit controller mode. Human donation and pledge flows show wallet balances, distinguish escrowed
    funds from soft commitments, prevent duplicate submission, expose submitted/confirmed states,
    preserve explorer links on uncertain confirmation and batch large refunds safely.
12. **Wallet prediction-market experience** — proposal Details reads the deployed parimutuel market,
    shows YES/NO pools and implied odds, lets a connected human open the single market, stake devnet
    USDC on either side, permissionlessly resolve it from the proposal's terminal on-chain state and
    claim winnings or empty-winning-pool refunds, with explicit signature/confirmation states and
    transaction links.
13. **Neutral actor and run explorer** — the former simulation-only agent statistics surface now
    profiles people, algorithmic controllers and LLM controllers from the same activity envelopes.
    It drills into proposal/support/market actions, rationales, exact model-ledger cost, run/batch ids
    and Solana transactions; a standalone judge-friendly view is also available at
    `/actor-explorer.html` without creating a second agent runtime.
14. **Live Hackathon Demo Center** — `/hackathon-demo.html` reads the public x402 recipe, run ledger
    and unified activity feed into a five-minute judge path. It never substitutes the historical LLM
    proof for a deterministic run: the algorithm card remains pending until a recent completed
    algorithmic checkpoint exists, then updates automatically.
15. **Deterministic supporter persona** — `supporter-01` is a second actor role inside the same
    persona/controller/checkpoint/activity system. It deterministically chooses an active minted
    proposal by somebody else and can sign an on-chain soft pledge, funded donation or market stake;
    the initial low-risk schedule uses one `0.10 USDC` soft commitment at 02:15 UTC. Its first live
    run selected another actor's proposal and recorded this
    [pledge transaction](https://explorer.solana.com/tx/5KxyA5tpSxbXiYodbwmhxPdtUubRXhGJ9cG7nnJQfpaYHbkcfX4ncMRux8nFjhfau1VMmzzpGdX6iFwTb1ZG4nUu?cluster=devnet).
16. **Explicit prediction-market lifecycle** — Details now states the contract’s actual evidence
    rule, permissionless resolver, locked-stake behavior, market account and payout/refund rule. It
    also exposes the crucial boundary that an app-level `Expired` label is not `Cancelled` on-chain
   and therefore cannot silently resolve NO.
17. **Reproducible hosted discovery proof** — `/agent/discovery` queries the configured Coinbase
    facilitator with server-side credentials and returns the exact Bazaar record for the paid
    proposal endpoint. The Demo Center links this record instead of treating configuration as proof.
18. **Minimal land-event oracle** — `proposal-lifecycle-v1` snapshots terminal Solana proposal
    accounts into source-timestamped `proposal_lifecycle` records with account-data hashes, source
    transactions and the ProposalNFT program as attester. The sync is idempotent and dry-run-first.
19. **Market oracle recipes** — every proposal market exposes a subject-specific hashed recipe:
    ProposalNFT `Executed → YES`, `Cancelled → NO`. Proposal Details shows the declaration and the
    matching terminal event while the market program remains the final permissionless verifier.
20. **Demo recovery path** — the Demo Center loads each evidence source independently, keeps partial
    failures visible, links devnet SOL/USDC faucets, and documents a browser-local simulation reset
    that does not touch public proposals or on-chain records.
21. **Privacy-preserving public-record oracle bridge** — the public API reports aggregate health for
    the existing Croatian court oracle and links its public Solana Attestation Service schema without
    republishing decision identifiers, parties, quotes, or parcel identifiers.
22. **Recipe-bound external resolver** — a new `ExternalMarket` account commits the recipe hash,
    SAS credential and schema, trusted issuer, parcel hash, YES/NO operation hashes, and close time
    before trading. After close, anyone can submit the matching SAS account; the program parses the
    public payload, derives the outcome, and records the evidence address and byte hash. The legacy
    deployed market layout is unchanged. Source, IDL, browser codec, public recipe endpoint, and
    parser/contract tests are complete. The compatible upgrade and first economic lifecycle are live
    on devnet.
23. **Temporal-integrity proof** — public metadata now classifies the first court settlement honestly
    as a retrospective integration proof because its attestation predates the market. A guarded
    two-phase runner opens and stakes a market without reading any attestation. The V2 recipe and
    parser append the official `sourceObservedAt`, and the market guard requires both that timestamp
    and the attestation's first transaction to follow market close. Rust and API contract tests are
    complete. The V2 schema, upgraded verifier and court-attester rollout are live, with 35
    source-timed devnet attestations proving the ingestion path. A new V2 market is open and staked
    on both sides before qualifying evidence; only a genuinely later matching record—one published
    after its committed close—remains for the prospective settlement proof.
24. **Paid oracle facts over x402** — `GET /agent/oracle/facts` checks that a verified terminal fact
    exists before asking for payment, then sells a machine-ready bundle containing the source-hashed
    event, its subject-specific recipe, and explicit integrity checks for 0.01 devnet USDC. The route
    declares query/output schemas through Bazaar and has its own hosted-catalog proof endpoint. The
    underlying event feed remains free so buyers can independently audit what they received.
25. **One Lens evaluator for every source** — the paid fact path now runs through a deterministic
    recipe evaluator that counts each trusted attester once, supports thresholds and required source
    classes, detects equivocation or competing outcomes, and enforces challenge windows. Synthetic
    permit + imagery + OSM policies are contract-tested; connecting those collectors remains future
    work rather than introducing separate agent or oracle systems.
26. **One-command public proof audit** — `npm run audit:hackathon` reads only the public HTTP
    contracts a judge or outside agent can see and verifies exact Bazaar listings, recent algorithmic
    proposer and supporter actions, a source-hashed lifecycle event, court-attestation health, and
    the two-sided external-market payout. Required failures produce a non-zero exit code; chronology
    metadata is reported separately so a retrospective proof cannot masquerade as a forecast. If
    the live prospective market settles, the same audit requires its evidence hash and address,
    first-attestation transaction, resolution, claim, and strict timestamp ordering.
27. **One proposal-to-reality timeline** — read-only proposal Details now combines the same neutral
    activity envelopes used by humans and agents with the proposal lifecycle oracle. Proposed,
    backed, forecast and resolved stages stay visibly pending until matching public evidence exists,
    and every transaction-backed stage links to Solana Explorer.
28. **One MCP action surface for outside agents** — a standards-based stdio server exposes twenty-two
    proposal, activity, funding, forecast, and verified-fact tools. It calls the existing x402 and
    Solana signer adapters rather than introducing a second runtime, so deterministic and LLM
    controllers differ only in how they choose actions. Reads are safe by default; devnet writes
    require an external low-value key, an explicit process-level live switch, per-call confirmation,
    and a pre-signing USDC cap.
29. **Clean-room x402 consumer proof** — an example client imports only the public x402 and Solana
    SDKs, discovers the paid verified-fact resource through the hosted Bazaar proof, enforces its own
    payment cap, and independently checks the purchased bundle against the free event feed. A second
    low-value project wallet settled 0.01 devnet USDC in
    [`3T7m…TGPn`](https://explorer.solana.com/tx/3T7mg2f5FRk6uFND6eyRKrS5VyHviizk4vmPqB1zxVJbmnz4f1nxaMjXxGi4XEh8JMMesPXNbaaCNzgFQxRxTGPn?cluster=devnet)
    and verified the canonical case's source hash without importing an internal client.
30. **Canonical parcel-set identity** — every serialized proposal now carries a stable hash over its
    jurisdiction, cadastral authority and sorted real parcel IDs, plus capture/reference time and an
    optional geometry hash. The canonical case consumes the same builder, so “same land, competing
    possible futures” is a queryable product identity rather than deck language.
31. **Same-land proposal comparison** — read-only Proposal Details presents the canonical set identity
    and groups exact-set competitors, containing or contained sets, and partial overlaps with shared
    parcel counts. Choosing an alternative reuses the same whole-set map highlight and Details flow;
    cross-jurisdiction local parcel-number collisions are explicitly excluded.
32. **Outcome-based operations proof** — the land-event materializer writes an atomic success/failure
    artifact with event counters, and `/hackathon/operations.json` combines it with proposer/supporter
    checkpoints and resolver outcomes under explicit freshness windows. The public audit reads that
    redacted endpoint, so a running PM2 process alone is never presented as proof that a scheduled job
    succeeded.
33. **Unambiguous release identity** — the backend manifest reports its deployed Git commit, the
    frontend deploy publishes its own commit and cache-busted build number at `/release.json`, and
    each mutable devnet program is identified by ProgramData address, last deployment slot and the
    SHA-256 of the binary read back from Solana. This avoids presenting one branch SHA as if it
    described three independently deployed artifacts.

### Live external-market integration proof

- Program upgrade: [`66WW…RDeg`](https://explorer.solana.com/tx/66WWKcHj7x6FXmtoKhkBP1oQobJZNq8YJP9Brx5dFgSmMuLQ1hGpNWgGdwwkrFJuUfyJE7QJRVZx1gZ7ouWGRDeg?cluster=devnet)
- Recipe-bound market: [`5wyJ…N8QM`](https://explorer.solana.com/address/5wyJ7XjbnoPUaDgaHAttdhdS38VmHf1p3jGwwVUeN8QM?cluster=devnet)
- Two-sided stakes: [YES](https://explorer.solana.com/tx/fvSPdGu3DTpJ9MNpQX5iFw8MyjFkqmrdKjoSn9LfbXEYtAPjJTQT7vLcc1HDvicEZTcDwsw55MG7KKCaSUg7bnE?cluster=devnet) and [NO](https://explorer.solana.com/tx/4nVnKJAFnPfqk6fPqa1cK6GQVQxSzZFd9tmWUAaZE79ZVRKZqyfWhawPy1SenkfctLpormsKXKY2GJLSQLiQp7M4?cluster=devnet), 0.01 devnet USDC each
- Permissionless SAS resolution: [`39sN…LETJ`](https://explorer.solana.com/tx/39sN9w1Pj75Hp7vjxQzaNQ89uRxSsTjFFoE4GCPfWXMU7v1koLEUtV6odzUfQcxuZJNWwXhs1UWKswSMRQbdLETJ?cluster=devnet)
- Winning 0.02 USDC claim: [`2Ht5…RNzJ`](https://explorer.solana.com/tx/2Ht5ZdVHZuFdEu5PkhkQxqNjoPQSBM9jeGaWKPiWzpLjbWtahP5bhKh3offRcvKDVN6JBFMy6piozWnEExy3RNzJ?cluster=devnet)

The proof publishes commitments and transaction addresses, not the decoded parcel, decision, or
legal text. The market stores the complete SAS account hash
`6a2dcae7…b04eac789`, so the submitted evidence remains independently verifiable.
The attestation first appeared on-chain in May 2026, before this market opened in September 2026.
Accordingly this is labelled a **retrospective integration proof**: it proves recipe binding,
two-sided staking, deterministic resolution and payout, but not forecasting. The prospective runner
below rejects that ordering.

## Pre-existing platform foundations

The underlying cadastral map and parcel fabric, proposal editor and 3D visualization, ownership
model, Lens trust concept, and the broader Urban Game Theory application predate the hackathon.
The hackathon work composes those foundations into an agent-discoverable, paid, attributable, and
fundable proposal workflow; it does not claim the whole application as new.

## Judge demo path

Start at [`/hackathon-demo.html`](https://urbangametheory.xyz/hackathon-demo.html); its pending/live
states come from public evidence rather than a scripted success screen.

The same proof is available without the UI: `cd backend && npm run demo:judge` audits the public
contracts and prints the judge path. `/hackathon/proof.json` declares the branch, baseline, programs,
surfaces and trust boundary; `/hackathon/operations.json` publishes redacted scheduler outcomes and
freshness; `/oracle/markets/prospective/status` publishes the prospective market
commitment and resolver health while pending. After settlement it also publishes the redacted
evidence address/hash, ordered source and chain timestamps, resolution, and claim, while keeping
parcel and operator details private.

`/hackathon/cases/:proposalId` composes one proposal into a read-only, data-derived graph of its
parcel-set identity, actors, support, forecast pools, lifecycle decision, oracle evidence,
resolution and settlement. The graph keeps parallel actions parallel and leaves absent stages
explicitly pending, blocked or unavailable.

The canonical Borovje case anchors three real cadastral parcels. The two existing deterministic
personas minted and paid for the proposal, funded its donation escrow, recorded a revocable pledge,
and staked both YES and NO. Its owner then cancelled it, the lifecycle materializer published a
source-hashed event, another actor resolved the market NO, the donation was refunded, the pledge
was voided and the winning NO position was claimed. The aggregate therefore derives all seven
stages from public data rather than presenting a scripted success state.

1. Discover the paid proposal capability through the x402/Bazaar metadata.
2. Run an agent proposal through payment, persistence, and its on-chain transaction link.
3. Open the resulting proposal in read-only Details and fork it with Counterpropose.
4. Donate or pledge devnet USDC, inspect the distinct escrow/commitment states, and find the human
   action beside algorithmic and LLM actions in the same Activity explorer.
5. Resolve the lifecycle by releasing an executed proposal or refunding a cancelled/expired one.
6. Verify the court oracle's aggregate health and public SAS schema, then open the live external
   market integration proof, its two-sided stakes, permissionless resolution, chronology
   classification, and winning claim linked above.

The prospective runner is safe to schedule with `--settle`: before close it reports the remaining
time; afterward it discovers matching V2 SAS attestations and remains a no-op until one was both
published and attested after close. Conflicting outcome evidence fails closed. Only `--live` can
submit the resolution and claim transactions.

If a live dependency is slow, use the Demo Center's retry button. The resettable fallback is the
map's **Game → Enable game mode → New Game** flow; it clears browser-local simulation state only.
