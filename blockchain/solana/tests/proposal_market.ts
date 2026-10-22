// Localnet suite for the proposal_market program's parimutuel market on an agreement (an Agreement
// account of the agreement program, plan-design-agreement.md M3): creation on an Active agreement
// only, staking, resolution (Executed → YES, Cancelled or Expired → NO; a recorded decision or a
// passed deadline alone resolves nothing) and payout, plus the agreement-lens binding of external
// markets.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotent,
    createMint,
    getAccount,
    getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount,
    mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "crypto";
import { airdrop, findProposalCounterPDA, findProposalPDA, initializeProposalCounter, NO_SITE } from "./helpers.ts";
import {
    LensMember,
    chainNow,
    createLensMember,
    credentialBytes,
    ensureParcelAnchor,
    schemaBytes,
    waitForProgramsVisible,
    writeSasAccount,
} from "./sas-mock.ts";
import {
    CreatedAgreement,
    STATUS,
    attestSatisfied,
    cancelAgreement,
    createAgreement,
    executeAgreement,
    expireAgreement,
    settleExecuted,
    statusByte,
    waitForChainTime,
    writeAgreementLookalike,
} from "./agreement-helpers.ts";

const SIDE_NO = 0;
const SIDE_YES = 1;

/** Every staker starts with 10 tokens (6 decimals); stakes below are in base units. */
const STAKER_FUNDING = 10_000_000;

