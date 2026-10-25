// Localnet suite for proposal_market's LMSR market (lmsr-market.md, "Test contract"): creation and
// its seed, buy and sell with their slippage guards, late and insider trades (the agreement's sponsor
// and lens), the position cap, both resolution paths (the agreement account's status since M3:
// Executed → YES, Cancelled → VOID, Expired → NO; and MarketEvidence-v1 attestations including VOID
// on conflicting evidence), claims on every outcome, the creator's reclaim, the vault invariant over
// a scripted trade sequence, and the compute units of a buy and a sell.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createMint,
    getAccount,
    getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount,
    mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "crypto";
import { airdrop } from "./helpers.ts";
import {
    LensMember,
    MARKET_EVIDENCE_SCHEMA,
    attestationBytes,
    chainNow,
    createLensMember,
    credentialBytes,
    marketEvidencePayload,
    schemaBytes,
    waitForProgramsVisible,
    writeSasAccount,
} from "./sas-mock.ts";
import {
    CreatedAgreement,
    STATUS,
    cancelAgreement,
    createAgreement,
    expireAgreement,
    settleExecuted,
    statusByte,
    writeAgreementLookalike,
} from "./agreement-helpers.ts";

// The JavaScript reference module (frontend/js/bets/lmsr.js): every amount the program charges or
// pays for a trade must equal its quote to the atomic unit.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Lmsr = require("../../../frontend/js/bets/lmsr.js");

const NO = 0;
const YES = 1;
const VOID = 2;

/** One USDC in atomic units; one share pays one atomic unit, so a full share is USDC units. */
const USDC = 1_000_000n;
/** Liquidity of most markets below: the creator deposits max_loss(B) ≈ 69.31 USDC. */
const B = 100n * USDC;

const bn = (value: bigint | number) => new anchor.BN(value.toString());
const big = (value: any) => BigInt(value.toString());
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest();
const sideName = (side: number) => (side === YES ? "yes" : "no");

