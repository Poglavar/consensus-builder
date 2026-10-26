<!-- Published, active and funded devnet demonstrations for the Candlestick designs. -->
# Candlestick: bets on two agreements

The featured pair is two independent YES/NO bets: **Will the Courtyard Candlestick agreement execute
on-chain by its deadline?** and **Will the FivePoint Candlestick agreement execute on-chain by its
deadline?** Both can execute, or neither can. Their prices need not add to 100% across agreements.

YES requires recorded execution, after the required approvals, verification and funding, by the
deadline. Expiry or missing the deadline settles NO. Cancellation settles VOID and pays half per
share. Execution does not establish a planning approval, building permit or completed construction.

Both agreements and their plans are published and indexed. Each agreement has an active on-chain
account, and each market is open and funded with 69.314720 devnet USDC. The pair record lists the
published CIDs, account addresses and market addresses. Both remain unresolved: no execution or
claim proof has been recorded. A small operator-controlled USDC buy and partial sell, plus isolated points buy/sell and reload checks, passed. The simulated rights snapshot is a demonstration input and does not
represent real owner rights, consent or acceptance.

The [reviewable records](sf-agreement-bets.json) preserve each source design's existing expiry as the
deadline, at whole-second resolution. Source hashes, parcel IDs and imported building geometry are
retained. The source inventory on 25 October 2026 found two imported design records:

| Source record | Stored geometry | Deadline, UTC |
| --- | --- | --- |
| `sf-candlestick-courtyard-2026` | 1,105 building footprints | 9 October 2027, 08:19:27 |
| `sf-candlestick-fivepoint-2024` | 99 modeled volumes | 9 October 2027, 09:01:31 |

The records retain all 116 original parcel references. Current site binding includes 118 Courtyard
parcels and 117 FivePoint parcels. The FivePoint design keeps the imported 99 modeled volumes; the
newer 110-volume importer output was not substituted while retaining the original identity. The
two open-ground calculations produce 122 and 121 output pieces, respectively, with about 76,206.6 m²
of modeled open ground apiece. That ground is geometry outside the bound parcels, not a claim of legal
ownership. Each site was unioned with its imported building footprints to contain their full extent.

The simulated rights snapshot assigns each input parcel to one demonstration wallet. The labels and
names describe design provenance only.

The initial Pinata upload attempt on 26 October 2026 returned HTTP 403 `pinning-quota-exhausted`;
Filebase's default endpoint returned HTTP 403 `AccountProblem`. A Pinata reserve path later succeeded.
Both plans and agreements were published, indexed and read back byte-for-byte through the verified
gateway. The initial funding observation also recorded a 79.905502 USDC shortfall; 138.629440 USDC
was later deposited and split equally between the two markets. See the dated [preparation and
validation record](sf-demo-validation-2026-10-26.md).
