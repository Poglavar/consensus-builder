<!-- Bounded verification evidence for the local agreement-betting upgrade. -->
# Betting upgrade verification — 25 October 2026

The current implementation uses dated agreement LMSR books, separate points and devnet-USDC
inventory, and fixed share payouts. This is local verification, not a public deployment receipt or
evidence of outside participant demand. See [the contract](betting-lmsr-points.md),
[instrumentation](betting-instrumentation.md), and [Candlestick agreement intents](sf-agreement-bets.md).

## Passing checks

All runs were explicitly scoped. No full unit or browser suite was run. Counts describe separate
focused runs and include repeated files; they must not be added into a unique-test total.

| Type and scope | Result |
| --- | --- |
| Headless Rust unit checks: Agreement account reader and dated LMSR outcomes, then creator-bound PDA checks | 6 + 3 passed |
| Isolated local Solana validator: `tests/proposal_market_lmsr.ts` | 40 passed |
| Headless unit checks: LMSR client codec, instruction bytes and account validation | 5 passed |
| Headless unit checks: agent trading, lifecycle, policies, activity decoder and MCP tools, 13 files | 180 passed |
| Headless unit checks: model, pictures, contest and market routes, 4 files | 39 passed |
| Headless unit checks: quote contract and points client, 2 files | 17 passed |
| Headless unit checks: points routes, 1 file | 9 passed |
| Headless Node/PostgreSQL integration: `bets-points-db.node.test.js` | 8 passed |
| Headless unit checks: model, dated recipe and telemetry follow-up, 3 files | 25 passed |
| Headless unit checks: agent society wording and betting startup follow-up, 2 files | 25 passed |
| Headless unit checks: betting startup, links and share preview, 3 files | 28 passed |
| Headless unit checks: pitch pages, 1 file | 6 passed |
| Headless Playwright: `bets-sheet.spec.ts` and `bets-button-controls.spec.ts` | 20 passed |
| Headless Playwright: `bets-telemetry.spec.ts` | 3 passed |
| Headless Playwright: `bets-points.spec.ts`, then the direct-after-reload retry case | 2 passed; 1 focused follow-up passed |

The initial instrumentation slice also passed 32 headless unit checks across four files and three
headless Playwright persona cases before the LMSR UI conversion. The later telemetry run above
exercised the current buy action and share links.

The local-validator run used the current Agreement and ProposalMarket programs, the test USDC
fixture and mock SAS program. Its temporary wallet was funded only on that validator. The validator
and temporary ledger were removed after the run. No public transaction was sent.

## What the browser checks established

The points tests use real local PostgreSQL account, trade, settlement and claim routes with an
explicitly simulated agreement source. Each case has an isolated simulation run and cleans up its
own records. The tests cover buy, sell, balance changes, reload persistence, simulated execution,
settlement and claim. A second case commits a buy but hides its receipt behind an injected 502;
after reload, clicking **Check pending receipt** reuses the request ID, clears the pending intent and
leaves the balance unchanged.

The other browser cases cover discovery, filters, wallet gating, sponsor-only USDC seeding,
unknown lifecycle status, quote controls, receipts, independent agreement questions, share links,
position formatting and telemetry. Wallet/RPC responses in those cases are fixtures.

A separate headed Chrome walkthrough used the local points API and PostgreSQL ledger. A 100-point
YES purchase received 148.988012 shares, left 900 points available and displayed its receipt and
position. The question showed the exact UTC cutoff. The receipt fit a 390-pixel viewport, with no
horizontal overflow or browser script errors. The seven-slide primary pitch was checked at desktop
and phone widths: no horizontal overflow or footer collisions. The verification browser was closed.

## Corrected failures and stopped runs

The first local-validator attempt loaded an old compiled market binary and failed PDA checks.
Rebuilding the targeted program and rerunning the same file produced the 40 passing result.

The initial 13-file UI/backend headless unit batch had 117 passes and one obsolete unknown-status
expectation. The affected model/recipe/telemetry follow-up passed all 25 checks. An agent wording
follow-up had 29 of 30 passes; the old message expectation was corrected and its society file passed
in the subsequent 25-check startup/society run. Share, link and startup checks were rerun after the
final deadline and URL changes and passed all 28 checks.

Sandbox loopback restrictions prevented some initial HTTP/browser test attempts from starting;
the same targeted commands were run with local network access. Earlier betting-sheet/control
runs exposed 12, then 5 stale fixture/assertion failures, followed by one sponsor-identity fixture
failure. The focused sponsor check passed, followed by the complete 20-case pair. No run of that
pair was stopped.

One two-case points browser run printed both passes but remained alive during harness teardown and
was interrupted. Subscribing to the owned child process's exit before signalling it and closing the
test context fixed teardown. The same two cases then exited with code 0. The preview clock was
also changed to advance on reads unless a test explicitly overrides it, and the same two cases
passed again with a clean exit. The final focused retry check confirmed that the receipt button
appears directly after reload, without closing and reopening the dialog. No unrelated process or
database record was removed.

## Historical release boundary (25 October)

The new program still requires deployment before public devnet-USDC trading can use this contract.
The points schema and API also require an application release. Existing public proof receipts retain
their historical market semantics. No evidence here establishes real landowner consent, a permit,
construction completion, or use by outside humans.

The local preview script accepts only its named simulation run and binds to loopback. It is a
trading harness, not a published San Francisco agreement; its agreement subject is simulated.

## Devnet release follow-up

On 26 October 2026, the targeted `anchor build --program-name proposal_market` completed and
nine headless Rust checks in `lmsr_market::tests` passed. The program was upgraded on devnet at
slot `515120833`, in transaction
[4qaab6jo…R7JCYrE](https://explorer.solana.com/tx/4qaab6joKfAmzUcntMQM5L5TgZNE22vRpBH1LmWUUAGZJVXxFT6mXVVe2bYsqWX3ZCB6Yc7XcM8Upc9UjR7JCYrE?cluster=devnet).
The downloaded 563,672-byte executable contains the exact 554,384-byte build followed only by
zero padding. Its deployed SHA-256 is
`77f9bdc34c8998cd77fa69c9e402c237e297bba471bca2a738204fd10d6c741a`;
the unpadded local artifact SHA-256 is
`8404705555feeba6a4f78b942e94d6d9a69d1b699d5229320a403b2cee9d8a4f`.
The prior deployed binary was saved locally before the upgrade. This is deployment verification;
no market creation, trade or claim was submitted on public devnet in this follow-up.

## Current release status (26 October 2026)

The frontend release deployed at `2026-10-25T22:30:49Z` (commit `5c8e731e6`), and backend commit
`79733ecd8` is running with the points schema and API installed. The ProposalMarket program is
upgraded on devnet at slot `515120833`; its deployment hash is
`77f9bdc34c8998cd77fa69c9e402c237e297bba471bca2a738204fd10d6c741a`. The live proof endpoint is
[hackathon/proof.json](https://api.urbangametheory.xyz/hackathon/proof.json).

This confirms deployed code and release identity. The points user journey and browser verification
remain simulated; no outside human has participated. A first public points trade and complete devnet
end-to-end trading journey are still pending. The proposed San Francisco pair remains unpublished.
