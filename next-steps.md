# Hackathon next steps

What's left, roughly in priority order. Each item says why it matters, what it buys, and how big it is.

## Must do for the submission

### 1. Record a real human-wallet action on devnet
Make a donation or pledge and a YES/NO forecast from a normal browser wallet, then turn the audit's `human_agent_activity_matrix` check from advisory into required.
- **Why:** it is the audit's only warning; the "humans and agents share one system" claim has no human proof yet.
- **Payoff:** high. It completes the actor matrix in the Activity explorer.
- **Effort:** small. About 15 minutes of clicking, plus one change in the audit.

### 2. Upgrade the two devnet programs with the vault fix
The source fix is merged: all three vaults (`ProposalPledge` donation escrow, `ProposalMarket` proposal and external markets) now use `init_if_needed`, and the pre-created-vault tests pass locally. The deployed devnet programs still have the old `init` code, so anyone can still block donations or a market by creating its vault first. The upgrade authority `AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ` holds 0.18 SOL; each upgrade needs ~2.8 SOL of temporary buffer rent (mostly refunded). Get SOL from faucet.solana.com, extend `proposal_pledge` first (the new binary is 398,040 bytes; the account holds 395,576: `solana program extend 1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g 4096`), upgrade both one at a time (`anchor upgrade target/deploy/<name>.so --program-id <id> --provider.cluster devnet`), then update the slots and binary hashes in `backend/routes/hackathon-proof.js` and `docs/protocol.md`.
- **Why:** until then the live programs don't match the source, and the attack is live.
- **Payoff:** high for credibility.
- **Effort:** small once the SOL is there. About 30 minutes.

### 3. See the prospective court market through
Leave the open market alone. When a matching court record arrives, the hourly resolver settles it; then check that the settlement artifact shows the full order: `stakes < close <= source time <= attestation <= resolution < claim`.
- **Why:** it is the strongest claim: a market settled from evidence that didn't exist when people bet.
- **Payoff:** very high if a record arrives in time. If none does, it stays visibly pending, which is still honest.
- **Effort:** minimal. Only monitoring; never fake a record or loosen the rule.

### 4. Confirm Bazaar shows two unique payers
Check that Coinbase's catalog has picked up the independent-client purchase. If it hasn't, ideally get an outside participant or agent to make one call.
- **Why:** with only one payer, the discovery demand looks self-generated.
- **Payoff:** medium.
- **Effort:** trivial to check. Getting an outside payer depends on other people.

## Do if time remains

### 5. Judge path and submission package
- Put the canonical case first in the Demo Center.
- Record a 90–150 s demo: discovery → action → shared timeline → evidence → payout.
- Add a short "before vs. built here" comparison against baseline `3ee1855`.
- Do one run from a fresh browser and wallet with no operator knowledge.
- Freeze the URLs, run every suite, and capture a final proof manifest.
- **Why:** judges spend minutes, not hours; a clear first path decides how much they actually see.
- **Payoff:** high.
- **Effort:** medium. About a day, mostly the video and the dry run.

### 6. Remaining contract and release evidence
- Publish each program's upgrade authority and IDL checksums next to the binary hashes already in the proof manifest.
- Make program builds reproducible if the tooling allows.
- Decide whether `void_pledge` and `release_donations` should stay callable by anyone. Funds only go to the stored beneficiary or owner, but this is a design choice worth stating.
- Keep "unaudited, devnet only" prominent.
- **Why:** a reviewer should be able to link source → deployed program → tests without trusting the operator.
- **Payoff:** medium for the hackathon, required before anything beyond devnet.
- **Effort:** medium. About a day.

### 7. "Fork with changed land set" action
Counterpropose currently always inherits the exact parcel set; add an explicit action that forks the proposal onto a changed set.
- **Why:** it is the last missing piece for first-class parcel sets.
- **Payoff:** low to medium.
- **Effort:** small to medium.

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
