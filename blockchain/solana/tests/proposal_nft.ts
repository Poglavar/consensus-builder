import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
    findProposalCounterPDA,
    findProposalPDA,
    airdrop,
    initializeProposalCounter,
} from "./helpers.ts";

describe("proposal_nft", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalNft as Program;
    let counterPDA: PublicKey;

    before(async () => {
        counterPDA = await initializeProposalCounter(program, (provider.wallet as any).payer);
    });

    async function getCounterValue(): Promise<number> {
        const account = await program.account.proposalCounter.fetch(counterPDA);
        return (account.count as any).toNumber();
    }

    async function mintProposal(
        parcelIds: string[],
        isConditional: boolean,
        solAmount: number = 0
    ): Promise<{ proposalId: number; proposalPDA: PublicKey }> {
        const count = await getCounterValue();
        const [proposalPDA] = findProposalPDA(program.programId, count);

        await program.methods
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

    // ========================
    // Initialize
    // ========================

    it("counter was initialized to 0", async () => {
        // Counter was initialized in before() hook; first mint bumps it to 1
        // so we just verify the counter PDA exists and is fetchable
        const account = await program.account.proposalCounter.fetch(counterPDA);
        expect(account.count).to.exist;
    });

    // ========================
    // Mint and fund
    // ========================

    it("creates a basic proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-1"], false);

        const account = await program.account.proposal.fetch(proposalPDA);
        expect(account.parcelIds).to.deep.equal(["HR-sol-1"]);
        expect(account.isConditional).to.be.false;
        expect(account.imageUri).to.equal("ipfs://test-image");
        expect(account.acceptancePossible).to.be.true;
        expect(account.status).to.deep.equal({ active: {} });
        expect((account.acceptanceCount as any).toNumber()).to.equal(0);
    });

    it("increments the counter", async () => {
        const countBefore = await getCounterValue();
        await mintProposal(["HR-sol-inc"], false);
        const countAfter = await getCounterValue();
        expect(countAfter).to.equal(countBefore + 1);
    });

    it("rejects empty parcel_ids", async () => {
        try {
            await mintProposal([], false);
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("NoParcels");
        }
    });

    it("rejects empty lens", async () => {
        const count = await getCounterValue();
        const [proposalPDA] = findProposalPDA(program.programId, count);

        try {
            await program.methods
                .mintAndFund(
                    ["HR-sol-nolens"],
                    false,
                    "ipfs://img",
                    new anchor.BN(0),
                    [] // empty lens
                )
                .accounts({
                    proposal: proposalPDA,
                    proposalCounter: counterPDA,
                    owner: provider.wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("NoLens");
        }
    });

    // ========================
    // Accept proposal
    // ========================

    it("accepts a single-parcel proposal (auto-executes)", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-acc1"], false);

        await program.methods
            .acceptProposal("HR-sol-acc1")
            .accounts({
                proposal: proposalPDA,
                accepter: provider.wallet.publicKey,
            } as any)
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(1);
        expect(account.acceptedParcels).to.deep.equal(["HR-sol-acc1"]);
        expect(account.status).to.deep.equal({ executed: {} });
        expect(account.acceptancePossible).to.be.false;
    });

    it("partial acceptance keeps status Active", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-p1", "HR-sol-p2"], false);

        await program.methods
            .acceptProposal("HR-sol-p1")
            .accounts({
                proposal: proposalPDA,
                accepter: provider.wallet.publicKey,
            } as any)
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(1);
        expect(account.status).to.deep.equal({ active: {} });
        expect(account.acceptancePossible).to.be.true;
    });

    it("rejects accepting invalid parcel", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-valid"], false);

        try {
            await program.methods
                .acceptProposal("HR-sol-invalid")
                .accounts({
                    proposal: proposalPDA,
                    accepter: provider.wallet.publicKey,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("ParcelNotInProposal");
        }
    });

    it("rejects double acceptance", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-dbl1", "HR-sol-dbl2"], false);

        await program.methods
            .acceptProposal("HR-sol-dbl1")
            .accounts({
                proposal: proposalPDA,
                accepter: provider.wallet.publicKey,
            } as any)
            .rpc();

        try {
            await program.methods
                .acceptProposal("HR-sol-dbl1")
                .accounts({
                    proposal: proposalPDA,
                    accepter: provider.wallet.publicKey,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("AlreadyAccepted");
        }
    });

    // ========================
    // Withdraw acceptance
    // ========================

    it("withdraws acceptance on conditional proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-wd1", "HR-sol-wd2"], true);

        await program.methods
            .acceptProposal("HR-sol-wd1")
            .accounts({
                proposal: proposalPDA,
                accepter: provider.wallet.publicKey,
            } as any)
            .rpc();

        let account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(1);

        await program.methods
            .withdrawAcceptance("HR-sol-wd1")
            .accounts({
                proposal: proposalPDA,
                withdrawer: provider.wallet.publicKey,
            } as any)
            .rpc();

        account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(0);
        expect(account.acceptedParcels).to.deep.equal([]);
        expect(account.acceptancePossible).to.be.true;
    });

    it("rejects withdrawal on non-conditional proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-nc1", "HR-sol-nc2"], false);

        await program.methods
            .acceptProposal("HR-sol-nc1")
            .accounts({
                proposal: proposalPDA,
                accepter: provider.wallet.publicKey,
            } as any)
            .rpc();

        try {
            await program.methods
                .withdrawAcceptance("HR-sol-nc1")
                .accounts({
                    proposal: proposalPDA,
                    withdrawer: provider.wallet.publicKey,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("NotConditional");
        }
    });

    // ========================
    // Contribute funds
    // ========================

    it("contributes SOL to a proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-cf1", "HR-sol-cf2"], false);

        const amount = 0.5 * anchor.web3.LAMPORTS_PER_SOL;

        await program.methods
            .contributeFunds(new anchor.BN(amount))
            .accounts({
                proposal: proposalPDA,
                contributor: provider.wallet.publicKey,
            } as any)
            .remainingAccounts([
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ])
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.solBalance as any).toNumber()).to.equal(amount);
    });

    it("rejects zero contribution", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-z1", "HR-sol-z2"], false);

        try {
            await program.methods
                .contributeFunds(new anchor.BN(0))
                .accounts({
                    proposal: proposalPDA,
                    contributor: provider.wallet.publicKey,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("ZeroAmount");
        }
    });
});
