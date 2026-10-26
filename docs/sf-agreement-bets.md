<!-- Reviewable intents and prepared, unpublished devnet demonstrations for the Candlestick designs. -->
# Candlestick: bets on two agreements

The featured pair is two independent YES/NO bets: **Will the Courtyard Candlestick agreement execute
on-chain by its deadline?** and **Will the FivePoint Candlestick agreement execute on-chain by its
deadline?** Both can execute, or neither can. Their prices need not add to 100% across agreements.

YES requires recorded execution, after the required approvals, verification and funding, by the
deadline. Expiry or missing the deadline settles NO. Cancellation settles VOID and pays half per
share. Execution does not establish a planning approval, building permit or completed construction.

The [reviewable records](sf-agreement-bets.json) preserve each source design's existing expiry as the
proposed deadline, at whole-second resolution. The agreements are prepared as explicitly labelled
devnet demonstrations with simulated rights. Their prepared agreement and plan CIDs are not
publication receipts; the Pinata upload failed with HTTP 403 `pinning-quota-exhausted`. Neither
agreement was indexed or minted, and neither market exists. The `agreementCid`, `agreementAccount`
and `marketAccount` fields therefore remain null. Existing source hashes and deadlines are retained.

The source inventory on 25 October 2026 found two imported design records:

| Source record | Stored geometry | Proposed deadline, UTC |
| --- | --- | --- |
| `sf-candlestick-courtyard-2026` | 1,105 building footprints | 9 October 2027, 08:19:27 |
| `sf-candlestick-fivepoint-2024` | 99 modeled volumes | 9 October 2027, 09:01:31 |

The prepared design records retain their original building geometry and all 116 original parcel references. Each design
has since been published under a new design CID; the FivePoint importer's newer 110-volume output
was not substituted while retaining the original identity. Current site binding includes 118
Courtyard parcels and 117 FivePoint parcels. The two open-ground calculations produce 122 and 121
output pieces, respectively, with about 76,206.6 m² of modeled open ground apiece. That ground is
geometry outside the bound parcels, not a claim of legal ownership. Each site was unioned with
its imported building footprints to contain their full extent; the authored building geometry is
unchanged.

The simulated rights snapshot assigns each input parcel to one demonstration wallet. This is not
landowner consent, acceptance by a real counterparty, or an endorsement by the developer or concept
author. The labels and names describe design provenance only.

On 26 October 2026, the prepared plan and agreement records could not be pinned because the storage
service returned HTTP 403 `pinning-quota-exhausted`; neither agreement was published or minted and
neither appeared in the market index. See the dated [preparation and validation record](sf-demo-validation-2026-10-26.md).
At that observation, the demonstration wallet held 58.723938
devnet USDC against a combined canonical market seed of 138.629440 USDC, a 79.905502 USDC shortfall.
This is a dated balance observation, not a current-balance guarantee. Publication, indexing, minting
and funding remain prerequisites to exposing these executable devnet agreement bets with simulated rights.
