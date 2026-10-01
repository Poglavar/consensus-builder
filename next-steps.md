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

## After the hackathon

### 7. More evidence sources
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

## Open questions from the map-UI rework (branch `new-ui`, 2026-10-01)

Found during the headed test pass; each needs a decision before it is built or removed.

- **Road clearance and cross-section editor has no entry point.** `openCorridorProfileEditor` lost its only
  button in ae43c028 ("read-only details"); it still works from the console. Decide where it lives: on the
  road segment's handles, or as a fork-to-edit action on a placed road.
- **Proposal compare is dead code.** `showProposalCompareModal` has no caller (on `main` too). Wire it in
  (e.g. from the Proposals list or the "At this spot" stack) or delete it.
- **Guest rules are inconsistent.** One-click park/square/lake, Freeform and Detached work for a guest, while
  Offer and Fork require personalizing first. Pick one rule for all creation actions.
- **Docked panel on phones is cramped.** The parcel/details panel is 33vh and covers the Game pill; only
  about two build-palette rows are visible. A taller bottom sheet with a drag handle is the likely fix.
- **One agent shows as three actor profiles.** Runs say `llm`, the chain decoder says `algorithm`, older runs
  have no wallet, and the actor key includes the controller. Either key identity on wallet-or-id only, or
  fill run wallets from the address book on the backend.
- **Explore city needs a no-cadastre proposal anchor.** Explore is look-only until proposals can exist
  without parcels (the parcel-optionality work).
- **Photo view and 3D buildings in explore.** Both go through city-specific code, so they are hidden there.
- **Search does not find local (unpublished) proposals**, only server ones, and keeps the query after a
  result is opened.
- **Smaller items:** the Actors view's own search box and filter are English-only (drop it or translate);
  `css/actor-explorer.css` has unscoped `details`/`summary`/`pre` rules that leak into the map app; the
  lens console's issued counts don't refresh after a verdict; `canton-read.js` hardcodes `:3000` for NYC on
  localhost; tab order goes mode strip → user bubble → search box (search should come first); the "⌘K"
  chip shows on touch devices; the user bubble writes the user's own name via `innerHTML` (escape it);
  the user bubble is squeezed at 320px; many in-app modals still register their own Escape listener (a
  shared modal helper would end that bug class); the How-to guide screenshots still show the old sidebar.
- **Not yet tested:** real wallet signing, publishing to the backend, AI image generation (costs money),
  geolocation success, owner-offer and bids cards (no local data), and the Playwright suites (updated for
  the new UI, never run).
