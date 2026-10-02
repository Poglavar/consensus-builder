# Next steps

## Before submission

1. **Run a real-user smoke journey.** From a fresh browser profile, explore parcels and buildings, create and share a proposal, open its link in a second profile, apply it, and reload. Cover mobile and complete one real devnet wallet action; record any first-run or mobile failures.
2. **Complete live evidence setup.** Finish the attester-service and schema setup, capture a human-wallet donation or pledge and YES/NO forecast, and obtain one paid-proposal publication from an outside participant. Make the audit require human activity evidence once it exists.
3. **Prepare the judge package.** Record a 90–150 second workflow demo (discovery → action → shared timeline → evidence → payout), do a fresh-profile run without operator guidance, freeze the URLs, and capture a final proof manifest.
4. **Recheck Google indexing.** Confirm sitemap ingestion and `/urban-planning.html` indexing in Search Console; the sitemap report still needs resolution. Keep visible planning copy vendor-free.
5. **Publish workflow examples.** Post a short screen recording and a few concise posts, each showing one complete planning workflow with a direct map/share link and an invitation to try it.
6. **Monitor the court market.** Leave the open market unchanged. If matching court evidence arrives, verify the settlement artifact preserves `stakes < close <= source time <= attestation <= resolution < claim`; keep it pending if no matching record arrives.

## Remaining product work

7. **Choose and restore the road cross-section editor entry point.** Decide whether it belongs on road-segment handles or as a fork-to-edit action on a placed road, then implement that path.
8. **Improve the phone panel.** Replace the cramped 33vh docked panel with a taller bottom sheet and drag handle; ensure the Game control and build palette remain usable.
9. **Unify agent identity in Activity.** Choose wallet-or-id as the actor key, or populate run wallets from the backend address book, so one agent does not appear as multiple profiles.
10. **Finish proposal discovery in Explore.** Add an anchor for proposals without cadastre parcels, enable photo view and 3D buildings there, and include local unpublished proposals in search while clearing the query after opening a result.
11. **Resolve smaller UI issues.** Translate or remove the Actors search/filter; scope `actor-explorer.css`; refresh lens-console issued counts after verdicts; remove the hardcoded NYC localhost port; correct tab order; hide the ⌘K hint on touch; escape the user name before rendering and fix its 320px layout; centralize modal Escape handling; refresh How-to screenshots.

## After submission

12. **Add evidence adapters** in this order: permit/register, imagery or building-footprint change, OSM provenance verification, then text extraction as supporting evidence only. Keep final outcome selection deterministic and evidence-based.
13. **Review contract and release readiness.** Decide whether `void_pledge` and `release_donations` should remain callable by anyone; complete verified builds and explorer registration when practical. Keep “unaudited, devnet only” prominent, and complete contract review before any mainnet work.
14. **Plan broader expansion.** After contract review, assess mainnet preparation, governance/tokenomics, additional cities, and broader LLM autonomy.
