// Localnet suite for the proposal_market program: opens a parimutuel market on a proposal_nft
// Proposal and drives it through staking, resolution (Executed → YES, Cancelled → NO) and payout.

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
import {
    findProposalCounterPDA,
    findProposalPDA,
    findParcelPDA,
    airdrop,
    initializeProposalCounter,
} from "./helpers.ts";

const SIDE_NO = 0;
const SIDE_YES = 1;

/** Every staker starts with 10 tokens (6 decimals); stakes below are in base units. */
const STAKER_FUNDING = 10_000_000;

describe("proposal_market", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalMarket as Program;
    const proposalProgram = anchor.workspace.ProposalNft as Program;
    const parcelProgram = anchor.workspace.ParcelNft as Program;

    const payer = (provider.wallet as any).payer as Keypair;

    type Staker = { keypair: Keypair; publicKey: PublicKey; tokenAccount: PublicKey };

    let counterPDA: PublicKey;
    let stakeMint: PublicKey;
    let walletA: Staker; // the provider wallet
    let walletB: Staker;
    let walletC: Staker;

    // The executed-proposal market, shared by the create_market / stake / resolve blocks.
    let executedProposal: PublicKey;
    let executedMarket: PublicKey;
    let executedVault: PublicKey;

    before(async () => {
        // proposal_nft.ts initializes the counter in its own before() and both files run against
        // one validator under `anchor test`, so only initialize when nobody has yet.
        const [counter] = findProposalCounterPDA(proposalProgram.programId);
        const existing = await proposalProgram.account.proposalCounter.fetchNullable(counter);
        counterPDA = existing ? counter : await initializeProposalCounter(proposalProgram, payer);

        stakeMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
        walletA = await fundStaker(payer);
        walletB = await fundStaker(Keypair.generate());
        walletC = await fundStaker(Keypair.generate());

        ({ proposalPDA: executedProposal } = await mintProposal(["HR-mkt-exec"], false));
    });

    // ========================
    // Helpers
    // ========================

    async function fundStaker(keypair: Keypair): Promise<Staker> {
        if (!keypair.publicKey.equals(payer.publicKey)) {
            await airdrop(provider.connection, keypair.publicKey);
        }
        const ata = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            payer,
            stakeMint,
            keypair.publicKey
        );
        await mintTo(provider.connection, payer, stakeMint, ata.address, payer, STAKER_FUNDING);
        return { keypair, publicKey: keypair.publicKey, tokenAccount: ata.address };
    }

    async function getCounterValue(): Promise<number> {
        const account = await proposalProgram.account.proposalCounter.fetch(counterPDA);
        return (account.count as any).toNumber();
    }

    async function mintParcelForOwner(
        parcelId: string,
        owner: PublicKey = provider.wallet.publicKey,
        signer?: Keypair
    ): Promise<PublicKey> {
        const [parcelPDA] = findParcelPDA(parcelProgram.programId, parcelId);
        const builder = parcelProgram.methods
            .mintParcel(parcelId, `ipfs://${parcelId}`)
            .accounts({
                parcel: parcelPDA,
                owner,
                systemProgram: SystemProgram.programId,
            } as any);

        if (signer) {
            await builder.signers([signer]).rpc();
        } else {
            await builder.rpc();
        }

        return parcelPDA;
    }

    async function mintProposal(
        parcelIds: string[],
        isConditional: boolean,
        solAmount: number = 0
    ): Promise<{ proposalId: number; proposalPDA: PublicKey }> {
        for (const parcelId of parcelIds) {
            await mintParcelForOwner(parcelId);
        }

        const count = await getCounterValue();
        const [proposalPDA] = findProposalPDA(proposalProgram.programId, count);

        await proposalProgram.methods
            .mintAndFund(
                parcelIds,
                isConditional,
                "ipfs://test-image",
                new anchor.BN(solAmount),
                [provider.wallet.publicKey] // lens
            )
            .accounts({
                proposal: proposalPDA,
                proposalCounter: counterPDA,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        return { proposalId: count, proposalPDA };
    }

    function actionAccounts(
        proposalPDA: PublicKey,
        parcelId: string,
        signerName: "accepter" | "withdrawer",
        signer: PublicKey = provider.wallet.publicKey
    ): any {
        const [parcelPDA] = findParcelPDA(parcelProgram.programId, parcelId);
        return {
            proposal: proposalPDA,
            parcel: parcelPDA,
            parcelProgram: parcelProgram.programId,
            [signerName]: signer,
        };
    }

    /** Accept the only parcel of a single-parcel proposal, which flips it to Executed. */
    async function executeProposal(proposalPDA: PublicKey, parcelId: string) {
        await proposalProgram.methods
            .acceptProposal(parcelId)
            .accounts(actionAccounts(proposalPDA, parcelId, "accepter"))
            .rpc();

        const account = await proposalProgram.account.proposal.fetch(proposalPDA);
        expect(account.status).to.deep.equal({ executed: {} });
    }

    /** Cancel an Active proposal as its owner, which flips it to Cancelled. */
    async function cancelProposal(proposalPDA: PublicKey) {
        await proposalProgram.methods
            .cancelAndRefund()
            .accounts({
                proposal: proposalPDA,
                owner: provider.wallet.publicKey,
            } as any)
            .rpc();

        const account = await proposalProgram.account.proposal.fetch(proposalPDA);
        expect(account.status).to.deep.equal({ cancelled: {} });
    }

    function findMarketPDA(proposal: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("market"), proposal.toBuffer()],
            program.programId
        )[0];
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

    async function createMarket(proposal: PublicKey): Promise<{ market: PublicKey; vault: PublicKey }> {
        const market = findMarketPDA(proposal);
        const vault = findVault(market);

        await program.methods
            .createMarket()
            .accounts({
                market,
                proposal,
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

    async function stake(
        market: PublicKey,
        proposal: PublicKey,
        staker: Staker,
        side: number,
        amount: number
    ): Promise<PublicKey> {
        const position = findPositionPDA(market, staker.publicKey, side);

        await program.methods
            .stake(side, new anchor.BN(amount))
            .accounts({
                market,
                proposal,
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

    async function resolve(market: PublicKey, proposal: PublicKey) {
        await program.methods
            .resolve()
            .accounts({ market, proposal } as any)
            .rpc();
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
        return [
            err?.error?.errorCode?.code,
            err?.message,
            String(err),
            Array.isArray(logs) ? logs.join("\n") : "",
        ]
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
        it("opens a market on an active proposal with empty pools and a market-owned vault", async () => {
            const created = await createMarket(executedProposal);
            executedMarket = created.market;
            executedVault = created.vault;

            const market = await program.account.market.fetch(executedMarket);
            expect(market.proposal.toBase58()).to.equal(executedProposal.toBase58());
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

        it("rejects a market on an account that is not a proposal", async () => {
            // The mint is owned by the token program, not proposal_nft.
            await expectFailure(() => createMarket(stakeMint), "InvalidProposalAccount");

            const ghost = findMarketPDA(stakeMint);
            expect(await program.account.market.fetchNullable(ghost)).to.be.null;
        });

        it("rejects a second market on the same proposal", async () => {
            await expectFailure(
                () => createMarket(executedProposal),
                /already in use|custom program error: 0x0/
            );

            const market = await program.account.market.fetch(executedMarket);
            expect(market.proposal.toBase58()).to.equal(executedProposal.toBase58());
            expect(market.resolved).to.be.false;
        });

        it("still opens a market when someone pre-created its vault ATA", async () => {
            // The vault address is predictable and anyone may create an ATA for any owner; with `init`
            // this pre-creation blocked the market forever, `init_if_needed` accepts the existing vault.
            const { proposalPDA: griefed } = await mintProposal(["HR-mkt-grief"], false);
            const attacker = Keypair.generate();
            await airdrop(provider.connection, attacker.publicKey);
            await createAssociatedTokenAccountIdempotent(
                provider.connection, attacker, stakeMint, findMarketPDA(griefed), {}, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, true
            );
            const { market, vault } = await createMarket(griefed);
            expect((await program.account.market.fetch(market)).vault.toBase58()).to.equal(vault.toBase58());
            expect((await getAccount(provider.connection, vault)).owner.toBase58()).to.equal(market.toBase58());
        });
    });

    // ========================
    // Stake
    // ========================

    describe("stake", () => {
        let extraProposal: PublicKey;
        let extraMarket: PublicKey;

        before(async () => {
            ({ proposalPDA: extraProposal } = await mintProposal(["HR-mkt-extra"], false));
            ({ market: extraMarket } = await createMarket(extraProposal));
        });

        it("records both sides in the pools, the vault and the positions", async () => {
            const positionA = await stake(executedMarket, executedProposal, walletA, SIDE_YES, 300_000);
            const positionB = await stake(executedMarket, executedProposal, walletB, SIDE_NO, 600_000);

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
            const first = await stake(extraMarket, extraProposal, walletA, SIDE_YES, 100_000);
            const second = await stake(extraMarket, extraProposal, walletA, SIDE_YES, 150_000);
            expect(second.toBase58()).to.equal(first.toBase58());

            const position = await program.account.position.fetch(first);
            expect((position.amount as any).toNumber()).to.equal(250_000);

            const market = await program.account.market.fetch(extraMarket);
            expect((market.yesPool as any).toNumber()).to.equal(250_000);
            expect((market.noPool as any).toNumber()).to.equal(0);
            expect(await tokenBalance(findVault(extraMarket))).to.equal(250_000n);
        });

        it("rejects a side other than 0 or 1", async () => {
            await expectFailure(
                () => stake(extraMarket, extraProposal, walletA, 2, 10_000),
                "InvalidSide"
            );

            const market = await program.account.market.fetch(extraMarket);
            expect((market.yesPool as any).toNumber()).to.equal(250_000);
            expect((market.noPool as any).toNumber()).to.equal(0);
        });

        it("rejects a zero stake", async () => {
            await expectFailure(
                () => stake(extraMarket, extraProposal, walletA, SIDE_YES, 0),
                "ZeroAmount"
            );

            const position = await program.account.position.fetch(
                findPositionPDA(extraMarket, walletA.publicKey, SIDE_YES)
            );
            expect((position.amount as any).toNumber()).to.equal(250_000);
        });
    });

    // ========================
    // Resolve and claim (Executed → YES)
    // ========================

    describe("resolve and claim after the proposal executes", () => {
        it("refuses to resolve while the proposal is still active", async () => {
            await expectFailure(() => resolve(executedMarket, executedProposal), "NotTerminal");

            const market = await program.account.market.fetch(executedMarket);
            expect(market.resolved).to.be.false;
        });

        it("refuses a claim before resolution", async () => {
            await expectFailure(() => claim(executedMarket, walletA, SIDE_YES), "MarketNotResolved");

            const position = await program.account.position.fetch(
                findPositionPDA(executedMarket, walletA.publicKey, SIDE_YES)
            );
            expect(position.claimed).to.be.false;
            expect(await tokenBalance(executedVault)).to.equal(900_000n);
        });

        it("resolves to YES once the proposal is executed", async () => {
            await executeProposal(executedProposal, "HR-mkt-exec");
            await resolve(executedMarket, executedProposal);

            const market = await program.account.market.fetch(executedMarket);
            expect(market.resolved).to.be.true;
            expect(market.outcome).to.equal(SIDE_YES);
        });

        it("rejects a stake after resolution", async () => {
            await expectFailure(
                () => stake(executedMarket, executedProposal, walletB, SIDE_NO, 10_000),
                "MarketResolved"
            );

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
            const position = await program.account.position.fetch(
                findPositionPDA(executedMarket, walletB.publicKey, SIDE_NO)
            );
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

    describe("resolve and claim after the proposal is cancelled", () => {
        let cancelledProposal: PublicKey;
        let cancelledMarket: PublicKey;
        let cancelledVault: PublicKey;

        before(async () => {
            ({ proposalPDA: cancelledProposal } = await mintProposal(["HR-mkt-cancel"], true));
            ({ market: cancelledMarket, vault: cancelledVault } = await createMarket(cancelledProposal));
            await stake(cancelledMarket, cancelledProposal, walletA, SIDE_YES, 250_000);
            await cancelProposal(cancelledProposal);
        });

        it("resolves to NO when the proposal is cancelled", async () => {
            await resolve(cancelledMarket, cancelledProposal);

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
    // Parimutuel split between two winners
    // ========================

    describe("parimutuel payout", () => {
        let splitProposal: PublicKey;
        let splitMarket: PublicKey;
        let splitVault: PublicKey;

        before(async () => {
            ({ proposalPDA: splitProposal } = await mintProposal(["HR-mkt-split"], false));
            ({ market: splitMarket, vault: splitVault } = await createMarket(splitProposal));
            await stake(splitMarket, splitProposal, walletA, SIDE_YES, 100_000);
            await stake(splitMarket, splitProposal, walletB, SIDE_YES, 200_000);
            await stake(splitMarket, splitProposal, walletC, SIDE_NO, 600_000);
            await executeProposal(splitProposal, "HR-mkt-split");
            await resolve(splitMarket, splitProposal);
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
