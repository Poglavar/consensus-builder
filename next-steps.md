# Hackathon next steps

What's left, roughly in priority order. Each item says why it matters, what it buys, and how big it is.
Last updated 2026-09-23, after deploying `97122e6` and upgrading both devnet programs.

## Must do for the submission

### 1. Record a real human-wallet action on devnet
Make a donation or pledge and a YES/NO forecast from a normal browser wallet, then turn the audit's `human_agent_activity_matrix` check from advisory into required.
- **Why:** it is the audit's only warning; the "humans and agents share one system" claim has no human proof yet.
- **Payoff:** high. It completes the actor matrix in the Activity explorer.
- **Effort:** small. About 15 minutes of clicking, plus one change in the audit.

### 2. See the prospective court market through
Leave the open market alone. When a matching court record arrives, the hourly resolver settles it; then check that the settlement artifact shows the full order: `stakes < close <= source time <= attestation <= resolution < claim`.
- **Why:** it is the strongest claim: a market settled from evidence that didn't exist when people bet.
- **Payoff:** very high if a record arrives in time. If none does, it stays visibly pending, which is still honest.
- **Effort:** minimal. Only monitoring; never fake a record or loosen the rule.

### 3. Get an outside payer for paid proposals
The verified-facts listing now reports 2 unique payers; the paid-proposal listing still reports 1 (every call came from project personas). A second project wallet would only be self-dealing under another name, so this needs an outside participant or agent to publish one paid proposal.
- **Why:** with one payer, demand for paid proposals looks self-generated.
- **Payoff:** medium.
- **Effort:** trivial once someone outside is willing; out of our hands until then.

## Do if time remains

### 4. Judge path and submission package
- Record a 90–150 s demo: discovery → action → shared timeline → evidence → payout.
- Do one run from a fresh browser and wallet with no operator knowledge.
- Freeze the URLs, run every suite, and capture a final proof manifest.
- **Why:** judges spend minutes, not hours; a clear first path decides how much they actually see.
- **Payoff:** high.
- **Effort:** medium. About half a day: the video and the dry run need a person; the rest is a final re-run.

### 5. Remaining contract and release evidence
- Verified builds with `solana-verify`: rebuild both programs in the official Docker image, redeploy from that build, and register the verification so explorers show a "Verified build" badge. Needs ~6 SOL of temporary buffer rent; slow on an arm64 Mac, because the image is x86-only.
- Decide whether `void_pledge` and `release_donations` should stay callable by anyone. Funds only go to the stored beneficiary or owner, but this is a design choice worth stating.
- Keep "unaudited, devnet only" prominent.
- **Why:** a reviewer should be able to link source → deployed program → tests without trusting the operator.
- **Payoff:** medium for the hackathon, required before anything beyond devnet.
- **Effort:** medium. Half a day, mostly build time.

### 6. Decide how land forks relate to their original
"Fork with changed land" is built and live, but it still behaves like a counterproposal: the submit button says "Create replacement proposal", and applying a fork parks the original even when the land barely overlaps. Designs (parks, buildings) also carry their geometry over unchanged instead of being re-fitted to the new parcels.
- **Why:** a fork on different land is arguably a competing proposal, not a replacement; parking the original may surprise its author.
- **Payoff:** medium. It makes competing proposals over overlapping land coherent.
- **Effort:** small once decided; the lineage record (`landFork`) already carries the relation and counts.

### 7. Fix the flaky rate-limit test
`backend/test/write-rate-limit-exemptions.test.js` fails intermittently with `ECONNRESET`/`socket hang up`, even when run alone; the failing case changes between runs.
- **Why:** a suite that is red at random trains everyone to ignore red.
- **Payoff:** low to medium.
- **Effort:** small. Likely the test's own request burst; reuse one agent/keep-alive or serialise the requests.

## After the hackathon

### 8. More evidence sources
Add them through the existing adapter contract, in this order:
1. permit/register source;
2. imagery or building-footprint change;
3. OSM provenance verifier;
4. text extraction, used only as supporting evidence.

Never let an LLM pick the final outcome.
- **Why:** more resolvable question types.
- **Payoff:** high long-term, low for the hackathon.
- **Effort:** large. Roughly a week or more per source.

Also later: mainnet preparation after contract review, governance/tokenomics, more cities, and broader LLM autonomy.
