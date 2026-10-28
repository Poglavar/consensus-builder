# San Francisco devnet demo publication and funding — 26 October 2026

This record tracks publication, minting, indexing and funding of the two Candlestick agreement
demonstrations. The [pair record](sf-agreement-bets.json) contains the current published state and
addresses. Both agreements remain active and unresolved; neither execution nor claim proof has been
recorded.

## Published records and accounts

The agreements and plans use these verified CIDs. Their content retains the imported building
geometry, all 116 original parcel references, source hashes and deadlines. Current binding covers 118
Courtyard parcels and 117 FivePoint parcels. FivePoint retains the imported 99 modeled volumes; the
newer 110-volume importer output was not substituted. Open ground is modeled geometry outside the
bound cadastral parcels and carries no legal ownership claim.

| Intent | Design CID | Plan CID | Agreement CID | Agreement account | Market account |
| --- | --- | --- | --- | --- | --- |
| Courtyard | `bafybeiaiubi5q7wwjyyiavt223lxtr72vezmtwpmfvpy3jgrsaerpslnyq` | `bafkreic6kpty3f5iyfr4mnittekslxnrcwylsspas2x77c2yy6entz4cne` | `bafkreiarw7qlptbgq2eiccwcmcg5yiuazh5i3zcx7lmt4ly32j4f6q6aj4` | `CK9WF4vP3p726PPgHRnks1TNTWhts18ifFmJV2nWfQim` | `6oziGSBmAbPkzKLeryUAiJbSPmbCnHEjkfWyhWb2pmMd` |
| FivePoint | `bafkreihwnn54kntvooptfzcta4li5urn2cnvjkb5lwldr6yvofkknmrloi` | `bafkreih6kmeom5v4m4jxpx4qbxrvnc3gmm7h2llqacmasrbcsknyyb2ciy` | `bafkreidtnissamp6q7hql35z4izn5k546puin3q7ou7gm7izvi4xswywx4` | `DKZLF9UbwUJFNCRLvi8Vi4bv92nXVUPvXZ2pASbmLhrc` | `5vHueyLSkimsimazkUQmYsDyJuqipms7Jx5Tnp8VAQJN` |

Both agreement accounts were minted with active status. The normal public API indexed both agreements and returned both markets as tradable in the SF catalog;
exact-byte readback matched the published plans and agreements. The Pinata gateway returned
matching bytes for all four records.

## Funding and market state

A total of 138.629440 devnet USDC was deposited. Each market received 69.314720 USDC
(`69314720` atomic units). The funding transaction was
`5P9fbzuNfKqbTURDXF69EYC7X4f7ZC1NQREXLi9vt1MAahHp1HMimQdniNXxPMzH5imgk7NRwKBVScA5k7FUCMA3`.
The verified wallet balance afterward was 0.094498 USDC. Both markets remain open and unresolved.

The earlier 26 October observation of 58.723938 USDC against a 138.629440 USDC seed requirement,
with a 79.905502 USDC shortfall, is historical; it was resolved by the later deposit.

## Historical publication attempts and rights

The first Pinata upload attempt failed with HTTP 403 `pinning-quota-exhausted`. Filebase's default
endpoint returned HTTP 403 `AccountProblem`. A reserve Pinata path then published the plans and
agreements successfully. The quota and default-endpoint errors are historical and do not describe
the current publication state.

The rights snapshot assigns the input parcels to one simulated demonstration wallet. It records no
real owner consent or acceptance. Execution, settlement and claims remain pending while these markets are open.

## Live trade verification

An operator-controlled independent demo trader bought YES shares on Courtyard for 0.10 devnet USDC, then sold half of the purchased shares. These are verification trades, not evidence of outside demand.

- Buy: `4aqNc6zQpnabXKgXLKQeXRdKhxZeoUM95dPtYumSs2VP25qkpmnCBZDDGRPSrPRjgGZfqjFjkeX3TG8eUgrxEpqx`; 199899 atomic shares for 100000 atomic USDC.
- Sell: `4dmWMDHUG6PnayZBH52UVd53eqgnkG5Gg8dWtedyCeTZ9ym2FoxE2aG6XQTJem7QZ8fbioAaU8PyFVSdwoyUJCCa`; 99949 atomic shares returned 50011 atomic USDC.
- Fresh position readback: 99950 atomic YES shares remain. Both agreements are Active and both markets remain unresolved.

No human editing behavior changed. Publication used the existing index client, and market operations used the shared Solana codecs and configured sponsor wallet; no MCP schema or editing primitive changed.

## Points UI verification

A headed Chrome session used the isolated `sf-release-20261026` test realm on the production API, excluded from public standings. The UI bought 19.090282 YES shares for 10 points, then sold 9.545141 shares for 5.113584 points. Ledger readback confirmed 995.113584 points and 9.545141 YES shares remain; reloading preserved the same account, balance and position. Receipts: buy `2f790a7f-673d-4cd6-929b-670f3959ff87`, sell `98411168-20e7-4d37-bae3-b394a2385a8c`.

## Bot deadline conversion follow-up

The collection policy passed a chain-decoded `closesAt` BigInt directly into the shared settlement
rules, which require safe integer Unix seconds. A bot's first trade could succeed, but the next turn
failed while checking its existing position. The collection boundary now converts the decoded
BigInt before invoking those rules; unsafe, negative and incorrectly typed values still fail.
The unit and settlement definitions are unchanged, so no glossary change was needed. No human
editing behavior or MCP primitive changed.

Validation used the actual market decoder and a held position. The new regression initially failed
with `closesAt must be unix seconds` (11 passed, one failed). A three-file targeted headless unit run
then exposed one stale fixture using inline design membership (42 passed, one failed); the fixture
now supplies current design contents. The final three-file targeted headless unit run passed all 43
checks. No full suite was run and no tests were stopped.

Read-only dry runs of preservationist-01, skeptic-02 and backer-01 against the production agreement
index and devnet markets completed at 19:04–19:05 UTC on 26 October. All three read existing positions
and selected their next eligible SF bet. These runs signed no transaction, wrote no ledger state,
transferred no funds and sent no notification.
