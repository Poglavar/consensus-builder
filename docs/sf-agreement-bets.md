<!-- Reviewable replacement questions for the Candlestick designs; no agreement is invented here. -->
# Candlestick: bets on two agreements

The featured pair is two independent YES/NO bets: **Will the Courtyard Candlestick agreement execute
on-chain by its deadline?** and **Will the FivePoint Candlestick agreement execute on-chain by its
deadline?** Both can execute, or neither can. Their prices need not add to 100% across agreements.

YES requires recorded execution, after the required approvals, verification and funding, by the
deadline. Expiry or missing the deadline settles NO. Cancellation settles VOID and pays half per
share. Execution does not establish a planning approval, building permit or completed construction.

The [reviewable intents](sf-agreement-bets.json) preserve each stored design's existing expiry as a
proposed deadline, at whole-second resolution. They name the qualified parcel IDs and hash the
stored geometry. They deliberately contain no agreement CID or market address: those must identify
the newly published binding agreements, not the retired proposal-program accounts.

The source inventory on 25 October 2026 found two local imported design records:

| Source record | Stored geometry | Proposed deadline, UTC |
| --- | --- | --- |
| `sf-candlestick-courtyard-2026` | 1,105 building footprints | 9 October 2027, 08:19:27 |
| `sf-candlestick-fivepoint-2024` | 99 modeled volumes | 9 October 2027, 09:01:31 |

Each names 116 DataSF parcel IDs. Neither supplies a current published agreement, sponsor,
owner acceptance or an executable binding rule. The FivePoint importer's newer 110-volume output
must not silently replace the stored 99-volume source while retaining its identity.

There are two concrete publication choices: explicitly labelled devnet demonstration agreements
with simulated rights, or agreements prepared for real counterparties to review. The source models
do not authorize signing for the developer, concept author or landowners. Their names describe the
design provenance; they are not endorsements of the agreement or its market.

Once that choice and the missing agreement terms are supplied, publish and mint each current
agreement, read back its canonical sponsor/CID account and deadline, then expose both in the shared
land contest. Points books open for eligible dated agreements. Each sponsor separately seeds its
devnet-USDC LMSR book after the current program is deployed. An old permit market keeps its original
question and settlement rule; these are new agreement bets.
