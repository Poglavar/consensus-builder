# Developer crowdfunding

A developer can raise devnet USDC for one published plan revision by creating a **Developer crowdfunding** agreement. The developer attaches the contract that describes what a contributor receives. For example, a contract could specify how to calculate an investor’s share of future rental income, when it is payable and who must pay it. The developer supplies the actual terms. The plan, contract, developer wallet, minimum funding target, deadline and chosen lens are committed together under the agreement’s content identifier (CID).

## From proposal to settlement

1. Open the named plan and choose **Developer crowdfunding**. Enter a target and deadline, select the lens member who will verify funding, and attach the investor contract. The attachment can be a PDF or UTF-8 text file up to 256 KiB. Publish with the developer wallet connected. Anyone who opens the agreement can download those exact bytes. A change to the plan or contract creates a different agreement.
2. The developer mints that agreement on Solana devnet. An investor opens the agreement, downloads the contract, reviews the target and deadline, and signs a USDC contribution. The existing proposal escrow records the amount and the contributing wallet. Further contributions can take the total above the minimum.
3. The lens operator requests a funding decision. The lens checks the agreement and its USDC escrow at the same finalized Solana slot, and issues approval when the recorded contributions reach the minimum. Anyone can submit that decision and execute the agreement through its deadline. The escrow can then release the funds to the published developer wallet.
4. While the on-chain decision is pending, the developer can cancel. After the deadline, anyone can expire an unexecuted agreement. In either case, each investor can reclaim their deposits. Delivering the return promised in the attachment remains the developer’s obligation under that contract.

## Existing records and programs

| Need | Existing primitive and its role |
| --- | --- |
| A proposal to finance | The exact named plan referenced by `agreement/v1.planCid` supplies the designs. A developer can raise funds for it without assigning land or collecting owner votes. |
| Identifiable terms | The agreement rule uses `electorate: "investors"`, `binding: true` and one lens key. The agreement sponsor is the developer. The usual agreement publication and share link carry these terms. |
| A target and the investor’s contract | The agreement’s `funding.targetUsdcAtomic` is a positive whole number of millionths of a USDC, stored as a decimal string. Its `funding.contract` contains the filename, media type and original bytes in base64. The bytes are covered by the agreement CID and travel with the agreement. |
| Deposits and refunds | The existing `proposal_pledge` program supplies the USDC escrow and per-contribution positions. The lens counts the USDC recorded for those positions and checks the vault covers them. An unsolicited transfer can increase the balance paid at release. It earns no position and contributes zero towards the target. |
| Approval and release | The existing agreement program fixes the lens, deadline and developer payout address at mint. Its native SOL requirement is zero. The selected lens checks the USDC threshold. The agreement program checks the lens decision and deadline, and the escrow checks the agreement’s terminal state on release or refund. |

The investor can review the full verifier and payout wallet addresses beside the contract. `ugt_inspect_agreement` returns the same terms in `investorReview`. The agreement program accepts the selected lens’s funding decision. The reference lens performs the USDC balance and contribution checks. The contribution program currently accepts deposits from any wallet. The first flow ends when escrow pays the developer or investors reclaim their deposits. The attached contract defines what the developer owes after payout.

The Alatau research describes how to verify a funding-only target inside the program, when a round needs an external attestation, and which legal records support a promise of an apartment. [Alatau investment and apartment rights](reports/Alatau%20investment%20and%20apartment%20rights.md)