describe("proposal_market LMSR", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalMarket as Program;
    const agreementProgram = anchor.workspace.Agreement as Program;

    const payer = (provider.wallet as any).payer as Keypair;

    type Wallet = { keypair: Keypair; publicKey: PublicKey; tokenAccount: PublicKey };

    let stakeMint: PublicKey;
    // The provider wallet: sponsor of every agreement below (an insider on their markets) and the
    // creator of every market.
    let creator: Wallet;
    let alice: Wallet;
    let bob: Wallet;
    // The lens every agreement names; also the trusted attester of the recipe-bound markets.
    let notary: LensMember;
    let notaryWallet: Wallet;
    // A lens member no agreement below names: an ordinary trader on every market here.
    let member: LensMember;
    let memberWallet: Wallet;
    // The agreements below by address, for the steps that need their CID and sponsor.
    const opened = new Map<string, CreatedAgreement>();
    let evidenceCredential: PublicKey;
    let evidenceSchema: PublicKey;

    before(async () => {
        await waitForProgramsVisible(provider.connection);

        stakeMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
        creator = await fundWallet(payer, 10_000n * USDC);
        alice = await fundWallet(Keypair.generate(), 1_000n * USDC);
        bob = await fundWallet(Keypair.generate(), 1_000n * USDC);
        notary = await createLensMember(provider);
        notaryWallet = await fundWallet(notary.keypair, 100n * USDC);
        member = await createLensMember(provider);
        memberWallet = await fundWallet(member.keypair, 100n * USDC);

        // Registered the way the court schema is: a credential whose authority is the notary and a
        // MarketEvidence schema under it, both written through the mock SAS program.
        evidenceCredential = await writeSasAccount(provider, credentialBytes(notary.publicKey, "market-evidence"));
        evidenceSchema = await writeSasAccount(provider, schemaBytes(evidenceCredential, MARKET_EVIDENCE_SCHEMA));
    });

    // ========================
    // Helpers
    // ========================

    async function fundWallet(keypair: Keypair, amount: bigint): Promise<Wallet> {
        if (!keypair.publicKey.equals(payer.publicKey)) {
            await airdrop(provider.connection, keypair.publicKey);
        }
        const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, stakeMint, keypair.publicKey);
        if (amount > 0n) {
            await mintTo(provider.connection, payer, stakeMint, ata.address, payer, amount);
        }
        return { keypair, publicKey: keypair.publicKey, tokenAccount: ata.address };
    }

    /** An Active agreement sponsored by the provider wallet (every market's creator), the notary its lens. */
    async function openAgreement(deadline = 0): Promise<PublicKey> {
        const created = await createAgreement(agreementProgram, { lens: notary.publicKey, deadline });
        opened.set(created.agreement.toBase58(), created);
        return created.agreement;
    }

    /** The notary's satisfied decision is recorded and the agreement executes. */
    async function executeSubject(agreement: PublicKey) {
        await settleExecuted(agreementProgram, notary, opened.get(agreement.toBase58())!);
        expect(await statusByte(provider.connection, agreement)).to.equal(STATUS.executed);
    }

    async function cancelSubject(agreement: PublicKey) {
        await cancelAgreement(agreementProgram, agreement, payer);
        expect(await statusByte(provider.connection, agreement)).to.equal(STATUS.cancelled);
    }

    /** Anyone expires an agreement whose deadline has passed. */
    async function expireSubject(agreement: PublicKey) {
        await expireAgreement(agreementProgram, agreement, payer.publicKey);
        expect(await statusByte(provider.connection, agreement)).to.equal(STATUS.expired);
    }

    function marketPda(key: PublicKey | Buffer, creatorKey: PublicKey = creator.publicKey, kind: 0 | 1 = 0): PublicKey {
        const bytes = Buffer.isBuffer(key) ? key : key.toBuffer();
        const namespace = kind === 0 ? "lmsr" : "lmsr_recipe";
        return PublicKey.findProgramAddressSync([Buffer.from(namespace), bytes, creatorKey.toBuffer()], program.programId)[0];
    }

    function positionPda(market: PublicKey, owner: PublicKey, side: number): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("lmsr_position"), market.toBuffer(), owner.toBuffer(), Buffer.from([side])],
            program.programId
        )[0];
    }

    const vaultOf = (market: PublicKey) => getAssociatedTokenAddressSync(stakeMint, market, true);

    async function balance(tokenAccount: PublicKey): Promise<bigint> {
        return (await getAccount(provider.connection, tokenAccount)).amount;
    }

    async function fetchMarket(market: PublicKey) {
        const m: any = await program.account.lmsrMarket.fetch(market);
        return {
            ...m,
            b: big(m.b), qYes: big(m.qYes), qNo: big(m.qNo), seed: big(m.seed),
            maxPosition: big(m.maxPosition), paidOut: big(m.paidOut),
            closesAt: Number(m.closesAt), resolvedAt: Number(m.resolvedAt),
        };
    }

    async function fetchPosition(market: PublicKey, owner: PublicKey, side: number) {
        const p: any = await program.account.position.fetch(positionPda(market, owner, side));
        return { ...p, amount: big(p.amount) };
    }

    type MarketTerms = { b?: bigint; closesIn?: number; closesAt?: number; grace?: number; maxPosition?: bigint; wallet?: Wallet };

    async function createAgreementMarket(agreement: PublicKey, t: MarketTerms = {}): Promise<PublicKey> {
        const wallet = t.wallet ?? creator;
        const market = marketPda(agreement, wallet.publicKey);
        const closesAt = t.closesAt ?? (await chainNow(provider.connection)) + (t.closesIn ?? 3600);
        await program.methods
            .createLmsrMarket(bn(t.b ?? B), bn(closesAt), t.grace ?? 0, bn(t.maxPosition ?? 0n))
            .accountsStrict({
                market,
                proposal: agreement,
                stakeMint,
                vault: vaultOf(market),
                creatorTokenAccount: wallet.tokenAccount,
                creator: wallet.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([wallet.keypair])
            .rpc();
        return market;
    }

    /** A recipe's committed texts; the market stores their hashes, the attestations carry the texts. */
    type Recipe = { recipeHash: Buffer; subject: string; yesText: string; noText: string };

    function recipe(label: string): Recipe {
        const nonce = Keypair.generate().publicKey.toBase58();
        return {
            recipeHash: sha256(`recipe:${label}:${nonce}`),
            subject: `SF|5000-002|${label}`,
            yesText: "grading permit issued on or before the deadline",
            noText: "grading permit refused on or before the deadline",
        };
    }

    async function createRecipeMarket(r: Recipe, t: MarketTerms & { attester?: PublicKey; bound?: PublicKey } = {}): Promise<PublicKey> {
        const market = marketPda(r.recipeHash, creator.publicKey, 1);
        const closesAt = t.closesAt ?? (await chainNow(provider.connection)) + (t.closesIn ?? 3600);
        await program.methods
            .createLmsrExternalMarket(
                Array.from(r.recipeHash),
                Array.from(sha256(r.subject)),
                Array.from(sha256(r.yesText)),
                Array.from(sha256(r.noText)),
                t.attester ?? notary.publicKey,
                bn(t.b ?? B),
                bn(closesAt),
                t.grace ?? 0,
                bn(t.maxPosition ?? 0n)
            )
            .accountsStrict({
                market,
                stakeMint,
                vault: vaultOf(market),
                credential: evidenceCredential,
                schema: evidenceSchema,
                creatorTokenAccount: creator.tokenAccount,
                creator: creator.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(t.bound ? [{ pubkey: t.bound, isSigner: false, isWritable: false }] : [])
            .rpc();
        return market;
    }

    /** A MarketEvidence-v1 attestation by the notary (unless overridden) under the evidence schema. */
    async function attestEvidence(
        r: Recipe,
        e: { value: string; eventTime: number; sourceObservedAt?: number; recipeHash?: string; subject?: string; authority?: PublicKey; expiry?: number }
    ): Promise<PublicKey> {
        const sourceObservedAt = e.sourceObservedAt ?? (await chainNow(provider.connection)) - 30;
        return writeSasAccount(provider, attestationBytes({
            credential: evidenceCredential,
            schema: evidenceSchema,
            authority: e.authority ?? notary.publicKey,
            expiry: e.expiry,
            payload: marketEvidencePayload({
                recipeHash: e.recipeHash ?? `sha256:${r.recipeHash.toString("hex")}`,
                subject: e.subject ?? r.subject,
                value: e.value,
                eventTime: e.eventTime,
                sourceObservedAt,
            }),
        }));
    }

    async function sendBuy(market: PublicKey, trader: Wallet, side: number, shares: bigint, maxCost: bigint): Promise<string> {
        const m = await fetchMarket(market);
        return program.methods
            .buy(side, bn(shares), bn(maxCost))
            .accountsStrict({
                market,
                proposal: m.proposal,
                position: positionPda(market, trader.publicKey, side),
                vault: m.vault,
                traderTokenAccount: trader.tokenAccount,
                trader: trader.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([trader.keypair])
            .rpc();
    }

    async function sendSell(market: PublicKey, trader: Wallet, side: number, shares: bigint, minReturn: bigint): Promise<string> {
        const m = await fetchMarket(market);
        return program.methods
            .sell(side, bn(shares), bn(minReturn))
            .accountsStrict({
                market,
                proposal: m.proposal,
                position: positionPda(market, trader.publicKey, side),
                vault: m.vault,
                traderTokenAccount: trader.tokenAccount,
                trader: trader.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([trader.keypair])
            .rpc();
    }

    /** Buy at exactly the reference quote and check the trader paid that, no more, no less. */
    async function buy(market: PublicKey, trader: Wallet, side: number, shares: bigint) {
        const m = await fetchMarket(market);
        const quote = BigInt(Lmsr.buyCost(m.b, m.qYes, m.qNo, sideName(side), shares));
        const before = await balance(trader.tokenAccount);
        const signature = await sendBuy(market, trader, side, shares, quote);
        expect(before - (await balance(trader.tokenAccount)), "buy charge").to.equal(quote);
        return { cost: quote, signature };
    }

    /** Sell with min_return at exactly the reference quote and check the trader received it. */
    async function sell(market: PublicKey, trader: Wallet, side: number, shares: bigint) {
        const m = await fetchMarket(market);
        const quote = BigInt(Lmsr.sellReturn(m.b, m.qYes, m.qNo, sideName(side), shares));
        const before = await balance(trader.tokenAccount);
        const signature = await sendSell(market, trader, side, shares, quote);
        expect((await balance(trader.tokenAccount)) - before, "sell return").to.equal(quote);
        return { proceeds: quote, signature };
    }

    async function resolve(market: PublicKey, attestations: PublicKey[] = []): Promise<string> {
        const m = await fetchMarket(market);
        return program.methods
            .resolveLmsr()
            .accountsStrict({ market, proposal: m.proposal, schema: m.schema })
            .remainingAccounts(attestations.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })))
            .rpc();
    }

    async function claim(market: PublicKey, claimer: Wallet, side: number): Promise<bigint> {
        const before = await balance(claimer.tokenAccount);
        await program.methods
            .claimLmsr()
            .accountsStrict({
                market,
                position: positionPda(market, claimer.publicKey, side),
                vault: vaultOf(market),
                claimerTokenAccount: claimer.tokenAccount,
                claimer: claimer.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([claimer.keypair])
            .rpc();
        return (await balance(claimer.tokenAccount)) - before;
    }

    async function reclaim(market: PublicKey, wallet: Wallet = creator): Promise<bigint> {
        const before = await balance(wallet.tokenAccount);
        await program.methods
            .reclaimSeed()
            .accountsStrict({
                market,
                vault: vaultOf(market),
                creatorTokenAccount: wallet.tokenAccount,
                creator: wallet.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([wallet.keypair])
            .rpc();
        return (await balance(wallet.tokenAccount)) - before;
    }

    /** Poll the validator's clock (never the host's) until it reaches `instant`. */
    async function waitForChainTime(instant: number) {
        while ((await chainNow(provider.connection)) < instant) {
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }

    async function computeUnits(signature: string): Promise<number> {
        for (;;) {
            const tx = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            if (tx?.meta?.computeUnitsConsumed !== undefined) return tx.meta.computeUnitsConsumed;
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }

    async function resolvedEvent(signature: string): Promise<any> {
        for (;;) {
            const tx = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            if (tx?.meta?.logMessages) {
                const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
                const events = [...parser.parseLogs(tx.meta.logMessages)];
                return events.find(event => event.name === "lmsrMarketResolved" || event.name === "LmsrMarketResolved")?.data;
            }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }

    /** Anchor puts the code on err.error.errorCode.code; a raw runtime failure only has logs. */
    function errorText(err: any): string {
        const logs = err?.logs ?? err?.transactionLogs ?? err?.error?.logs ?? [];
        return [err?.error?.errorCode?.code, err?.message, String(err), Array.isArray(logs) ? logs.join("\n") : ""]
            .filter(Boolean)
            .join("\n");
    }

    /** Run `fn`, require it to fail, and assert on the program error it raised. */
    async function expectFailure(fn: () => Promise<any>, expected: string | RegExp) {
        let thrown: any;
        try {
            await fn();
        } catch (err: any) {
            thrown = err;
        }
        expect(thrown, `expected a failure matching ${expected}`).to.exist;
        const code = thrown?.error?.errorCode?.code;
        if (typeof expected === "string" && code) {
            expect(code, errorText(thrown)).to.equal(expected);
        } else if (typeof expected === "string") {
            expect(errorText(thrown)).to.include(expected);
        } else {
            expect(errorText(thrown)).to.match(expected);
        }
    }

    /** Vault invariants 1 and 2 of lmsr-market.md: either outcome, and a VOID, stay payable. */
    async function expectVaultCovers(market: PublicKey) {
        const m = await fetchMarket(market);
        const vault = await balance(m.vault);
        const max = m.qYes > m.qNo ? m.qYes : m.qNo;
        expect(vault >= max, `vault ${vault} < max(q) ${max}`).to.be.true;
        expect(vault >= m.qYes / 2n + m.qNo / 2n, `vault ${vault} cannot pay a VOID`).to.be.true;
    }

    // ========================
    // Create (kind 0)
    // ========================

    describe("create_lmsr_market", () => {
        let agreement: PublicKey;

        before(async () => {
            agreement = await openAgreement();
        });

        it("refuses a creator who cannot fund the seed, max_loss(b)", async () => {
            const poor = await fundWallet(Keypair.generate(), 1n * USDC);
            await expectFailure(() => createAgreementMarket(agreement, { wallet: poor }), "SeedTooSmall");
            expect(await program.account.lmsrMarket.fetchNullable(marketPda(agreement, poor.publicKey))).to.be.null;
            expect(await balance(poor.tokenAccount)).to.equal(1n * USDC);
        });

        it("rejects zero liquidity and a close time that is not in the future", async () => {
            await expectFailure(() => createAgreementMarket(agreement, { b: 0n }), "ZeroLiquidity");
            const now = await chainNow(provider.connection);
            await expectFailure(() => createAgreementMarket(agreement, { closesAt: now - 1 }), "InvalidCloseTime");
            expect(await program.account.lmsrMarket.fetchNullable(marketPda(agreement))).to.be.null;
        });

        it("opens the market with the seed deposited and empty quantities", async () => {
            const before = await balance(creator.tokenAccount);
            const closesAt = (await chainNow(provider.connection)) + 3600;
            const market = await createAgreementMarket(agreement, { closesAt, grace: 600, maxPosition: 50n * USDC });

            const seed = BigInt(Lmsr.maxLoss(B));
            expect(seed).to.equal(69_314_720n);
            const m = await fetchMarket(market);
            expect(m.kind).to.equal(0);
            expect(m.proposal.toBase58()).to.equal(agreement.toBase58());
            expect(m.creator.toBase58()).to.equal(creator.publicKey.toBase58());
            expect(m.stakeMint.toBase58()).to.equal(stakeMint.toBase58());
            expect(m.vault.toBase58()).to.equal(vaultOf(market).toBase58());
            expect([m.b, m.qYes, m.qNo, m.seed, m.maxPosition, m.paidOut]).to.deep.equal([B, 0n, 0n, seed, 50n * USDC, 0n]);
            expect([m.closesAt, m.graceSeconds]).to.deep.equal([closesAt, 600]);
            expect(m.resolved).to.be.false;
            expect(await balance(m.vault)).to.equal(seed);
            expect(before - (await balance(creator.tokenAccount))).to.equal(seed);
        });

        it("rejects an agreement that is not Active, and a subject that is not an agreement", async () => {
            const cancelled = await openAgreement();
            await cancelSubject(cancelled);
            await expectFailure(() => createAgreementMarket(cancelled), "ProposalNotActive");
            const lookalike = await writeAgreementLookalike(provider, { authority: creator.publicKey, lens: notary.publicKey });
            await expectFailure(() => createAgreementMarket(lookalike), "InvalidProposalAccount");
            expect(await program.account.lmsrMarket.fetchNullable(marketPda(lookalike))).to.be.null;
        });
    });

    // ========================
    // Buy and sell
    // ========================

    describe("buy and sell", () => {
        let market: PublicKey;

        before(async () => {
            market = await createAgreementMarket(await openAgreement());
        });

        it("buys at the reference quote under max_cost and records the shares", async () => {
            const { signature } = await buy(market, alice, YES, 10n * USDC);
            const m = await fetchMarket(market);
            expect([m.qYes, m.qNo]).to.deep.equal([10n * USDC, 0n]);
            const position = await fetchPosition(market, alice.publicKey, YES);
            expect(position.market.toBase58()).to.equal(market.toBase58());
            expect(position.owner.toBase58()).to.equal(alice.publicKey.toBase58());
            expect([position.side, position.amount, position.claimed]).to.deep.equal([YES, 10n * USDC, false]);
            expect(Lmsr.buyCost(B, 0n, 0n, "yes", 10n * USDC)).to.equal(5_124_949n);
            console.log(`      compute units: buy opening a position ${await computeUnits(signature)}`);
        });

        it("rejects a buy whose cost exceeds max_cost", async () => {
            const m = await fetchMarket(market);
            const quote = BigInt(Lmsr.buyCost(m.b, m.qYes, m.qNo, "no", 5n * USDC));
            const before = await balance(bob.tokenAccount);
            await expectFailure(() => sendBuy(market, bob, NO, 5n * USDC, quote - 1n), "CostExceedsMax");
            expect(await balance(bob.tokenAccount)).to.equal(before);
            expect((await fetchMarket(market)).qNo).to.equal(0n);
        });

        it("rejects zero shares and a side other than 0 or 1", async () => {
            await expectFailure(() => sendBuy(market, bob, NO, 0n, 1n * USDC), "ZeroAmount");
            await expectFailure(() => sendBuy(market, bob, 2, 1n * USDC, 1n * USDC), "InvalidSide");
        });

        it("rejects a sale returning less than min_return, then sells at the quote", async () => {
            const m = await fetchMarket(market);
            const quote = BigInt(Lmsr.sellReturn(m.b, m.qYes, m.qNo, "yes", 4n * USDC));
            await expectFailure(() => sendSell(market, alice, YES, 4n * USDC, quote + 1n), "ReturnBelowMin");
            expect((await fetchPosition(market, alice.publicKey, YES)).amount).to.equal(10n * USDC);

            const { signature } = await sell(market, alice, YES, 4n * USDC);
            expect((await fetchPosition(market, alice.publicKey, YES)).amount).to.equal(6n * USDC);
            expect((await fetchMarket(market)).qYes).to.equal(6n * USDC);
            console.log(`      compute units: sell ${await computeUnits(signature)}`);
        });

        it("rejects selling more shares than the position holds", async () => {
            await buy(market, bob, YES, 1n * USDC);
            await expectFailure(() => sendSell(market, alice, YES, 6n * USDC + 1n, 0n), "SellExceedsPosition");
            expect((await fetchPosition(market, alice.publicKey, YES)).amount).to.equal(6n * USDC);
            expect((await fetchMarket(market)).qYes).to.equal(7n * USDC);
        });

        it("adds a further buy to the same position", async () => {
            const { signature } = await buy(market, alice, YES, 2n * USDC);
            expect((await fetchPosition(market, alice.publicKey, YES)).amount).to.equal(8n * USDC);
            console.log(`      compute units: buy adding to a position ${await computeUnits(signature)}`);
        });
    });

    describe("max_position", () => {
        let market: PublicKey;

        before(async () => {
            market = await createAgreementMarket(await openAgreement(), { maxPosition: 10n * USDC });
        });

        it("caps each wallet's shares per side", async () => {
            await buy(market, alice, YES, 6n * USDC);
            await expectFailure(() => sendBuy(market, alice, YES, 5n * USDC, 10n * USDC), "PositionCapExceeded");
            await buy(market, alice, YES, 4n * USDC);
            expect((await fetchPosition(market, alice.publicKey, YES)).amount).to.equal(10n * USDC);
            await expectFailure(() => sendBuy(market, alice, YES, 1n, 1n * USDC), "PositionCapExceeded");
            // The other side and other wallets have their own allowance.
            await buy(market, alice, NO, 10n * USDC);
            await buy(market, bob, YES, 10n * USDC);
        });

        it("lets a sale make room under the cap", async () => {
            await sell(market, alice, YES, 3n * USDC);
            await buy(market, alice, YES, 3n * USDC);
            expect((await fetchPosition(market, alice.publicKey, YES)).amount).to.equal(10n * USDC);
        });
    });

    // ========================
    // Insiders (streamline B3)
    // ========================

    describe("insiders", () => {
        it("bars the agreement's sponsor and its lens from a kind 0 market", async () => {
            const market = await createAgreementMarket(await openAgreement());
            await expectFailure(() => sendBuy(market, creator, YES, 1n * USDC, 1n * USDC), "InsiderTrade");
            await expectFailure(() => sendBuy(market, notaryWallet, NO, 1n * USDC, 1n * USDC), "InsiderTrade");
            await buy(market, alice, YES, 1n * USDC);
            // A lens member the agreement does not name is an ordinary trader.
            await buy(market, memberWallet, NO, 1n * USDC);
        });

        it("bars the trusted attester of an unbound kind 1 market, and only the attester", async () => {
            const market = await createRecipeMarket(recipe("ins-unbound"));
            expect((await fetchMarket(market)).proposal.toBase58()).to.equal(PublicKey.default.toBase58());
            await expectFailure(() => sendBuy(market, notaryWallet, YES, 1n * USDC, 1n * USDC), "InsiderTrade");
            // No agreement is bound, so its sponsor is just another trader here.
            await buy(market, creator, YES, 1n * USDC);
        });

        it("bars the bound agreement's sponsor and its lens, the attester, from a kind 1 market", async () => {
            const bound = await openAgreement();
            const market = await createRecipeMarket(recipe("ins-bound"), { bound });
            expect((await fetchMarket(market)).proposal.toBase58()).to.equal(bound.toBase58());
            await expectFailure(() => sendBuy(market, creator, YES, 1n * USDC, 1n * USDC), "InsiderTrade");
            await expectFailure(() => sendBuy(market, notaryWallet, NO, 1n * USDC, 1n * USDC), "InsiderTrade");
            await buy(market, memberWallet, NO, 1n * USDC);
            await buy(market, bob, NO, 1n * USDC);
        });
    });

    // ========================
    // Vault invariant over a scripted sequence
    // ========================

    describe("vault invariant", () => {
        it("keeps vault ≥ max(q_yes, q_no) and a VOID payable after every trade of two traders", async () => {
            const market = await createAgreementMarket(await openAgreement(), { b: 50n * USDC });
            const script: [Wallet, "buy" | "sell", number, bigint][] = [
                [alice, "buy", YES, 30n * USDC],
                [bob, "buy", NO, 20n * USDC],
                [alice, "buy", YES, 45n * USDC],
                [bob, "sell", NO, 5n * USDC],
                [alice, "sell", YES, 25n * USDC],
                [bob, "buy", YES, 10n * USDC],
                [bob, "buy", NO, 60n * USDC],
                [alice, "buy", NO, 1n],
                [alice, "sell", YES, 20n * USDC],
                [bob, "sell", NO, 75n * USDC],
                [alice, "buy", YES, 400n * USDC],
                [bob, "sell", YES, 10n * USDC],
            ];
            let previous = await balance(vaultOf(market));
            expect(previous).to.equal(BigInt(Lmsr.maxLoss(50n * USDC)));
            const units: Record<"buy" | "sell", number[]> = { buy: [], sell: [] };
            for (const [trader, action, side, shares] of script) {
                if (action === "buy") {
                    const { cost, signature } = await buy(market, trader, side, shares);
                    expect((await balance(vaultOf(market))) - previous).to.equal(cost);
                    units.buy.push(await computeUnits(signature));
                } else {
                    const { proceeds, signature } = await sell(market, trader, side, shares);
                    expect(previous - (await balance(vaultOf(market)))).to.equal(proceeds);
                    units.sell.push(await computeUnits(signature));
                }
                previous = await balance(vaultOf(market));
                await expectVaultCovers(market);
            }
            for (const action of ["buy", "sell"] as const) {
                console.log(`      compute units over the script: ${units[action].length} ${action}s, ${Math.min(...units[action])} to ${Math.max(...units[action])}`);
            }
            const m = await fetchMarket(market);
            const held = async (side: number) =>
                (await fetchPosition(market, alice.publicKey, side)).amount + (await fetchPosition(market, bob.publicKey, side)).amount;
            expect([m.qYes, m.qNo]).to.deep.equal([await held(YES), await held(NO)]);
        });

        it("never returns more on a sale than the same shares just cost", async () => {
            const market = await createAgreementMarket(await openAgreement());
            await buy(market, alice, YES, 30n * USDC);
            for (const shares of [1n, 7n, 1n * USDC, 25n * USDC]) {
                const { cost } = await buy(market, bob, NO, shares);
                const { proceeds } = await sell(market, bob, NO, shares);
                expect(proceeds <= cost, `shares ${shares}: back ${proceeds} > paid ${cost}`).to.be.true;
            }
            await expectVaultCovers(market);
        });
    });

    // ========================
    // Kind 0 resolution
    // ========================

    describe("kind 0: Executed → YES", () => {
        let agreement: PublicKey;
        let market: PublicKey;

        before(async () => {
            agreement = await openAgreement();
            market = await createAgreementMarket(agreement);
            await buy(market, alice, YES, 20n * USDC);
            await buy(market, bob, NO, 30n * USDC);
        });

        it("refuses to resolve an Active agreement before the deadline plus grace", async () => {
            await expectFailure(() => resolve(market), "GraceNotElapsed");
            expect((await fetchMarket(market)).resolved).to.be.false;
        });

        it("refuses a reclaim before resolution", async () => {
            await expectFailure(() => reclaim(market), "MarketNotResolved");
        });

        it("stops trading once the agreement is no longer Active", async () => {
            await executeSubject(agreement);
            await expectFailure(() => sendBuy(market, alice, YES, 1n * USDC, 1n * USDC), "ProposalNotActive");
            await expectFailure(() => sendSell(market, bob, NO, 1n * USDC, 0n), "ProposalNotActive");
        });

        it("resolves YES once the agreement is executed, and trading stays closed", async () => {
            await resolve(market);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, YES]);
            expect(m.resolvedAt).to.be.greaterThan(0);
            await expectFailure(() => resolve(market), "MarketResolved");
            await expectFailure(() => sendBuy(market, alice, YES, 1n * USDC, 1n * USDC), "MarketResolved");
        });

        it("pays a winning share one unit, a losing one nothing, and only once", async () => {
            expect(await claim(market, alice, YES)).to.equal(20n * USDC);
            expect((await fetchPosition(market, alice.publicKey, YES)).claimed).to.be.true;
            expect((await fetchMarket(market)).paidOut).to.equal(20n * USDC);
            await expectFailure(() => claim(market, bob, NO), "PositionPaysNothing");
            await expectFailure(() => claim(market, alice, YES), "AlreadyClaimed");
        });

        it("returns everything past the obligation to the creator, and only to the creator", async () => {
            await expectFailure(() => reclaim(market, alice), "NotCreator");
            const vault = await balance(vaultOf(market));
            expect(await reclaim(market)).to.equal(vault);
            expect(await balance(vaultOf(market))).to.equal(0n);
            await expectFailure(() => reclaim(market), "NothingToReclaim");
        });
    });

    describe("kind 0: Cancelled → VOID", () => {
        let market: PublicKey;

        before(async () => {
            const agreement = await openAgreement();
            market = await createAgreementMarket(agreement);
            await buy(market, alice, YES, 21n * USDC + 1n);
            await buy(market, bob, NO, 10n * USDC);
            await cancelSubject(agreement);
        });

        it("voids the market when the agreement is cancelled", async () => {
            await resolve(market);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, VOID]);
        });

        it("reclaims down to the VOID obligation, then pays each share one half, floored", async () => {
            const owed = (21n * USDC + 1n) / 2n + (10n * USDC) / 2n;
            const vault = await balance(vaultOf(market));
            expect(await reclaim(market)).to.equal(vault - owed);
            expect(await balance(vaultOf(market))).to.equal(owed);

            expect(await claim(market, alice, YES)).to.equal((21n * USDC + 1n) / 2n);
            expect(await claim(market, bob, NO)).to.equal(5n * USDC);
            expect(await balance(vaultOf(market))).to.equal(0n);
            await expectFailure(() => claim(market, bob, NO), "AlreadyClaimed");
        });
    });

    describe("kind 0: Expired → NO", () => {
        let agreement: PublicKey;
        let market: PublicKey;
        let deadline: number;

        before(async () => {
            deadline = (await chainNow(provider.connection)) + 15;
            agreement = await openAgreement(deadline);
            market = await createAgreementMarket(agreement);
            await buy(market, alice, YES, 5n * USDC);
            await buy(market, bob, NO, 8n * USDC);
        });

        it("does not settle on a passed agreement deadline alone; trading stops once anyone expires the agreement", async () => {
            await waitForChainTime(deadline + 1);
            await expectFailure(() => resolve(market), "GraceNotElapsed");
            await expireSubject(agreement);
            await expectFailure(() => sendBuy(market, alice, YES, 1n * USDC, 1n * USDC), "ProposalNotActive");
        });

        it("resolves NO and pays the NO side", async () => {
            await resolve(market);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, NO]);
            expect(await claim(market, bob, NO)).to.equal(8n * USDC);
            await expectFailure(() => claim(market, alice, YES), "PositionPaysNothing");
            const vault = await balance(vaultOf(market));
            expect(await reclaim(market)).to.equal(vault);
        });
    });

    describe("kind 0: deadline", () => {
        let market: PublicKey;
        let closesAt: number;
        const grace = 6;

        before(async () => {
            const agreement = await openAgreement();
            closesAt = (await chainNow(provider.connection)) + 10;
            market = await createAgreementMarket(agreement, { closesAt, grace });
            await buy(market, alice, NO, 3n * USDC);
            await buy(market, bob, YES, 1n * USDC);
        });

        it("rejects buys and sells at or after closes_at", async () => {
            await waitForChainTime(closesAt);
            await expectFailure(() => sendBuy(market, bob, YES, 1n * USDC, 1n * USDC), "MarketClosed");
            await expectFailure(() => sendSell(market, alice, NO, 1n * USDC, 0n), "MarketClosed");
        });

        it("settles NO for an Active agreement only after the deadline plus grace", async () => {
            // Only while the grace end is safely ahead, so the transaction cannot land after it.
            if ((await chainNow(provider.connection)) + 2 < closesAt + grace) {
                await expectFailure(() => resolve(market), "GraceNotElapsed");
            }
            await waitForChainTime(closesAt + grace);
            await resolve(market);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, NO]);
            expect(await claim(market, alice, NO)).to.equal(3n * USDC);
            await expectFailure(() => claim(market, bob, YES), "PositionPaysNothing");
        });
    });

    // ========================
    // Kind 1 (recipe-bound) creation and resolution
    // ========================

    describe("create_lmsr_external_market", () => {
        it("stores the commitments and deposits the seed", async () => {
            const r = recipe("create");
            const market = await createRecipeMarket(r, { grace: 86_400 });
            const m = await fetchMarket(market);
            expect(m.kind).to.equal(1);
            expect(Buffer.from(m.recipeHash).equals(r.recipeHash)).to.be.true;
            expect(Buffer.from(m.subjectHash).equals(sha256(r.subject))).to.be.true;
            expect(Buffer.from(m.yesValueHash).equals(sha256(r.yesText))).to.be.true;
            expect(Buffer.from(m.noValueHash).equals(sha256(r.noText))).to.be.true;
            expect(m.credential.toBase58()).to.equal(evidenceCredential.toBase58());
            expect(m.schema.toBase58()).to.equal(evidenceSchema.toBase58());
            expect(m.trustedAttester.toBase58()).to.equal(notary.publicKey.toBase58());
            expect(m.graceSeconds).to.equal(86_400);
            expect(await balance(m.vault)).to.equal(BigInt(Lmsr.maxLoss(B)));
        });

        it("rejects a bound agreement whose lens is not the attester, and a bound account that is not an agreement", async () => {
            const lookalike = await writeAgreementLookalike(provider, { authority: creator.publicKey, lens: notary.publicKey });
            await expectFailure(() => createRecipeMarket(recipe("not-agreement"), { bound: lookalike }), "InvalidProposalAccount");
            const bound = await openAgreement();
            await expectFailure(
                () => createRecipeMarket(recipe("outside"), { bound, attester: Keypair.generate().publicKey }),
                "AttesterNotInProposalLens"
            );
        });
    });

    describe("kind 1: YES by evidence", () => {
        const r = recipe("yes");
        let market: PublicKey;
        let now: number;

        before(async () => {
            market = await createRecipeMarket(r);
            await buy(market, alice, YES, 10n * USDC);
            await buy(market, bob, NO, 10n * USDC);
            now = await chainNow(provider.connection);
        });

        it("refuses NO by absence before the deadline plus grace", async () => {
            await expectFailure(() => resolve(market), "GraceNotElapsed");
            expect((await fetchMarket(market)).resolved).to.be.false;
        });

        it("rejects evidence for another recipe, subject or value, or from an untrusted or expired attestation", async () => {
            const eventTime = now - 100;
            const cases: [Promise<PublicKey>, string][] = [
                [attestEvidence(r, { value: r.yesText, eventTime, recipeHash: `sha256:${sha256("other").toString("hex")}` }), "WrongEvidenceRecipe"],
                [attestEvidence(r, { value: r.yesText, eventTime, subject: "SF|5000-003" }), "WrongEvidenceSubject"],
                [attestEvidence(r, { value: "grading permit filed", eventTime }), "UnsupportedEvidenceValue"],
                [attestEvidence(r, { value: r.yesText, eventTime, authority: Keypair.generate().publicKey }), "UntrustedAttester"],
                [attestEvidence(r, { value: r.yesText, eventTime, expiry: now - 1 }), "ExpiredEvidence"],
                [attestEvidence(r, { value: r.yesText, eventTime, sourceObservedAt: eventTime - 1 }), "EvidenceObservedBeforeEvent"],
                [attestEvidence(r, { value: r.yesText, eventTime, sourceObservedAt: now + 3600 }), "EvidenceFromFuture"],
            ];
            for (const [attestation, code] of cases) {
                const address = await attestation;
                await expectFailure(() => resolve(market, [address]), code);
            }
            expect((await fetchMarket(market)).resolved).to.be.false;
        });

        it("resolves YES before the close from a qualifying attestation", async () => {
            const evidence = await attestEvidence(r, { value: r.yesText, eventTime: now - 100 });
            const signature = await resolve(market, [evidence]);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, YES]);
            expect(m.evidence.toBase58()).to.equal(evidence.toBase58());
            const data = (await provider.connection.getAccountInfo(evidence))!.data;
            expect(Buffer.from(m.evidenceHash).equals(sha256(data))).to.be.true;
            const event = await resolvedEvent(signature);
            expect(event.outcome).to.equal(YES);
            expect(event.evidence.toBase58()).to.equal(evidence.toBase58());
        });

        it("pays the YES side", async () => {
            expect(await claim(market, alice, YES)).to.equal(10n * USDC);
            await expectFailure(() => claim(market, bob, NO), "PositionPaysNothing");
        });
    });

    describe("kind 1: NO by absence", () => {
        const r = recipe("absent");
        let market: PublicKey;
        let closesAt: number;
        const grace = 6;

        before(async () => {
            closesAt = (await chainNow(provider.connection)) + 10;
            market = await createRecipeMarket(r, { closesAt, grace });
            await buy(market, alice, YES, 2n * USDC);
            await buy(market, bob, NO, 4n * USDC);
        });

        it("closes trading at closes_at and rejects an event after the deadline", async () => {
            await waitForChainTime(closesAt + 1);
            await expectFailure(() => sendBuy(market, alice, YES, 1n * USDC, 1n * USDC), "MarketClosed");
            const late = await attestEvidence(r, { value: r.yesText, eventTime: closesAt + 1, sourceObservedAt: closesAt + 1 });
            await expectFailure(() => resolve(market, [late]), "EventAfterDeadline");
        });

        it("settles NO without evidence only after the deadline plus grace", async () => {
            // Only while the grace end is safely ahead, so the transaction cannot land after it.
            if ((await chainNow(provider.connection)) + 2 < closesAt + grace) {
                await expectFailure(() => resolve(market), "GraceNotElapsed");
            }
            await waitForChainTime(closesAt + grace);
            const signature = await resolve(market);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, NO]);
            expect(m.evidence.toBase58()).to.equal(PublicKey.default.toBase58());
            expect((await resolvedEvent(signature)).outcome).to.equal(NO);
            expect(await claim(market, bob, NO)).to.equal(4n * USDC);
            await expectFailure(() => claim(market, alice, YES), "PositionPaysNothing");
        });
    });

    describe("kind 1: VOID on conflicting evidence", () => {
        const r = recipe("conflict");
        let market: PublicKey;

        before(async () => {
            market = await createRecipeMarket(r);
            await buy(market, alice, YES, 6n * USDC);
            await buy(market, bob, NO, 6n * USDC + 1n);
        });

        it("accepts at most two attestations", async () => {
            const now = await chainNow(provider.connection);
            const one = await attestEvidence(r, { value: r.yesText, eventTime: now - 300 });
            await expectFailure(() => resolve(market, [one, one, one]), "TooMuchEvidence");
        });

        it("voids the market when two qualifying attestations disagree", async () => {
            const now = await chainNow(provider.connection);
            const yes = await attestEvidence(r, { value: r.yesText, eventTime: now - 200 });
            const no = await attestEvidence(r, { value: r.noText, eventTime: now - 100 });
            const signature = await resolve(market, [yes, no]);
            const m = await fetchMarket(market);
            expect([m.resolved, m.outcome]).to.deep.equal([true, VOID]);
            expect(m.evidence.toBase58()).to.equal(yes.toBase58());
            const event = await resolvedEvent(signature);
            expect(event.outcome).to.equal(VOID);
            expect(event.evidence.toBase58()).to.equal(yes.toBase58());
            expect(event.secondEvidence.toBase58()).to.equal(no.toBase58());
        });

        it("pays every share one half, floored, on either side", async () => {
            expect(await claim(market, alice, YES)).to.equal(3n * USDC);
            expect(await claim(market, bob, NO)).to.equal(3n * USDC);
            const vault = await balance(vaultOf(market));
            expect(await reclaim(market)).to.equal(vault);
        });
    });
});
