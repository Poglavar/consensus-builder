// Localnet suite for the agreement program (programs/agreement/README.md): create with its argument
// checks, the README's account offsets and the sponsor-in-seeds address; fund; attest with the lens's
// AgreementDecision-v1 SAS attestation and every attestation it must refuse (WrongSponsor,
// InvalidDecision, WrongLens, WrongAgreement, credential, schema, expiry, payload); execute; cancel;
// expire; and the escrow moved exactly once by each terminal step.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";
import {
    AGREEMENT_ACCOUNT_SIZE,
    CreatedAgreement,
    OFFSET,
    STATUS,
    attestSatisfied,
    cancelAgreement,
    createAgreement,
    executeAgreement,
    expireAgreement,
    findAgreementPda,
    fundAgreement,
    fundKeypairs,
    recordDecision,
    testCid,
    waitForChainTime,
} from "./agreement-helpers.ts";
import {
    DECISION_SCHEMA,
    LensMember,
    VERDICT_SCHEMA,
    attestDecision,
    chainNow,
    createLensMember,
    schemaPda,
    waitForProgramsVisible,
} from "./sas-mock.ts";

const SOL = anchor.web3.LAMPORTS_PER_SOL;
const ZERO_KEY = PublicKey.default.toBase58();

describe("agreement", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.Agreement as Program;
    const connection = provider.connection;

    // sponsor: publishes and mints the agreements below (their authority); stranger: any other wallet.
    const sponsor = Keypair.generate();
    const stranger = Keypair.generate();
    // lens: the member every agreement below names; otherLens: a well-formed issuer none names.
    let lens: LensMember;
    let otherLens: LensMember;
    let rent: number;

    // Two agreements whose deadline passes while the suite runs: `lapsing` is funded and never
    // decided; `satisfiedLate` is decided before the deadline and never executed.
    let deadline: number;
    let lapsing: CreatedAgreement;
    let satisfiedLate: CreatedAgreement;

    before(async () => {
        await waitForProgramsVisible(connection);
        await fundKeypairs(provider, [sponsor, stranger], 20 * SOL);
        lens = await createLensMember(provider);
        otherLens = await createLensMember(provider);
        rent = await connection.getMinimumBalanceForRentExemption(AGREEMENT_ACCOUNT_SIZE);

        deadline = (await chainNow(connection)) + 30;
        lapsing = await createAgreement(program, { sponsor, lens: lens.publicKey, deadline, fund: SOL / 2 });
        satisfiedLate = await createAgreement(program, { sponsor, lens: lens.publicKey, deadline, requiredLamports: SOL / 4, fund: SOL / 4 });
        await attestSatisfied(program, lens, { agreement: satisfiedLate.agreement, cid: satisfiedLate.cid, sponsor: sponsor.publicKey });
    });

    // ========================
    // Helpers
    // ========================

    const fetchAgreement = (agreement: PublicKey): Promise<any> => program.account.agreement.fetch(agreement);
    const balance = (key: PublicKey) => connection.getBalance(key);
    const num = (value: any) => Number(value.toString());

    async function rawAgreement(agreement: PublicKey): Promise<Buffer> {
        const info = await connection.getAccountInfo(agreement);
        expect(info, `agreement ${agreement.toBase58()} exists`).to.not.be.null;
        expect(info!.owner.toBase58()).to.equal(program.programId.toBase58());
        return info!.data;
    }

    async function eventOf(signature: string, name: string): Promise<any> {
        for (let attempt = 0; attempt < 75; attempt++) {
            const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            if (tx?.meta?.logMessages) {
                const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
                const lower = name[0].toLowerCase() + name.slice(1);
                const event = [...parser.parseLogs(tx.meta.logMessages)].find(e => e.name === name || e.name === lower);
                expect(event, `${name} in ${signature}`).to.exist;
                return event!.data;
            }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        throw new Error(`transaction ${signature} was never confirmed`);
    }

    /** Anchor puts the code on err.error.errorCode.code; a raw runtime failure only has logs. */
    function errorText(err: any): string {
        const logs = err?.logs ?? err?.transactionLogs ?? err?.error?.logs ?? [];
        return [err?.error?.errorCode?.code, err?.message, String(err), Array.isArray(logs) ? logs.join("\n") : ""]
            .filter(Boolean)
            .join("\n");
    }

    /** Run `fn`, require it to fail, and assert the Anchor error code (string) or the log text (RegExp). */
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

    /** create() sent directly, for the argument checks: `agreement` defaults to PDA(signer, cid). */
    function sendCreate(a: { cid: string; signer?: Keypair; agreement?: PublicKey; lens?: PublicKey; deadline?: number; payout?: PublicKey }) {
        const signer = a.signer ?? sponsor;
        return program.methods
            .create(a.cid, a.lens ?? lens.publicKey, new anchor.BN(a.deadline ?? 0), false, new anchor.BN(0), a.payout ?? signer.publicKey)
            .accountsStrict({
                agreement: a.agreement ?? findAgreementPda(program.programId, signer.publicKey, a.cid),
                authority: signer.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([signer])
            .rpc();
    }

    // ========================
    // create
    // ========================

    describe("create", () => {
        let created: CreatedAgreement;
        let createdDeadline: number;
        const payout = Keypair.generate().publicKey;

        it("writes the agreement at PDA(\"agreement\", sponsor, sha256(cid)) with the README's fixed offsets", async () => {
            const before = await balance(sponsor.publicKey);
            createdDeadline = (await chainNow(connection)) + 3600;
            created = await createAgreement(program, {
                sponsor, lens: lens.publicKey, deadline: createdDeadline, openGround: true, requiredLamports: SOL / 2, payout,
            });

            // The address, derived here independently of the helper.
            const [expected, bump] = PublicKey.findProgramAddressSync(
                [Buffer.from("agreement"), sponsor.publicKey.toBuffer(), createHash("sha256").update(created.cid, "utf8").digest()],
                program.programId
            );
            expect(created.agreement.toBase58()).to.equal(expected.toBase58());
            expect(created.cid).to.match(/^bafkrei[a-z2-7]{52}$/);
            // The sponsor paid the rent and nothing else (the provider paid the fee).
            expect(before - (await balance(sponsor.publicKey))).to.equal(rent);

            const account = await fetchAgreement(created.agreement);
            expect(account.authority.toBase58()).to.equal(sponsor.publicKey.toBase58());
            expect(account.lens.toBase58()).to.equal(lens.publicKey.toBase58());
            expect(account.payout.toBase58()).to.equal(payout.toBase58());
            expect(num(account.deadline)).to.equal(createdDeadline);
            expect(num(account.createdAt)).to.be.greaterThan(0);
            expect(num(account.requiredLamports)).to.equal(SOL / 2);
            expect(num(account.escrowLamports)).to.equal(0);
            expect(account.status).to.deep.equal({ active: {} });
            expect(account.openGround).to.be.true;
            expect(account.decision).to.deep.equal({ pending: {} });
            expect([num(account.decisionAttestedAt), num(account.decisionObservedAt), num(account.executedAt)]).to.deep.equal([0, 0, 0]);
            expect(account.decisionAttestation.toBase58()).to.equal(ZERO_KEY);
            expect(Buffer.from(account.decisionHash).equals(Buffer.alloc(32))).to.be.true;
            expect(account.bump).to.equal(bump);
            expect(account.cid).to.equal(created.cid);

            // The byte layout the market and pledge programs and the backend reader rely on.
            const data = await rawAgreement(created.agreement);
            expect(data.length).to.equal(AGREEMENT_ACCOUNT_SIZE);
            expect(new PublicKey(data.subarray(OFFSET.authority, OFFSET.authority + 32)).toBase58()).to.equal(sponsor.publicKey.toBase58());
            expect(new PublicKey(data.subarray(OFFSET.lens, OFFSET.lens + 32)).toBase58()).to.equal(lens.publicKey.toBase58());
            expect(new PublicKey(data.subarray(OFFSET.payout, OFFSET.payout + 32)).toBase58()).to.equal(payout.toBase58());
            expect(Number(data.readBigInt64LE(OFFSET.deadline))).to.equal(createdDeadline);
            expect(Number(data.readBigUInt64LE(OFFSET.requiredLamports))).to.equal(SOL / 2);
            expect(data[OFFSET.status]).to.equal(STATUS.active);
            expect(data[OFFSET.openGround]).to.equal(1);
            expect(data[OFFSET.decision]).to.equal(0);
            expect(data[OFFSET.bump]).to.equal(bump);
            expect(data.readUInt32LE(OFFSET.cid)).to.equal(created.cid.length);
            expect(data.subarray(OFFSET.cid + 4, OFFSET.cid + 4 + created.cid.length).toString("utf8")).to.equal(created.cid);

            const event = await eventOf(created.signature, "AgreementCreated");
            expect(event.agreement.toBase58()).to.equal(created.agreement.toBase58());
            expect(event.cid).to.equal(created.cid);
            expect(event.authority.toBase58()).to.equal(sponsor.publicKey.toBase58());
            expect(event.lens.toBase58()).to.equal(lens.publicKey.toBase58());
            expect(event.payout.toBase58()).to.equal(payout.toBase58());
            expect([num(event.deadline), num(event.requiredLamports), num(event.createdAt)])
                .to.deep.equal([createdDeadline, SOL / 2, num(account.createdAt)]);
            expect(event.openGround).to.be.true;
        });

        it("refuses a second create of the same sponsor and CID", async () => {
            await expectFailure(() => sendCreate({ cid: created.cid }), /already in use/);
            expect(num((await fetchAgreement(created.agreement)).deadline)).to.equal(createdDeadline);
        });

        it("lets only the sponsor create its address: a stranger signing for PDA(sponsor, cid) fails the seeds", async () => {
            const cid = testCid("squat");
            const target = findAgreementPda(program.programId, sponsor.publicKey, cid);
            await expectFailure(() => sendCreate({ cid, signer: stranger, agreement: target }), "ConstraintSeeds");
            expect(await connection.getAccountInfo(target)).to.be.null;
        });

        it("puts another wallet's account for the same CID at another address", async () => {
            const theirs = await createAgreement(program, { sponsor: stranger, cid: created.cid, lens: lens.publicKey });
            expect(theirs.agreement.toBase58()).to.not.equal(created.agreement.toBase58());
            expect(theirs.agreement.toBase58()).to.equal(findAgreementPda(program.programId, stranger.publicKey, created.cid).toBase58());
            const [mine, other] = await Promise.all([fetchAgreement(created.agreement), fetchAgreement(theirs.agreement)]);
            expect([mine.cid, other.cid]).to.deep.equal([created.cid, created.cid]);
            expect(mine.authority.toBase58()).to.equal(sponsor.publicKey.toBase58());
            expect(other.authority.toBase58()).to.equal(stranger.publicKey.toBase58());
        });

        it("refuses a CID that is empty, longer than 64 bytes or not ASCII letters and digits", async () => {
            const cases: [string, string][] = [
                ["", "InvalidCid"],
                ["a".repeat(65), "CidTooLong"],
                ["bafk-rei", "InvalidCid"],
                [" bafkrei", "InvalidCid"],
                ["bafkréi", "InvalidCid"],
            ];
            for (const [cid, code] of cases) {
                await expectFailure(() => sendCreate({ cid }), code);
                expect(await connection.getAccountInfo(findAgreementPda(program.programId, sponsor.publicKey, cid)), JSON.stringify(cid)).to.be.null;
            }
            // 64 alphanumerics is the longest CID an agreement stores.
            const longest = "b".repeat(64);
            await sendCreate({ cid: longest });
            expect((await fetchAgreement(findAgreementPda(program.programId, sponsor.publicKey, longest))).cid).to.equal(longest);
        });

        it("refuses the default lens key, a default or self payout, and a deadline that is not in the future", async () => {
            const cid = testCid("arguments");
            const self = findAgreementPda(program.programId, sponsor.publicKey, cid);
            await expectFailure(() => sendCreate({ cid, lens: PublicKey.default }), "NoLens");
            await expectFailure(() => sendCreate({ cid, payout: PublicKey.default }), "InvalidPayout");
            await expectFailure(() => sendCreate({ cid, payout: self }), "InvalidPayout");
            const past = (await chainNow(connection)) - 5;
            await expectFailure(() => sendCreate({ cid, deadline: past }), "DeadlinePassed");
            expect(await connection.getAccountInfo(self)).to.be.null;
            // Deadline 0 means none.
            await sendCreate({ cid });
            expect(num((await fetchAgreement(self)).deadline)).to.equal(0);
        });
    });

    // ========================
    // fund
    // ========================

    describe("fund", () => {
        let created: CreatedAgreement;

        before(async () => {
            created = await createAgreement(program, { sponsor, lens: lens.publicKey, requiredLamports: SOL });
        });

        it("moves the sponsor's lamports into the account and counts them as escrow", async () => {
            const sponsorBefore = await balance(sponsor.publicKey);
            const accountBefore = await balance(created.agreement);
            await fundAgreement(program, created.agreement, sponsor, 0.3 * SOL);
            const signature = await fundAgreement(program, created.agreement, sponsor, 0.2 * SOL);

            expect(sponsorBefore - (await balance(sponsor.publicKey))).to.equal(0.5 * SOL);
            expect((await balance(created.agreement)) - accountBefore).to.equal(0.5 * SOL);
            expect(num((await fetchAgreement(created.agreement)).escrowLamports)).to.equal(0.5 * SOL);
            const event = await eventOf(signature, "AgreementFunded");
            expect([num(event.lamports), num(event.escrowLamports)]).to.deep.equal([0.2 * SOL, 0.5 * SOL]);
            expect(event.cid).to.equal(created.cid);
        });

        it("refuses a zero amount", async () => {
            await expectFailure(() => fundAgreement(program, created.agreement, sponsor, 0), "ZeroAmount");
        });

        it("refuses any funder but the sponsor", async () => {
            const before = await balance(stranger.publicKey);
            await expectFailure(() => fundAgreement(program, created.agreement, stranger, 0.1 * SOL), "Unauthorized");
            expect(await balance(stranger.publicKey)).to.equal(before);
            expect(num((await fetchAgreement(created.agreement)).escrowLamports)).to.equal(0.5 * SOL);
        });
    });

    // ========================
    // attest
    // ========================

    describe("attest", () => {
        let created: CreatedAgreement;
        let now: number;

        before(async () => {
            created = await createAgreement(program, { sponsor, lens: lens.publicKey, deadline: (await chainNow(connection)) + 3600 });
            now = await chainNow(connection);
        });

        /** Issue a decision on `created` (overridable), record it, and expect `code`. */
        async function refused(code: string, p: Partial<Parameters<typeof attestDecision>[2]> = {}, issuer: LensMember = lens, credential?: PublicKey) {
            const { address } = await attestDecision(provider, issuer, { agreementCid: created.cid, sponsor: sponsor.publicKey, ...p });
            await expectFailure(() => recordDecision(program, created.agreement, address, credential ?? p.credential ?? issuer.credential), code);
        }

        it("refuses what the lens never issues: another sponsor, another agreement, any decision but satisfied", async () => {
            await refused("WrongSponsor", { sponsor: stranger.publicKey });
            await refused("WrongAgreement", { agreementCid: testCid("elsewhere") });
            await refused("InvalidDecision", { decision: "refused" });
            await refused("InvalidDecision", { decision: "pending" });
            await refused("AttestationFromFuture", { sourceObservedAt: now + 3600 });
        });

        it("refuses another issuer, a credential that is not the attestation's or not its signer's, and another schema", async () => {
            // A well-formed decision by a lens member the agreement does not name.
            await refused("WrongLens", {}, otherLens);
            // Signed by the lens key under a credential whose authority is another key.
            await refused("InvalidAttestation", { credential: otherLens.credential });
            // Issued under the lens's credential, presented with another one.
            await refused("InvalidAttestation", {}, lens, otherLens.credential);
            await refused("WrongSchema", { schema: schemaPda(lens.credential, VERDICT_SCHEMA) });
            await refused("WrongSchema", { schema: schemaPda(lens.credential, DECISION_SCHEMA, 2) });
            await refused("AttestationExpired", { expiry: now - 1 });
            // An account the attestation service does not own.
            await expectFailure(() => recordDecision(program, created.agreement, stranger.publicKey, lens.credential), "InvalidAttestation");
        });

        it("refuses a malformed payload: a sponsor that is not a base58 key, trailing bytes", async () => {
            await refused("InvalidAttestationPayload", { sponsor: "not-a-key" });
            await refused("InvalidAttestationPayload", { trailing: Buffer.from([0]) });
        });

        it("still holds no decision after every refusal", async () => {
            const account = await fetchAgreement(created.agreement);
            expect(account.decision).to.deep.equal({ pending: {} });
            expect(num(account.decisionAttestedAt)).to.equal(0);
            expect(account.decisionAttestation.toBase58()).to.equal(ZERO_KEY);
        });

        it("records the lens's satisfied decision with the attestation's key, hash and source time", async () => {
            const sourceObservedAt = (await chainNow(connection)) - 120;
            const evidenceRef = `sha256:${"cd".repeat(32)}`;
            const { address, bytes } = await attestDecision(provider, lens, {
                agreementCid: created.cid, sponsor: sponsor.publicKey, sourceObservedAt, evidenceRef,
            });
            const signature = await recordDecision(program, created.agreement, address, lens.credential);

            const account = await fetchAgreement(created.agreement);
            expect(account.decision).to.deep.equal({ satisfied: {} });
            expect(account.status).to.deep.equal({ active: {} });
            expect(account.decisionAttestation.toBase58()).to.equal(address.toBase58());
            const hash = createHash("sha256").update(bytes).digest();
            expect(Buffer.from(account.decisionHash).equals(hash)).to.be.true;
            expect(num(account.decisionObservedAt)).to.equal(sourceObservedAt);
            expect(num(account.decisionAttestedAt)).to.be.at.least(sourceObservedAt);
            expect((await rawAgreement(created.agreement))[OFFSET.decision]).to.equal(1);

            const event = await eventOf(signature, "AgreementAttested");
            expect(event.attestation.toBase58()).to.equal(address.toBase58());
            expect(event.lens.toBase58()).to.equal(lens.publicKey.toBase58());
            expect(Buffer.from(event.attestationHash).equals(hash)).to.be.true;
            expect(event.evidenceRef).to.equal(evidenceRef);
            expect(num(event.sourceObservedAt)).to.equal(sourceObservedAt);
        });

        it("keeps the first decision: another valid attestation is AlreadyAttested", async () => {
            const first = (await fetchAgreement(created.agreement)).decisionAttestation.toBase58();
            await refused("AlreadyAttested");
            expect((await fetchAgreement(created.agreement)).decisionAttestation.toBase58()).to.equal(first);
        });

        it("settles only PDA(sponsor, cid): another wallet's account for the same CID can never record it", async () => {
            const cid = testCid("contested");
            const mine = await createAgreement(program, { sponsor, cid, lens: lens.publicKey });
            const theirs = await createAgreement(program, { sponsor: stranger, cid, lens: lens.publicKey });
            // The lens's decision names the sponsor of the published agreement, not that account's authority...
            const decision = await attestDecision(provider, lens, { agreementCid: cid, sponsor: sponsor.publicKey });
            await expectFailure(() => recordDecision(program, theirs.agreement, decision.address, lens.credential), "WrongSponsor");
            // ...and a decision naming the stranger never fits the sponsor's account.
            const forged = await attestDecision(provider, lens, { agreementCid: cid, sponsor: stranger.publicKey });
            await expectFailure(() => recordDecision(program, mine.agreement, forged.address, lens.credential), "WrongSponsor");

            await recordDecision(program, mine.agreement, decision.address, lens.credential);
            expect((await fetchAgreement(mine.agreement)).decision).to.deep.equal({ satisfied: {} });
            expect((await fetchAgreement(theirs.agreement)).decision).to.deep.equal({ pending: {} });
            await expectFailure(() => executeAgreement(program, theirs.agreement, stranger.publicKey), "NotAttested");
        });
    });

    // ========================
    // execute
    // ========================

    describe("execute", () => {
        let created: CreatedAgreement;
        const payout = Keypair.generate();

        before(async () => {
            created = await createAgreement(program, {
                sponsor, lens: lens.publicKey, requiredLamports: SOL, payout: payout.publicKey, fund: 0.4 * SOL,
            });
        });

        it("refuses before a decision is recorded", async () => {
            await expectFailure(() => executeAgreement(program, created.agreement, payout.publicKey), "NotAttested");
        });

        it("refuses while the escrow is short of what execution requires, and another payout account", async () => {
            await attestSatisfied(program, lens, { agreement: created.agreement, cid: created.cid, sponsor: sponsor.publicKey });
            await expectFailure(() => executeAgreement(program, created.agreement, payout.publicKey), "Underfunded");
            // Funding stays open after the decision, up to the deadline.
            await fundAgreement(program, created.agreement, sponsor, 0.6 * SOL);
            await expectFailure(() => executeAgreement(program, created.agreement, stranger.publicKey), "WrongPayout");
            expect((await fetchAgreement(created.agreement)).status).to.deep.equal({ active: {} });
            expect(await balance(payout.publicKey)).to.equal(0);
        });

        it("pays the whole escrow to the payout and becomes Executed", async () => {
            const signature = await executeAgreement(program, created.agreement, payout.publicKey);

            expect(await balance(payout.publicKey)).to.equal(SOL);
            expect(await balance(created.agreement)).to.equal(rent);
            const account = await fetchAgreement(created.agreement);
            expect(account.status).to.deep.equal({ executed: {} });
            expect(num(account.escrowLamports)).to.equal(0);
            const executedAt = num(account.executedAt);
            expect(executedAt).to.be.greaterThan(0);
            const data = await rawAgreement(created.agreement);
            expect(data[OFFSET.status]).to.equal(STATUS.executed);
            expect(Number(data.readBigInt64LE(OFFSET.executedAt))).to.equal(executedAt);

            const event = await eventOf(signature, "AgreementExecuted");
            expect(event.agreement.toBase58()).to.equal(created.agreement.toBase58());
            expect(event.cid).to.equal(created.cid);
            expect(event.payout.toBase58()).to.equal(payout.publicKey.toBase58());
            expect(num(event.lamports)).to.equal(SOL);
            expect(event.lens.toBase58()).to.equal(lens.publicKey.toBase58());
            expect(event.decisionAttestation.toBase58()).to.equal(account.decisionAttestation.toBase58());
            expect(num(event.executedAt)).to.equal(executedAt);
        });

        it("is final: execute, fund, cancel and expire refuse once Executed", async () => {
            await expectFailure(() => executeAgreement(program, created.agreement, payout.publicKey), "NotActive");
            await expectFailure(() => fundAgreement(program, created.agreement, sponsor, 0.1 * SOL), "NotActive");
            await expectFailure(() => cancelAgreement(program, created.agreement, sponsor), "NotActive");
            await expectFailure(() => expireAgreement(program, created.agreement, sponsor.publicKey), "NotActive");
            expect(await balance(payout.publicKey)).to.equal(SOL);
        });

        it("executes an agreement that requires no escrow, moving nothing", async () => {
            const free = await createAgreement(program, { sponsor, lens: lens.publicKey });
            await attestSatisfied(program, lens, { agreement: free.agreement, cid: free.cid, sponsor: sponsor.publicKey });
            const before = await balance(sponsor.publicKey);
            await executeAgreement(program, free.agreement, sponsor.publicKey);
            expect(await balance(sponsor.publicKey)).to.equal(before);
            expect((await fetchAgreement(free.agreement)).status).to.deep.equal({ executed: {} });
        });
    });

    // ========================
    // cancel
    // ========================

    describe("cancel", () => {
        it("returns the whole escrow to the sponsor, and only the sponsor may cancel", async () => {
            const created = await createAgreement(program, { sponsor, lens: lens.publicKey, fund: 0.5 * SOL });
            await expectFailure(() => cancelAgreement(program, created.agreement, stranger), "Unauthorized");

            const before = await balance(sponsor.publicKey);
            const signature = await cancelAgreement(program, created.agreement, sponsor);
            expect((await balance(sponsor.publicKey)) - before).to.equal(0.5 * SOL);
            expect(await balance(created.agreement)).to.equal(rent);
            const account = await fetchAgreement(created.agreement);
            expect(account.status).to.deep.equal({ cancelled: {} });
            expect(num(account.escrowLamports)).to.equal(0);
            expect((await rawAgreement(created.agreement))[OFFSET.status]).to.equal(STATUS.cancelled);
            expect(num((await eventOf(signature, "AgreementCancelled")).refundedLamports)).to.equal(0.5 * SOL);

            // Nothing moves an agreement out of Cancelled.
            await expectFailure(() => fundAgreement(program, created.agreement, sponsor, 0.1 * SOL), "NotActive");
            await expectFailure(() => cancelAgreement(program, created.agreement, sponsor), "NotActive");
            const { address } = await attestDecision(provider, lens, { agreementCid: created.cid, sponsor: sponsor.publicKey });
            await expectFailure(() => recordDecision(program, created.agreement, address, lens.credential), "NotActive");
        });

        it("refuses once the lens's decision is recorded: the parties rely on the escrow", async () => {
            const created = await createAgreement(program, { sponsor, lens: lens.publicKey, fund: 0.2 * SOL });
            await attestSatisfied(program, lens, { agreement: created.agreement, cid: created.cid, sponsor: sponsor.publicKey });
            await expectFailure(() => cancelAgreement(program, created.agreement, sponsor), "DecisionSatisfied");
            const account = await fetchAgreement(created.agreement);
            expect(account.status).to.deep.equal({ active: {} });
            expect(num(account.escrowLamports)).to.equal(0.2 * SOL);
        });
    });

    // ========================
    // expire and the deadline
    // ========================

    describe("expire and the deadline", () => {
        it("refuses to expire before the deadline, and an agreement without one", async () => {
            const dated = await createAgreement(program, { sponsor, lens: lens.publicKey, deadline: (await chainNow(connection)) + 3600 });
            await expectFailure(() => expireAgreement(program, dated.agreement, sponsor.publicKey), "DeadlineNotPassed");
            const undated = await createAgreement(program, { sponsor, lens: lens.publicKey });
            await expectFailure(() => expireAgreement(program, undated.agreement, sponsor.publicKey), "DeadlineNotPassed");
        });

        it("closes funding and decisions once the deadline has passed", async () => {
            await waitForChainTime(connection, deadline + 1);
            await expectFailure(() => fundAgreement(program, lapsing.agreement, sponsor, 0.1 * SOL), "DeadlinePassed");
            const { address } = await attestDecision(provider, lens, { agreementCid: lapsing.cid, sponsor: sponsor.publicKey });
            await expectFailure(() => recordDecision(program, lapsing.agreement, address, lens.credential), "DeadlinePassed");
        });

        it("refuses to execute a satisfied agreement after its deadline", async () => {
            expect((await fetchAgreement(satisfiedLate.agreement)).decision).to.deep.equal({ satisfied: {} });
            await expectFailure(() => executeAgreement(program, satisfiedLate.agreement, sponsor.publicKey), "DeadlinePassed");
        });

        it("lets anyone expire it, refunding the escrow to the sponsor, who need not sign", async () => {
            await expectFailure(() => expireAgreement(program, lapsing.agreement, stranger.publicKey), "WrongAuthority");

            const before = await balance(sponsor.publicKey);
            const signature = await expireAgreement(program, lapsing.agreement, sponsor.publicKey);
            expect((await balance(sponsor.publicKey)) - before).to.equal(SOL / 2);
            expect(await balance(lapsing.agreement)).to.equal(rent);
            const account = await fetchAgreement(lapsing.agreement);
            expect(account.status).to.deep.equal({ expired: {} });
            expect(num(account.escrowLamports)).to.equal(0);
            expect((await rawAgreement(lapsing.agreement))[OFFSET.status]).to.equal(STATUS.expired);
            expect(num((await eventOf(signature, "AgreementExpired")).refundedLamports)).to.equal(SOL / 2);

            await expectFailure(() => expireAgreement(program, lapsing.agreement, sponsor.publicKey), "NotActive");
        });

        it("expires a satisfied agreement nobody executed in time", async () => {
            const before = await balance(sponsor.publicKey);
            await expireAgreement(program, satisfiedLate.agreement, sponsor.publicKey);
            expect((await balance(sponsor.publicKey)) - before).to.equal(SOL / 4);
            const account = await fetchAgreement(satisfiedLate.agreement);
            expect(account.status).to.deep.equal({ expired: {} });
            expect(account.decision).to.deep.equal({ satisfied: {} });
        });
    });
});