describe("proposal_market", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalMarket as Program;
    const agreementProgram = anchor.workspace.Agreement as Program;
    // Only to prove a proposal_nft Proposal is no longer a market subject.
    const proposalProgram = anchor.workspace.ProposalNft as Program;
    const parcelProgram = anchor.workspace.ParcelNft as Program;

    const payer = (provider.wallet as any).payer as Keypair;

    type Staker = { keypair: Keypair; publicKey: PublicKey; tokenAccount: PublicKey };

    let stakeMint: PublicKey;
    let walletA: Staker; // the provider wallet, also the sponsor of every agreement below
    let walletB: Staker;
    let walletC: Staker;
    // The lens every agreement below names.
    let notary: LensMember;

    // The executed agreement's market, shared by the create_market / stake / resolve blocks.
    let executed: CreatedAgreement;
    let executedMarket: PublicKey;
    let executedVault: PublicKey;

    before(async () => {
        await waitForProgramsVisible(provider.connection);
        stakeMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
        walletA = await fundStaker(payer);
        walletB = await fundStaker(Keypair.generate());
        walletC = await fundStaker(Keypair.generate());
        notary = await createLensMember(provider);

        executed = await openAgreement();
    });

    // ========================
    // Helpers
    // ========================

    async function fundStaker(keypair: Keypair): Promise<Staker> {
        if (!keypair.publicKey.equals(payer.publicKey)) {
            await airdrop(provider.connection, keypair.publicKey);
        }
        const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, stakeMint, keypair.publicKey);
        await mintTo(provider.connection, payer, stakeMint, ata.address, payer, STAKER_FUNDING);
        return { keypair, publicKey: keypair.publicKey, tokenAccount: ata.address };
    }

    /** An Active agreement sponsored by the provider wallet with the notary as its lens. */
    function openAgreement(deadline = 0): Promise<CreatedAgreement> {
        return createAgreement(agreementProgram, { lens: notary.publicKey, deadline });
    }

    /** The notary's satisfied decision is recorded and the agreement executes: status Executed. */
    async function executeSubject(created: CreatedAgreement) {
        await settleExecuted(agreementProgram, notary, created);
        expect(await statusByte(provider.connection, created.agreement)).to.equal(STATUS.executed);
    }

    /** The sponsor cancels: status Cancelled. */
    async function cancelSubject(created: CreatedAgreement) {
        await cancelAgreement(agreementProgram, created.agreement, created.sponsor);
        expect(await statusByte(provider.connection, created.agreement)).to.equal(STATUS.cancelled);
    }

    /** A proposal_nft Proposal, the subject markets read before M3. */
    async function mintLegacyProposal(parcelId: string): Promise<PublicKey> {
        await ensureParcelAnchor(parcelProgram, parcelId);
        const [counter] = findProposalCounterPDA(proposalProgram.programId);
        if (!(await proposalProgram.account.proposalCounter.fetchNullable(counter))) {
            await initializeProposalCounter(proposalProgram, payer);
        }
        const count = ((await proposalProgram.account.proposalCounter.fetch(counter)).count as any).toNumber();
        const [proposal] = findProposalPDA(proposalProgram.programId, count);
        await proposalProgram.methods
            .mintAndFund([parcelId], false, "ipfs://test-image", new anchor.BN(0), [notary.publicKey], false, NO_SITE, false)
            .accounts({ proposal, proposalCounter: counter, owner: provider.wallet.publicKey, systemProgram: SystemProgram.programId } as any)
            .rpc();
        return proposal;
    }

    function findMarketPDA(subject: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync([Buffer.from("market"), subject.toBuffer()], program.programId)[0];
    }

    function findPositionPDA(market: PublicKey, owner: PublicKey, side: number): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("position"), market.toBuffer(), owner.toBuffer(), Buffer.from([side])],
            program.programId
        )[0];
    }

    function findVault(market: PublicKey): PublicKey {
        return getAssociatedTokenAddressSync(stakeMint, market, true);
    }

    async function createMarket(subject: PublicKey): Promise<{ market: PublicKey; vault: PublicKey }> {
        const market = findMarketPDA(subject);
        const vault = findVault(market);
        await program.methods
            .createMarket()
            .accounts({
                market,
                proposal: subject,
                stakeMint,
                vault,
                creator: provider.wallet.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();
        return { market, vault };
    }

    async function stake(market: PublicKey, subject: PublicKey, staker: Staker, side: number, amount: number): Promise<PublicKey> {
        const position = findPositionPDA(market, staker.publicKey, side);
        await program.methods
            .stake(side, new anchor.BN(amount))
            .accounts({
                market,
                proposal: subject,
                position,
                vault: findVault(market),
                stakerTokenAccount: staker.tokenAccount,
                staker: staker.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            } as any)
            .signers([staker.keypair])
            .rpc();
        return position;
    }

    async function resolve(market: PublicKey, subject: PublicKey) {
        await program.methods.resolve().accounts({ market, proposal: subject } as any).rpc();
    }

    async function claim(market: PublicKey, claimer: Staker, side: number): Promise<PublicKey> {
        const position = findPositionPDA(market, claimer.publicKey, side);
        await program.methods
            .claim()
            .accounts({
                market,
                position,
                vault: findVault(market),
                claimerTokenAccount: claimer.tokenAccount,
                claimer: claimer.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            } as any)
            .signers([claimer.keypair])
            .rpc();
        return position;
    }

    async function tokenBalance(address: PublicKey): Promise<bigint> {
        return (await getAccount(provider.connection, address)).amount;
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

    // ========================
    // Create market
    // ========================

    describe("create_market", () => {
        it("opens a market on an active agreement with empty pools and a market-owned vault", async () => {
            const created = await createMarket(executed.agreement);
            executedMarket = created.market;
            executedVault = created.vault;

            const market = await program.account.market.fetch(executedMarket);
            expect(market.proposal.toBase58()).to.equal(executed.agreement.toBase58());
            expect(market.stakeMint.toBase58()).to.equal(stakeMint.toBase58());
            expect(market.vault.toBase58()).to.equal(executedVault.toBase58());
            expect((market.yesPool as any).toNumber()).to.equal(0);
            expect((market.noPool as any).toNumber()).to.equal(0);
            expect(market.resolved).to.be.false;
            expect(market.outcome).to.equal(SIDE_NO);

            const vault = await getAccount(provider.connection, executedVault);
            expect(vault.owner.toBase58()).to.equal(executedMarket.toBase58());
            expect(vault.mint.toBase58()).to.equal(stakeMint.toBase58());
            expect(vault.amount).to.equal(0n);
        });

        it("rejects a subject that is not an agreement: a mint, a look-alike another program owns, a proposal_nft Proposal", async () => {
            const lookalike = await writeAgreementLookalike(provider, { authority: payer.publicKey, lens: notary.publicKey });
            const legacy = await mintLegacyProposal("HR-mkt-legacy");
            for (const subject of [stakeMint, lookalike, legacy]) {
                await expectFailure(() => createMarket(subject), "InvalidProposalAccount");
                expect(await program.account.market.fetchNullable(findMarketPDA(subject))).to.be.null;
            }
        });

        it("rejects an agreement that is no longer Active", async () => {
            const cancelled = await openAgreement();
            await cancelSubject(cancelled);
            await expectFailure(() => createMarket(cancelled.agreement), "ProposalNotActive");
            expect(await program.account.market.fetchNullable(findMarketPDA(cancelled.agreement))).to.be.null;
        });

        it("rejects a second market on the same agreement", async () => {
            await expectFailure(() => createMarket(executed.agreement), /already in use|custom program error: 0x0/);

            const market = await program.account.market.fetch(executedMarket);
            expect(market.proposal.toBase58()).to.equal(executed.agreement.toBase58());
            expect(market.resolved).to.be.false;
        });

        it("still opens a market when someone pre-created its vault ATA", async () => {
            // The vault address is predictable and anyone may create an ATA for any owner; with `init`
            // this pre-creation blocked the market forever, `init_if_needed` accepts the existing vault.
            const griefed = await openAgreement();
            const attacker = Keypair.generate();
            await airdrop(provider.connection, attacker.publicKey);
            await createAssociatedTokenAccountIdempotent(
                provider.connection, attacker, stakeMint, findMarketPDA(griefed.agreement), {}, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, true
            );
            const { market, vault } = await createMarket(griefed.agreement);
            expect((await program.account.market.fetch(market)).vault.toBase58()).to.equal(vault.toBase58());
            expect((await getAccount(provider.connection, vault)).owner.toBase58()).to.equal(market.toBase58());
        });
    });

    // ========================
    // Stake
    // ========================

    describe("stake", () => {
        let extra: CreatedAgreement;
        let extraMarket: PublicKey;

        before(async () => {
            extra = await openAgreement();
            ({ market: extraMarket } = await createMarket(extra.agreement));
        });

        it("records both sides in the pools, the vault and the positions", async () => {
            const positionA = await stake(executedMarket, executed.agreement, walletA, SIDE_YES, 300_000);
            const positionB = await stake(executedMarket, executed.agreement, walletB, SIDE_NO, 600_000);

            const market = await program.account.market.fetch(executedMarket);
            expect((market.yesPool as any).toNumber()).to.equal(300_000);
            expect((market.noPool as any).toNumber()).to.equal(600_000);
            expect(await tokenBalance(executedVault)).to.equal(900_000n);

            const yes = await program.account.position.fetch(positionA);
            expect(yes.market.toBase58()).to.equal(executedMarket.toBase58());
            expect(yes.owner.toBase58()).to.equal(walletA.publicKey.toBase58());
            expect(yes.side).to.equal(SIDE_YES);
            expect((yes.amount as any).toNumber()).to.equal(300_000);
            expect(yes.claimed).to.be.false;

            const no = await program.account.position.fetch(positionB);
            expect(no.owner.toBase58()).to.equal(walletB.publicKey.toBase58());
            expect(no.side).to.equal(SIDE_NO);
            expect((no.amount as any).toNumber()).to.equal(600_000);
        });

        it("adds a further stake on the same side to the same position", async () => {
            const first = await stake(extraMarket, extra.agreement, walletA, SIDE_YES, 100_000);
            const second = await stake(extraMarket, extra.agreement, walletA, SIDE_YES, 150_000);
            expect(second.toBase58()).to.equal(first.toBase58());

            const position = await program.account.position.fetch(first);
            expect((position.amount as any).toNumber()).to.equal(250_000);

            const market = await program.account.market.fetch(extraMarket);
            expect((market.yesPool as any).toNumber()).to.equal(250_000);
            expect((market.noPool as any).toNumber()).to.equal(0);
            expect(await tokenBalance(findVault(extraMarket))).to.equal(250_000n);
        });

        it("rejects a side other than 0 or 1", async () => {
            await expectFailure(() => stake(extraMarket, extra.agreement, walletA, 2, 10_000), "InvalidSide");

            const market = await program.account.market.fetch(extraMarket);
            expect((market.yesPool as any).toNumber()).to.equal(250_000);
            expect((market.noPool as any).toNumber()).to.equal(0);
        });

        it("rejects a zero stake", async () => {
            await expectFailure(() => stake(extraMarket, extra.agreement, walletA, SIDE_YES, 0), "ZeroAmount");

            const position = await program.account.position.fetch(findPositionPDA(extraMarket, walletA.publicKey, SIDE_YES));
            expect((position.amount as any).toNumber()).to.equal(250_000);
        });

        it("rejects another agreement passed alongside the market", async () => {
            await expectFailure(() => stake(extraMarket, executed.agreement, walletA, SIDE_YES, 10_000), "InvalidProposalAccount");
            expect(((await program.account.market.fetch(extraMarket)).yesPool as any).toNumber()).to.equal(250_000);
        });
    });

    // ========================
    // Resolve and claim (Executed → YES)
    // ========================

    describe("resolve and claim after the agreement executes", () => {
        it("refuses to resolve while the agreement is still active", async () => {
            await expectFailure(() => resolve(executedMarket, executed.agreement), "NotTerminal");
            expect((await program.account.market.fetch(executedMarket)).resolved).to.be.false;
        });

        it("refuses a claim before resolution", async () => {
            await expectFailure(() => claim(executedMarket, walletA, SIDE_YES), "MarketNotResolved");

            const position = await program.account.position.fetch(findPositionPDA(executedMarket, walletA.publicKey, SIDE_YES));
            expect(position.claimed).to.be.false;
            expect(await tokenBalance(executedVault)).to.equal(900_000n);
        });

        it("keeps the market open on a recorded decision: only execution settles it", async () => {
            await attestSatisfied(agreementProgram, notary, {
                agreement: executed.agreement, cid: executed.cid, sponsor: executed.sponsor.publicKey,
            });
            expect(await statusByte(provider.connection, executed.agreement)).to.equal(STATUS.active);
            await expectFailure(() => resolve(executedMarket, executed.agreement), "NotTerminal");
        });

        it("resolves to YES once the agreement is executed", async () => {
            await executeAgreement(agreementProgram, executed.agreement, executed.sponsor.publicKey);
            expect(await statusByte(provider.connection, executed.agreement)).to.equal(STATUS.executed);
            await resolve(executedMarket, executed.agreement);

            const market = await program.account.market.fetch(executedMarket);
            expect(market.resolved).to.be.true;
            expect(market.outcome).to.equal(SIDE_YES);
        });

        it("rejects a stake after resolution", async () => {
            await expectFailure(() => stake(executedMarket, executed.agreement, walletB, SIDE_NO, 10_000), "MarketResolved");

            const market = await program.account.market.fetch(executedMarket);
            expect((market.noPool as any).toNumber()).to.equal(600_000);
            expect(await tokenBalance(executedVault)).to.equal(900_000n);
        });

        it("pays the whole pot to the only winner", async () => {
            const before = await tokenBalance(walletA.tokenAccount);
            const position = await claim(executedMarket, walletA, SIDE_YES);
            const after = await tokenBalance(walletA.tokenAccount);

            expect(after - before).to.equal(900_000n);
            expect((await program.account.position.fetch(position)).claimed).to.be.true;
            expect(await tokenBalance(executedVault)).to.equal(0n);
        });

        it("pays a loser nothing", async () => {
            const before = await tokenBalance(walletB.tokenAccount);
            await expectFailure(() => claim(executedMarket, walletB, SIDE_NO), "NothingToClaim");

            expect(await tokenBalance(walletB.tokenAccount)).to.equal(before);
            const position = await program.account.position.fetch(findPositionPDA(executedMarket, walletB.publicKey, SIDE_NO));
            expect(position.claimed).to.be.false;
        });

        it("rejects a second claim on the same position", async () => {
            const before = await tokenBalance(walletA.tokenAccount);
            await expectFailure(() => claim(executedMarket, walletA, SIDE_YES), "AlreadyClaimed");

            expect(await tokenBalance(walletA.tokenAccount)).to.equal(before);
            expect(await tokenBalance(executedVault)).to.equal(0n);
        });
    });

    // ========================
    // Resolve and claim (Cancelled → NO, nobody on the winning side)
    // ========================

    describe("resolve and claim after the agreement is cancelled", () => {
        let cancelled: CreatedAgreement;
        let cancelledMarket: PublicKey;
        let cancelledVault: PublicKey;

        before(async () => {
            cancelled = await openAgreement();
            ({ market: cancelledMarket, vault: cancelledVault } = await createMarket(cancelled.agreement));
            await stake(cancelledMarket, cancelled.agreement, walletA, SIDE_YES, 250_000);
            await cancelSubject(cancelled);
        });

        it("resolves to NO when the agreement is cancelled", async () => {
            await resolve(cancelledMarket, cancelled.agreement);

            const market = await program.account.market.fetch(cancelledMarket);
            expect(market.resolved).to.be.true;
            expect(market.outcome).to.equal(SIDE_NO);
            expect((market.yesPool as any).toNumber()).to.equal(250_000);
            expect((market.noPool as any).toNumber()).to.equal(0);
        });

        it("refunds every stake when nobody backed the winning side", async () => {
            const before = await tokenBalance(walletA.tokenAccount);
            const position = await claim(cancelledMarket, walletA, SIDE_YES);
            const after = await tokenBalance(walletA.tokenAccount);

            expect(after - before).to.equal(250_000n);
            expect((await program.account.position.fetch(position)).claimed).to.be.true;
            expect(await tokenBalance(cancelledVault)).to.equal(0n);
        });
    });

    // ========================
    // Resolve and claim (Expired after its deadline → NO)
    // ========================

    describe("resolve and claim after the agreement expires", () => {
        let expiring: CreatedAgreement;
        let expiringMarket: PublicKey;
        let deadline: number;

        before(async () => {
            deadline = (await chainNow(provider.connection)) + 20;
            expiring = await openAgreement(deadline);
            ({ market: expiringMarket } = await createMarket(expiring.agreement));
            await stake(expiringMarket, expiring.agreement, walletA, SIDE_YES, 100_000);
            await stake(expiringMarket, expiring.agreement, walletB, SIDE_NO, 300_000);
        });

        it("refuses to resolve while the agreement is Active, even once its deadline has passed", async () => {
            await expectFailure(() => resolve(expiringMarket, expiring.agreement), "NotTerminal");
            // A deadline does not resolve NO by itself: someone expires the account first.
            await waitForChainTime(provider.connection, deadline + 1);
            await expectFailure(() => resolve(expiringMarket, expiring.agreement), "NotTerminal");
        });

        it("resolves to NO once anyone expires the agreement (status 3)", async () => {
            await expireAgreement(agreementProgram, expiring.agreement, expiring.sponsor.publicKey);
            expect(await statusByte(provider.connection, expiring.agreement)).to.equal(STATUS.expired);
            await resolve(expiringMarket, expiring.agreement);

            const market = await program.account.market.fetch(expiringMarket);
            expect(market.resolved).to.be.true;
            expect(market.outcome).to.equal(SIDE_NO);
        });

        it("pays the NO side the whole pot", async () => {
            const before = await tokenBalance(walletB.tokenAccount);
            await claim(expiringMarket, walletB, SIDE_NO);
            expect((await tokenBalance(walletB.tokenAccount)) - before).to.equal(400_000n);
            await expectFailure(() => claim(expiringMarket, walletA, SIDE_YES), "NothingToClaim");
        });
    });

    // ========================
    // External markets bound to an agreement's lens
    // ========================

    describe("create_external_market with an agreement", () => {
        let credential: PublicKey;
        let schema: PublicKey;
        let lensAgreement: CreatedAgreement;

        before(async () => {
            credential = await writeSasAccount(provider, credentialBytes(notary.publicKey, "court"));
            schema = await writeSasAccount(provider, schemaBytes(credential, "CourtParcelOperation"));
            lensAgreement = await openAgreement();
        });

        async function createExternal(label: string, trustedAttester: PublicKey, subject?: PublicKey) {
            const recipeHash = createHash("sha256").update(`ext-${label}-${Keypair.generate().publicKey.toBase58()}`).digest();
            const market = PublicKey.findProgramAddressSync([Buffer.from("external_market"), recipeHash], program.programId)[0];
            await program.methods
                .createExternalMarket(
                    Array.from(recipeHash),
                    Array.from(createHash("sha256").update("HR-mkt-ext-lens").digest()),
                    Array.from(createHash("sha256").update("transfer").digest()),
                    Array.from(createHash("sha256").update("dismissed").digest()),
                    trustedAttester,
                    new anchor.BN((await chainNow(provider.connection)) + 3600)
                )
                .accountsStrict({
                    market,
                    stakeMint,
                    vault: getAssociatedTokenAddressSync(stakeMint, market, true),
                    credential,
                    schema,
                    creator: provider.wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .remainingAccounts(subject ? [{ pubkey: subject, isSigner: false, isWritable: false }] : [])
                .rpc();
            return program.account.externalMarket.fetch(market);
        }

        it("rejects a trusted attester that is not the agreement's lens", async () => {
            await expectFailure(
                () => createExternal("outside", Keypair.generate().publicKey, lensAgreement.agreement),
                "AttesterNotInProposalLens"
            );
        });

        it("opens the market when the trusted attester is the agreement's lens", async () => {
            const market = await createExternal("inside", notary.publicKey, lensAgreement.agreement);
            expect(market.trustedAttester.toBase58()).to.equal(notary.publicKey.toBase58());
        });

        it("rejects a bound account that is not an agreement", async () => {
            const lookalike = await writeAgreementLookalike(provider, { authority: payer.publicKey, lens: notary.publicKey });
            await expectFailure(() => createExternal("not-agreement", notary.publicKey, lookalike), "InvalidProposalAccount");
        });

        it("still opens an unbound market without the agreement account", async () => {
            const attester = Keypair.generate().publicKey;
            const market = await createExternal("unbound", attester);
            expect(market.trustedAttester.toBase58()).to.equal(attester.toBase58());
        });
    });

    // ========================
    // Parimutuel split between two winners
    // ========================

    describe("parimutuel payout", () => {
        let split: CreatedAgreement;
        let splitMarket: PublicKey;
        let splitVault: PublicKey;

        before(async () => {
            split = await openAgreement();
            ({ market: splitMarket, vault: splitVault } = await createMarket(split.agreement));
            await stake(splitMarket, split.agreement, walletA, SIDE_YES, 100_000);
            await stake(splitMarket, split.agreement, walletB, SIDE_YES, 200_000);
            await stake(splitMarket, split.agreement, walletC, SIDE_NO, 600_000);
            await executeSubject(split);
            await resolve(splitMarket, split.agreement);
        });

        it("splits the whole pot between the winners in proportion to their stakes", async () => {
            const market = await program.account.market.fetch(splitMarket);
            expect((market.yesPool as any).toNumber()).to.equal(300_000);
            expect((market.noPool as any).toNumber()).to.equal(600_000);
            expect(market.outcome).to.equal(SIDE_YES);
            expect(await tokenBalance(splitVault)).to.equal(900_000n);

            const beforeA = await tokenBalance(walletA.tokenAccount);
            await claim(splitMarket, walletA, SIDE_YES);
            expect((await tokenBalance(walletA.tokenAccount)) - beforeA).to.equal(300_000n);

            const beforeB = await tokenBalance(walletB.tokenAccount);
            await claim(splitMarket, walletB, SIDE_YES);
            expect((await tokenBalance(walletB.tokenAccount)) - beforeB).to.equal(600_000n);

            expect(await tokenBalance(splitVault)).to.equal(0n);
        });

        it("pays the losing side nothing", async () => {
            const before = await tokenBalance(walletC.tokenAccount);
            await expectFailure(() => claim(splitMarket, walletC, SIDE_NO), "NothingToClaim");
            expect(await tokenBalance(walletC.tokenAccount)).to.equal(before);
        });
    });
});
