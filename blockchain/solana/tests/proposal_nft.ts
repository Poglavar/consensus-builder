// Localnet suite for proposal_nft v2 (the lens model, lens-model.md): mint and fund, attested
// acceptance by the owners a lens member names, verdict settlement, record-based distribution,
// and the forgeries each instruction must reject.

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
import {
    LensMember,
    OWNERSHIP_SCHEMA,
    VERDICT_SCHEMA,
    acceptWithAttestation,
    attestAndAccept,
    attestOwnership,
    attestVerdict,
    attestationBytes,
    createLensMember,
    ensureParcelAnchor,
    findRecord,
    findTally,
    chainNow,
    schemaPda,
    sha256,
    verdictPayload,
    writeSasAccount,
} from "./sas-mock.ts";

describe("proposal_nft", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalNft as Program;
    const parcelProgram = anchor.workspace.ParcelNft as Program;
    let counterPDA: PublicKey;

    // notary: the usual lens member. court: a second member for multi-member lenses. outsider: a
    // well-formed SAS issuer that no proposal below lists.
    let notary: LensMember;
    let court: LensMember;
    let outsider: LensMember;

    before(async () => {
        // proposal_market.ts runs first (mocha sorts files by name) and initializes the counter
        // when it is absent; a second `initialize` on the existing PDA would fail this whole file.
        const [counter] = findProposalCounterPDA(program.programId);
        counterPDA = (await program.account.proposalCounter.fetchNullable(counter))
            ? counter
            : await initializeProposalCounter(program, (provider.wallet as any).payer);
        [notary, court, outsider] = await Promise.all([
            createLensMember(provider), createLensMember(provider), createLensMember(provider),
        ]);
    });

    function findVerdictRecord(proposal: PublicKey, verdict: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("verdict"), proposal.toBuffer(), verdict.toBuffer()],
            program.programId
        )[0];
    }

    // settle_with_verdict with its full account list, including the VerdictRecord PDA the
    // submitter pays for.
    async function settleWithVerdict(
        proposalProgram: Program,
        a: { proposal: PublicKey; verdict: PublicKey; credential: PublicKey }
    ): Promise<string> {
        return proposalProgram.methods
            .settleWithVerdict()
            .accountsStrict({
                proposal: a.proposal,
                verdict: a.verdict,
                verdictCredential: a.credential,
                verdictRecord: findVerdictRecord(a.proposal, a.verdict),
                submitter: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    async function getCounterValue(): Promise<number> {
        const account = await program.account.proposalCounter.fetch(counterPDA);
        return (account.count as any).toNumber();
    }

    async function mintProposal(
        parcelIds: string[],
        isConditional: boolean,
        solAmount: number = 0,
        opts: { lens?: PublicKey[]; verdictMayExecute?: boolean } = {}
    ): Promise<{ proposalId: number; proposalPDA: PublicKey }> {
        for (const parcelId of parcelIds) {
            await ensureParcelAnchor(parcelProgram, parcelId);
        }

        const count = await getCounterValue();
        const [proposalPDA] = findProposalPDA(program.programId, count);

        await program.methods
            .mintAndFund(
                parcelIds,
                isConditional,
                "ipfs://test-image",
                new anchor.BN(solAmount),
                opts.lens ?? [notary.publicKey],
                opts.verdictMayExecute ?? false
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

    async function fundedKeypair(): Promise<Keypair> {
        const kp = Keypair.generate();
        await airdrop(provider.connection, kp.publicKey, anchor.web3.LAMPORTS_PER_SOL);
        return kp;
    }

    async function status(proposal: PublicKey) {
        return (await program.account.proposal.fetch(proposal)).status;
    }

    /** Anchor puts the code on err.error.errorCode.code; a raw runtime failure only has logs. */
    function errorText(err: any): string {
        const logs = err?.logs ?? err?.transactionLogs ?? err?.error?.logs ?? [];
        return [err?.error?.errorCode?.code, err?.message, String(err), Array.isArray(logs) ? logs.join("\n") : ""]
            .filter(Boolean).join("\n");
    }

    /** Run `fn`, require it to fail, and assert the Anchor error code (string) or log text (RegExp). */
    async function expectFailure(fn: () => Promise<any>, expected: string | RegExp) {
        let thrown: any;
        try {
            await fn();
        } catch (err: any) {
            thrown = err;
        }
        expect(thrown, `expected a failure matching ${expected}`).to.exist;
        if (typeof expected === "string") {
            expect(thrown?.error?.errorCode?.code, errorText(thrown)).to.equal(expected);
        } else {
            expect(errorText(thrown)).to.match(expected);
        }
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
        expect(account.lens.map((k: PublicKey) => k.toBase58())).to.deep.equal([notary.publicKey.toBase58()]);
        expect(account.verdictMayExecute).to.be.false;
    });

    it("increments the counter", async () => {
        const countBefore = await getCounterValue();
        await mintProposal(["HR-sol-inc"], false);
        const countAfter = await getCounterValue();
        expect(countAfter).to.equal(countBefore + 1);
    });

    it("rejects empty parcel_ids", async () => {
        await expectFailure(() => mintProposal([], false), "NoParcels");
    });

    it("rejects empty lens", async () => {
        await expectFailure(() => mintProposal(["HR-sol-nolens"], false, 0, { lens: [] }), "NoLens");
    });

    // ========================
    // accept_with_attestations
    // ========================

    describe("accept_with_attestations", () => {
        it("executes a single-owner parcel from one ownership attestation and the owner's signature", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-happy"], false);
            const owner = await fundedKeypair();
            const payout = Keypair.generate().publicKey;

            const { ownership, bytes } = await attestAndAccept(program, notary, {
                proposal: proposalPDA, parcelId: "HR-lens-happy", owner, payout,
            });

            const account = await program.account.proposal.fetch(proposalPDA);
            expect(account.status).to.deep.equal({ executed: {} });
            expect(account.acceptancePossible).to.be.false;
            expect(account.acceptedParcels).to.deep.equal(["HR-lens-happy"]);
            expect((account.acceptanceCount as any).toNumber()).to.equal(1);

            const tally = await program.account.consentTally.fetch(findTally(program.programId, proposalPDA, "HR-lens-happy"));
            expect(tally.member.toBase58()).to.equal(notary.publicKey.toBase58());
            expect([tally.required, tally.accepted]).to.deep.equal([1, 1]);

            const record = await program.account.acceptanceRecord.fetch(
                findRecord(program.programId, proposalPDA, "HR-lens-happy", owner.publicKey));
            expect(record.proposal.toBase58()).to.equal(proposalPDA.toBase58());
            expect(record.parcelId).to.equal("HR-lens-happy");
            expect(record.owner.toBase58()).to.equal(owner.publicKey.toBase58());
            expect(record.member.toBase58()).to.equal(notary.publicKey.toBase58());
            expect(record.ownershipAttestation.toBase58()).to.equal(ownership.toBase58());
            expect(Buffer.from(record.ownershipHash)).to.deep.equal(sha256(bytes));
            expect(record.payout.toBase58()).to.equal(payout.toBase58());
            expect(Math.abs((record.acceptedAt as any).toNumber() - await chainNow(provider.connection))).to.be.below(120);
        });

        it("needs every co-owner: ownerCount 2 does not execute after one acceptance", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-coown"], false);
            const [alice, bob] = await Promise.all([fundedKeypair(), fundedKeypair()]);
            const parcelId = "HR-lens-coown";

            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId, owner: alice, ownerCount: 2 });
            let account = await program.account.proposal.fetch(proposalPDA);
            expect(account.status).to.deep.equal({ active: {} });
            expect(account.acceptedParcels).to.deep.equal([]);
            const tallyAddress = findTally(program.programId, proposalPDA, parcelId);
            expect((await program.account.consentTally.fetch(tallyAddress)).accepted).to.equal(1);

            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId, owner: bob, ownerCount: 2 });
            account = await program.account.proposal.fetch(proposalPDA);
            expect(account.status).to.deep.equal({ executed: {} });
            expect(account.acceptedParcels).to.deep.equal([parcelId]);
            expect((await program.account.consentTally.fetch(tallyAddress)).accepted).to.equal(2);
        });

        it("keeps a two-parcel proposal Active until the last parcel completes", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-two-a", "HR-lens-two-b"], false);
            const owner = await fundedKeypair();
            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-two-a", owner });
            expect(await status(proposalPDA)).to.deep.equal({ active: {} });
            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-two-b", owner });
            expect(await status(proposalPDA)).to.deep.equal({ executed: {} });
        });

        it("rejects an ownership attestation from a member outside the proposal's lens", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-outsider"], false);
            const owner = await fundedKeypair();
            await expectFailure(
                () => attestAndAccept(program, outsider, { proposal: proposalPDA, parcelId: "HR-lens-outsider", owner }),
                "MemberNotInLens"
            );
        });

        it("rejects a signer other than the attested owner", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-wrong-owner"], false);
            const [owner, impostor] = await Promise.all([fundedKeypair(), fundedKeypair()]);
            const { address } = await attestOwnership(provider, notary, { parcelUid: "HR-lens-wrong-owner", owner: owner.publicKey });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-wrong-owner", owner: impostor,
                    ownership: address, credential: notary.credential,
                }),
                "OwnerMismatch"
            );
        });

        it("rejects an expired ownership attestation", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-expired"], false);
            const owner = await fundedKeypair();
            const { address } = await attestOwnership(provider, notary, {
                parcelUid: "HR-lens-expired", owner: owner.publicKey, expiry: (await chainNow(provider.connection)) - 3600,
            });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-expired", owner, ownership: address, credential: notary.credential,
                }),
                "AttestationExpired"
            );
        });

        it("rejects the same owner accepting twice (replayed acceptance)", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-replay"], false);
            const owner = await fundedKeypair();
            const { ownership } = await attestAndAccept(program, notary, {
                proposal: proposalPDA, parcelId: "HR-lens-replay", owner, ownerCount: 2,
            });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-replay", owner, ownership, credential: notary.credential,
                }),
                /already in use/
            );
            // A fresh attestation for the same owner is the same record PDA, so it cannot count twice either.
            await expectFailure(
                () => attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-replay", owner, ownerCount: 2 }),
                /already in use/
            );
            const tally = await program.account.consentTally.fetch(findTally(program.programId, proposalPDA, "HR-lens-replay"));
            expect(tally.accepted).to.equal(1);
            expect(await status(proposalPDA)).to.deep.equal({ active: {} });
        });

        it("rejects a second member starting over a parcel another member already tallied", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-two-members"], false, 0, {
                lens: [notary.publicKey, court.publicKey],
            });
            const [alice, bob] = await Promise.all([fundedKeypair(), fundedKeypair()]);
            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-two-members", owner: alice, ownerCount: 2 });
            await expectFailure(
                () => attestAndAccept(program, court, { proposal: proposalPDA, parcelId: "HR-lens-two-members", owner: bob, ownerCount: 2 }),
                "TallyMemberMismatch"
            );
        });

        it("rejects an ownerCount that disagrees with the parcel's tally", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-count"], false);
            const [alice, bob] = await Promise.all([fundedKeypair(), fundedKeypair()]);
            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-count", owner: alice, ownerCount: 3 });
            await expectFailure(
                () => attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-count", owner: bob, ownerCount: 2 }),
                "OwnerCountMismatch"
            );
        });

        it("rejects ownerCount 0", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-zero"], false);
            const owner = await fundedKeypair();
            await expectFailure(
                () => attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-zero", owner, ownerCount: 0 }),
                "InvalidOwnerCount"
            );
        });

        it("rejects an attestation about another parcel", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-parcel-a", "HR-lens-parcel-b"], false);
            const owner = await fundedKeypair();
            const { address } = await attestOwnership(provider, notary, { parcelUid: "HR-lens-parcel-b", owner: owner.publicKey });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-parcel-a", owner, ownership: address, credential: notary.credential,
                }),
                "WrongParcel"
            );
        });

        it("rejects a parcel that is not in the proposal", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-in"], false);
            await ensureParcelAnchor(parcelProgram, "HR-lens-not-in");
            const owner = await fundedKeypair();
            await expectFailure(
                () => attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-lens-not-in", owner }),
                "ParcelNotInProposal"
            );
        });

        it("rejects an attestation whose signer is not its credential's authority", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-cred-auth"], false);
            const owner = await fundedKeypair();
            // Signed by the notary key but filed under the outsider's credential.
            const { address } = await attestOwnership(provider, notary, {
                parcelUid: "HR-lens-cred-auth", owner: owner.publicKey, credential: outsider.credential,
            });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-cred-auth", owner, ownership: address, credential: outsider.credential,
                }),
                "CredentialAuthorityMismatch"
            );
        });

        it("rejects a credential account other than the one the attestation names", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-cred-swap"], false);
            const owner = await fundedKeypair();
            const { address } = await attestOwnership(provider, notary, { parcelUid: "HR-lens-cred-swap", owner: owner.publicKey });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-cred-swap", owner, ownership: address, credential: court.credential,
                }),
                "WrongCredential"
            );
        });

        it("rejects an attestation issued under another schema", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-schema"], false);
            const owner = await fundedKeypair();
            const { address } = await attestOwnership(provider, notary, {
                parcelUid: "HR-lens-schema", owner: owner.publicKey, schema: schemaPda(notary.credential, VERDICT_SCHEMA),
            });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-schema", owner, ownership: address, credential: notary.credential,
                }),
                "WrongSchema"
            );
        });

        it("rejects an ownership source time in the future", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-future"], false);
            const owner = await fundedKeypair();
            const { address } = await attestOwnership(provider, notary, {
                parcelUid: "HR-lens-future", owner: owner.publicKey, sourceObservedAt: (await chainNow(provider.connection)) + 3600,
            });
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-future", owner, ownership: address, credential: notary.credential,
                }),
                "AttestationFromFuture"
            );
        });

        it("rejects an attestation account the SAS program does not own", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-not-sas"], false);
            const owner = await fundedKeypair();
            await expectFailure(
                () => acceptWithAttestation(program, {
                    proposal: proposalPDA, parcelId: "HR-lens-not-sas", owner,
                    ownership: counterPDA, credential: notary.credential,
                }),
                "InvalidAttestation"
            );
        });

        it("lets a separate payer fund the records while the owner only signs", async () => {
            const { proposalPDA } = await mintProposal(["HR-lens-payer"], false);
            const owner = Keypair.generate(); // holds no SOL at all
            const payer = await fundedKeypair();
            const { address } = await attestOwnership(provider, notary, { parcelUid: "HR-lens-payer", owner: owner.publicKey });
            await acceptWithAttestation(program, {
                proposal: proposalPDA, parcelId: "HR-lens-payer", owner, payer, ownership: address, credential: notary.credential,
            });
            expect(await status(proposalPDA)).to.deep.equal({ executed: {} });
        });

        it("self-lens (disclosed): a proposer that lists only itself can attest itself and execute", async () => {
            const proposer = await createLensMember(provider, (provider.wallet as any).payer);
            const { proposalPDA } = await mintProposal(["HR-lens-self"], false, 0, { lens: [proposer.publicKey] });
            await attestAndAccept(program, proposer, {
                proposal: proposalPDA, parcelId: "HR-lens-self", owner: (provider.wallet as any).payer,
            });
            expect(await status(proposalPDA)).to.deep.equal({ executed: {} });
        });
    });

    // ========================
    // settle_with_verdict
    // ========================

    // Not covered here: that a VerdictRecord stays readable after its SAS attestation is closed
    // (mock_sas has no close instruction). The record holds the key and hash, not the account.
    describe("settle_with_verdict", () => {
        it("expires an Active proposal (status 3) on a lens member's expired verdict", async () => {
            const { proposalPDA } = await mintProposal(["HR-verdict-exp"], false);
            const verdict = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "expired" });
            await settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential });

            const account = await program.account.proposal.fetch(proposalPDA);
            expect(account.status).to.deep.equal({ expired: {} });
            expect(account.acceptancePossible).to.be.false;
            const raw = (await provider.connection.getAccountInfo(proposalPDA))!.data;
            // Status byte offset: disc 8 + id 8 + owner 32 + parcel_ids + is_conditional + image_uri + acceptance_possible.
            const parcels = 4 + 4 + "HR-verdict-exp".length;
            const image = 4 + "ipfs://test-image".length;
            expect(raw[8 + 8 + 32 + parcels + 1 + image + 1]).to.equal(3);

            // The settlement leaves a permanent VerdictRecord, not only a log event.
            const record = await program.account.verdictRecord.fetch(findVerdictRecord(proposalPDA, verdict));
            expect(record.proposal.toBase58()).to.equal(proposalPDA.toBase58());
            expect(record.member.toBase58()).to.equal(notary.publicKey.toBase58());
            expect(record.verdictAttestation.toBase58()).to.equal(verdict.toBase58());
            const bytes = (await provider.connection.getAccountInfo(verdict))!.data;
            expect(Buffer.from(record.verdictHash)).to.deep.equal(sha256(Buffer.from(bytes)));
            expect(record.verdict).to.equal(3);
            expect(Math.abs((record.settledAt as any).toNumber() - await chainNow(provider.connection))).to.be.below(120);
        });

        it("rejects an executed verdict while parcels still lack consent", async () => {
            const { proposalPDA } = await mintProposal(["HR-verdict-skip"], false);
            const verdict = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "executed" });
            await expectFailure(
                () => settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential }),
                "VerdictCannotSkipConsent"
            );
            // A rejected settlement rolls back the record init with it.
            expect(await provider.connection.getAccountInfo(findVerdictRecord(proposalPDA, verdict))).to.be.null;
        });

        it("executes on an executed verdict when the proposal was minted with verdict_may_execute", async () => {
            const { proposalPDA } = await mintProposal(["HR-verdict-permit"], false, 0, { verdictMayExecute: true });
            expect((await program.account.proposal.fetch(proposalPDA)).verdictMayExecute).to.be.true;
            const verdict = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "executed" });
            await settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential });
            expect(await status(proposalPDA)).to.deep.equal({ executed: {} });
            const record = await program.account.verdictRecord.fetch(findVerdictRecord(proposalPDA, verdict));
            expect(record.verdict).to.equal(1);
            expect(record.verdictAttestation.toBase58()).to.equal(verdict.toBase58());
        });

        it("rejects a verdict from a member outside the lens", async () => {
            const { proposalPDA } = await mintProposal(["HR-verdict-outsider"], false);
            const verdict = await attestVerdict(provider, outsider, { proposalAccount: proposalPDA, verdict: "expired" });
            await expectFailure(
                () => settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: outsider.credential }),
                "MemberNotInLens"
            );
        });

        it("rejects a verdict about another proposal", async () => {
            const { proposalPDA: target } = await mintProposal(["HR-verdict-target"], false);
            const { proposalPDA: other } = await mintProposal(["HR-verdict-other"], false);
            const verdict = await attestVerdict(provider, notary, { proposalAccount: other, verdict: "expired" });
            await expectFailure(
                () => settleWithVerdict(program, { proposal: target, verdict, credential: notary.credential }),
                "WrongProposal"
            );
        });

        it("rejects an unknown verdict value, an expired verdict and a verdict under the ownership schema", async () => {
            const { proposalPDA } = await mintProposal(["HR-verdict-bad"], false);
            const unknown = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "approved" });
            await expectFailure(() => settleWithVerdict(program, { proposal: proposalPDA, verdict: unknown, credential: notary.credential }), "InvalidVerdict");
            const stale = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "expired", expiry: (await chainNow(provider.connection)) - 10 });
            await expectFailure(() => settleWithVerdict(program, { proposal: proposalPDA, verdict: stale, credential: notary.credential }), "AttestationExpired");
            const wrongSchema = await writeSasAccount(provider, attestationBytes({
                credential: notary.credential, schema: schemaPda(notary.credential, OWNERSHIP_SCHEMA),
                payload: verdictPayload({ proposalAccount: proposalPDA, verdict: "expired", sourceObservedAt: (await chainNow(provider.connection)) - 60 }),
                authority: notary.publicKey,
            }));
            await expectFailure(() => settleWithVerdict(program, { proposal: proposalPDA, verdict: wrongSchema, credential: notary.credential }), "WrongSchema");
            expect(await status(proposalPDA)).to.deep.equal({ active: {} });
        });

        it("rejects settling a proposal that is no longer Active", async () => {
            const { proposalPDA } = await mintProposal(["HR-verdict-twice"], false);
            const verdict = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "expired" });
            await settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential });
            // The same attestation cannot settle twice: its VerdictRecord already exists.
            await expectFailure(() => settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential }), /already in use/);
            // A fresh attestation gets past the record init and fails on the status instead.
            const second = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "expired" });
            await expectFailure(() => settleWithVerdict(program, { proposal: proposalPDA, verdict: second, credential: notary.credential }), "NotActive");
            expect(await provider.connection.getAccountInfo(findVerdictRecord(proposalPDA, second))).to.be.null;
            const owner = await fundedKeypair();
            await expectFailure(
                () => attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-verdict-twice", owner }),
                "NotActive"
            );
        });
    });

    // ========================
    // distribute_funds
    // ========================

    describe("distribute_funds", () => {
        const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

        it("pays each record's payout an equal share of its parcel's share; an empty payout pays the proposer", async () => {
            const amount = 0.6 * LAMPORTS;
            const { proposalPDA } = await mintProposal(["HR-dist-co", "HR-dist-solo"], false, amount);
            const [alice, bob, carol] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
            const alicePayout = Keypair.generate().publicKey;
            const carolPayout = Keypair.generate().publicKey;

            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-dist-co", owner: alice, ownerCount: 2, payout: alicePayout });
            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-dist-co", owner: bob, ownerCount: 2 });
            await attestAndAccept(program, notary, { proposal: proposalPDA, parcelId: "HR-dist-solo", owner: carol, payout: carolPayout });
            expect(await status(proposalPDA)).to.deep.equal({ executed: {} });

            const proposer = provider.wallet.publicKey;
            const meta = (pubkey: PublicKey, isWritable = false) => ({ pubkey, isSigner: false, isWritable });
            const remaining = [
                meta(findTally(program.programId, proposalPDA, "HR-dist-co")),
                meta(findRecord(program.programId, proposalPDA, "HR-dist-co", alice.publicKey)), meta(alicePayout, true),
                meta(findRecord(program.programId, proposalPDA, "HR-dist-co", bob.publicKey)), meta(proposer, true),
                meta(findTally(program.programId, proposalPDA, "HR-dist-solo")),
                meta(findRecord(program.programId, proposalPDA, "HR-dist-solo", carol.publicKey)), meta(carolPayout, true),
            ];

            // Leaving out bob's record would let alice's payout take the whole parcel share.
            await expectFailure(
                () => program.methods.distributeFunds().accountsStrict({ proposal: proposalPDA })
                    .remainingAccounts([...remaining.slice(0, 3), ...remaining.slice(5)]).rpc(),
                "InvalidDistributionAccounts"
            );
            // A recipient other than the record's payout is refused.
            const redirected = [...remaining];
            redirected[2] = meta(proposer, true);
            await expectFailure(
                () => program.methods.distributeFunds().accountsStrict({ proposal: proposalPDA }).remainingAccounts(redirected).rpc(),
                "InvalidDistributionAccounts"
            );

            const proposerBefore = await provider.connection.getBalance(proposer);
            await program.methods.distributeFunds().accountsStrict({ proposal: proposalPDA }).remainingAccounts(remaining).rpc();

            expect(await provider.connection.getBalance(alicePayout)).to.equal(0.15 * LAMPORTS);
            expect(await provider.connection.getBalance(carolPayout)).to.equal(0.3 * LAMPORTS);
            // bob's quarter goes to the proposer, minus the transaction fee the proposer paid.
            const proposerDelta = (await provider.connection.getBalance(proposer)) - proposerBefore;
            expect(proposerDelta).to.be.within(0.15 * LAMPORTS - 20_000, 0.15 * LAMPORTS);
            const account = await program.account.proposal.fetch(proposalPDA);
            expect((account.solBalance as any).toNumber()).to.equal(0);
        });

        it("returns the balance to the proposer when a verdict executed a proposal with no records", async () => {
            const { proposalPDA } = await mintProposal(["HR-dist-permit"], false, 0.2 * LAMPORTS, { verdictMayExecute: true });
            const verdict = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "executed" });
            await settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential });

            const proposer = provider.wallet.publicKey;
            await expectFailure(
                () => program.methods.distributeFunds().accountsStrict({ proposal: proposalPDA })
                    .remainingAccounts([{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }]).rpc(),
                "InvalidDistributionAccounts"
            );
            const before = await provider.connection.getBalance(proposer);
            await program.methods.distributeFunds().accountsStrict({ proposal: proposalPDA })
                .remainingAccounts([{ pubkey: proposer, isSigner: false, isWritable: true }]).rpc();
            const delta = (await provider.connection.getBalance(proposer)) - before;
            expect(delta).to.be.within(0.2 * LAMPORTS - 20_000, 0.2 * LAMPORTS);
            expect(((await program.account.proposal.fetch(proposalPDA)).solBalance as any).toNumber()).to.equal(0);
        });

        it("refuses to distribute before execution", async () => {
            const { proposalPDA } = await mintProposal(["HR-dist-active"], false, 0.1 * LAMPORTS);
            await expectFailure(
                () => program.methods.distributeFunds().accountsStrict({ proposal: proposalPDA }).rpc(),
                "NotExecuted"
            );
        });
    });

    // ========================
    // reclaim_expired_funds
    // ========================

    describe("reclaim_expired_funds", () => {
        const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;
        const reclaim = (proposal: PublicKey, owner?: Keypair) => {
            const builder = program.methods.reclaimExpiredFunds()
                .accountsStrict({ proposal, owner: owner?.publicKey ?? provider.wallet.publicKey });
            return owner ? builder.signers([owner]).rpc() : builder.rpc();
        };

        it("rejects reclaiming from an Active proposal", async () => {
            const { proposalPDA } = await mintProposal(["HR-reclaim-active"], false, 0.1 * LAMPORTS);
            await expectFailure(() => reclaim(proposalPDA), "NotExpired");
        });

        it("pays the whole balance of an Expired proposal back to its owner, once, and only to the owner", async () => {
            const { proposalPDA } = await mintProposal(["HR-reclaim-expired"], false, 0.3 * LAMPORTS);
            const verdict = await attestVerdict(provider, notary, { proposalAccount: proposalPDA, verdict: "expired" });
            await settleWithVerdict(program, { proposal: proposalPDA, verdict, credential: notary.credential });

            const stranger = await fundedKeypair();
            await expectFailure(() => reclaim(proposalPDA, stranger), "ConstraintHasOne");

            const owner = provider.wallet.publicKey;
            const before = await provider.connection.getBalance(owner);
            await reclaim(proposalPDA);
            const delta = (await provider.connection.getBalance(owner)) - before;
            expect(delta).to.be.within(0.3 * LAMPORTS - 20_000, 0.3 * LAMPORTS);
            const account = await program.account.proposal.fetch(proposalPDA);
            expect((account.solBalance as any).toNumber()).to.equal(0);
            expect(account.status).to.deep.equal({ expired: {} });
            await expectFailure(() => reclaim(proposalPDA), "ZeroAmount");
        });
    });

    // ========================
    // Cancel and contribute
    // ========================

    it("owner can cancel an active proposal and refund SOL", async () => {
        const amount = 0.25 * anchor.web3.LAMPORTS_PER_SOL;
        const { proposalPDA } = await mintProposal(["HR-sol-cancel"], true, amount);

        await program.methods
            .cancelAndRefund()
            .accounts({
                proposal: proposalPDA,
                owner: provider.wallet.publicKey,
            } as any)
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.solBalance as any).toNumber()).to.equal(0);
        expect(account.acceptancePossible).to.be.false;
        expect(account.status).to.deep.equal({ cancelled: {} });
    });

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

        await expectFailure(
            () => program.methods
                .contributeFunds(new anchor.BN(0))
                .accounts({
                    proposal: proposalPDA,
                    contributor: provider.wallet.publicKey,
                } as any)
                .rpc(),
            "ZeroAmount"
        );
    });
});
