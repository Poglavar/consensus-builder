// Shared terminal lifecycle actions against the proposal_nft/parcel_nft v2 IDLs (lens-model.md):
// instruction bytes are compared with the browser's own v2 codec (frontend/js/solana/acceptance-client.js),
// PDAs with the program's seeds, and the read-before-write paths run against a fake chain holding
// real account bytes (Anchor accounts and SAS attestations laid out exactly as on devnet).
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    acceptWithAttestations, buildAcceptWithAttestationsIx, buildCancelProposalIx, buildMintParcelIx,
    buildSettleWithVerdictIx, cancelProposal, decodeProposalState, deriveAcceptanceRecordPda, deriveConsentTallyPda,
    deriveMemberCredential, deriveParcelAnchorPda, ensureParcelAnchor, expireWithVerdict, PARCEL_PROGRAM_ID,
    getVerdictRecordPda, PROPOSAL_PROGRAM_ID, readAcceptanceRecord, readConsentTally, readVerdictRecord, settleWithVerdict
} from '../agents/lifecycle-actions.js';
import { instructionDiscriminator } from '../agents/minter.js';
import {
    buildSasAttestationAccount, deriveCredentialPda, deriveLensSchemaPdas, encodeLensPayload, SAS_PROGRAM_ID
} from '../oracle/lens-schemas.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const { Keypair, PublicKey } = web3;
let browser;

beforeAll(() => {
    browser = require('../../frontend/js/solana/acceptance-client.js');
    browser.configure({ web3 });
});

function string(value) {
    const text = Buffer.from(value);
    const length = Buffer.alloc(4); length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
}

function stringVector(values) {
    const count = Buffer.alloc(4); count.writeUInt32LE(values.length);
    return Buffer.concat([count, ...values.map(string)]);
}

function keyVector(keys) {
    const count = Buffer.alloc(4); count.writeUInt32LE(keys.length);
    return Buffer.concat([count, ...keys.map(key => new PublicKey(key).toBuffer())]);
}

// Proposal v3 bytes: v1 prefix, lens, bump, verdict_may_execute, site_hash, open_ground,
// open_ground_cleared, layout_version (3 = a v3 mint, 0 = v1/v2), zero padding like the 4096-byte account.
function proposalAccount(status, {
    owner = Keypair.generate().publicKey, parcelIds = [], accepted = [], lens = [], acceptancePossible = true, verdictMayExecute = false,
    siteHash = Buffer.alloc(32), openGround = false, openGroundCleared = false, layoutVersion = 3
} = {}) {
    return Buffer.concat([
        Buffer.from([26, 94, 189, 187, 116, 136, 53, 33]), Buffer.alloc(8), owner.toBuffer(), stringVector(parcelIds),
        Buffer.from([1]), string(''), Buffer.from([acceptancePossible ? 1 : 0, status]), Buffer.alloc(24),
        stringVector(accepted), keyVector(lens), Buffer.from([254, verdictMayExecute ? 1 : 0]),
        Buffer.from(siteHash), Buffer.from([openGround ? 1 : 0, openGroundCleared ? 1 : 0, layoutVersion]), Buffer.alloc(16)
    ]);
}

function parcelAccount(parcelId, owner = PublicKey.default) {
    return Buffer.concat([Buffer.alloc(8), string(parcelId), string(''), owner.toBuffer(), Buffer.from([255])]);
}

function tallyAccount({ proposal, parcelId, member, required, accepted }) {
    return Buffer.concat([
        Buffer.from([200, 21, 66, 56, 62, 148, 43, 226]), new PublicKey(proposal).toBuffer(), string(parcelId),
        new PublicKey(member).toBuffer(), Buffer.from([required, accepted, 253])
    ]);
}

function recordAccount({ proposal, parcelId, owner, member, attestation, payout = PublicKey.default, acceptedAt = 1790000000 }) {
    const time = Buffer.alloc(8); time.writeBigInt64LE(BigInt(acceptedAt));
    return Buffer.concat([
        Buffer.from([8, 191, 82, 210, 167, 58, 12, 34]), new PublicKey(proposal).toBuffer(), string(parcelId),
        new PublicKey(owner).toBuffer(), new PublicKey(member).toBuffer(), new PublicKey(attestation).toBuffer(),
        Buffer.alloc(32, 7), new PublicKey(payout).toBuffer(), time, Buffer.from([252])
    ]);
}

function verdictRecordAccount({ proposal, member, attestation, verdictCode = 3, settledAt = 1790000000 }) {
    const time = Buffer.alloc(8); time.writeBigInt64LE(BigInt(settledAt));
    return Buffer.concat([
        Buffer.from([5, 210, 137, 12, 43, 13, 62, 182]), new PublicKey(proposal).toBuffer(), new PublicKey(member).toBuffer(),
        new PublicKey(attestation).toBuffer(), Buffer.alloc(32, 9), Buffer.from([verdictCode]), time, Buffer.from([251])
    ]);
}

function attestationAccount(kind, { member, fields, credentialName = 'LensMember', expiry = 4102444800 }) {
    const { credential, schemas } = deriveLensSchemaPdas({ authority: member, credentialName });
    return buildSasAttestationAccount({
        nonce: Keypair.generate().publicKey, credential, schema: schemas[kind],
        payload: encodeLensPayload(kind, fields), authority: member, expiry
    });
}

// A chain of accounts by address; a sendAndConfirm stub that records the transaction.
function fakeChain() {
    const accounts = new Map();
    const sas = new PublicKey(SAS_PROGRAM_ID);
    return {
        accounts,
        put(address, data, owner = PublicKey.default) { accounts.set(new PublicKey(address).toBase58(), { data, owner }); },
        putSas(address, data) { accounts.set(new PublicKey(address).toBase58(), { data, owner: sas }); },
        connection: { getAccountInfo: vi.fn(async address => accounts.get(new PublicKey(address).toBase58()) ?? null) }
    };
}

const flags = ix => ix.keys.map(item => [item.pubkey.toBase58(), item.isSigner, item.isWritable]);

describe('owner-only cancellation', () => {
    it('builds the same owner-only cancellation instruction as the wallet flow', () => {
        const proposal = Keypair.generate().publicKey;
        const owner = Keypair.generate().publicKey;
        const ix = buildCancelProposalIx({ proposalAccount: proposal, owner });
        expect(ix.programId.toBase58()).toBe(PROPOSAL_PROGRAM_ID);
        expect(flags(ix)).toEqual([[proposal.toBase58(), false, true], [owner.toBase58(), true, true]]);
        expect([...ix.data]).toEqual([...instructionDiscriminator('cancel_and_refund')]);
    });

    it('does not submit cancellation twice after the chain is already terminal', async () => {
        const sendAndConfirm = vi.fn();
        const result = await cancelProposal({
            connection: { getAccountInfo: vi.fn(async () => ({ data: proposalAccount(2) })) },
            ownerKeypair: Keypair.generate(), proposalAccount: Keypair.generate().publicKey, sendAndConfirm
        });
        expect(result).toEqual({ replayed: true, signature: null, status: 'cancelled' });
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('submits one signed cancellation for an active proposal', async () => {
        const ownerKeypair = Keypair.generate();
        const sendAndConfirm = vi.fn(async () => 'cancel-tx');
        const result = await cancelProposal({
            connection: { getAccountInfo: vi.fn(async () => ({ data: proposalAccount(0, { owner: ownerKeypair.publicKey }) })) },
            ownerKeypair, proposalAccount: Keypair.generate().publicKey, sendAndConfirm
        });
        expect(result).toEqual({ replayed: false, signature: 'cancel-tx', status: 'cancelled' });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });
});

describe('proposal v3 account decoding', () => {
    it('reads the lens, bump, verdict_may_execute and the v3 site fields after the v1 prefix', () => {
        const lens = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
        const state = decodeProposalState(proposalAccount(3, { parcelIds: ['A', 'B'], accepted: ['A'], lens, verdictMayExecute: true }));
        expect(state).toMatchObject({
            status: 3, parcelIds: ['A', 'B'], acceptedParcels: ['A'], lens, bump: 254, verdictMayExecute: true,
            siteHash: null, openGround: false, openGroundCleared: false, layoutVersion: 3
        });
        expect(decodeProposalState(proposalAccount(0, { lens })).verdictMayExecute).toBe(false);
        expect(decodeProposalState(proposalAccount(0, { lens, layoutVersion: 0 })).layoutVersion).toBe(0);
        const site = decodeProposalState(proposalAccount(0, { lens, siteHash: Buffer.alloc(32, 7), openGround: true, openGroundCleared: true }));
        expect(site).toMatchObject({ parcelIds: [], siteHash: '07'.repeat(32), openGround: true, openGroundCleared: true });
    });

    it('agrees with the browser decoder and refuses bytes that end before the v3 site fields', () => {
        const lens = [Keypair.generate().publicKey.toBase58()];
        const bytes = proposalAccount(1, { parcelIds: ['HR-1'], accepted: ['HR-1'], lens, verdictMayExecute: true, siteHash: Buffer.alloc(32, 9), openGround: true });
        const ours = decodeProposalState(bytes);
        const theirs = browser.readProposal(bytes);
        const pick = p => ({ lens: p.lens, accepted: p.acceptedParcels, v: p.verdictMayExecute, site: p.siteHash, open: p.openGround,
            cleared: p.openGroundCleared, layout: p.layoutVersion });
        expect(pick(ours)).toEqual(pick(theirs));
        expect(ours.layoutVersion).toBe(3);
        // Ending right before layout_version reads it as 0 (absent), in both decoders.
        const noLayout = bytes.subarray(0, bytes.length - 17);
        expect(decodeProposalState(noLayout).layoutVersion).toBe(0);
        expect(browser.readProposal(noLayout).layoutVersion).toBe(0);
        const truncated = bytes.subarray(0, bytes.length - 18);
        expect(() => decodeProposalState(truncated)).toThrow(/site fields/);
    });
});

describe('accept_with_attestations', () => {
    const parcelId = 'HR-335550-1813/6';

    it('uses the IDL account order, the program PDA seeds and the browser codec bytes', () => {
        const proposal = Keypair.generate().publicKey;
        const owner = Keypair.generate().publicKey;
        const payer = Keypair.generate().publicKey;
        const ownership = Keypair.generate().publicKey;
        const member = Keypair.generate().publicKey;
        const credential = deriveMemberCredential({ member });
        expect(credential.toBase58()).toBe(deriveCredentialPda({ authority: member.toBase58(), name: 'LensMember' }));
        const payout = Keypair.generate().publicKey;
        const ix = buildAcceptWithAttestationsIx({ proposalAccount: proposal, parcelId, ownershipAttestation: ownership, ownershipCredential: credential, owner, payer, payout });
        const program = new PublicKey(PROPOSAL_PROGRAM_ID);
        const [tally] = PublicKey.findProgramAddressSync([Buffer.from('consent'), proposal.toBuffer(), Buffer.from(parcelId)], program);
        const [record] = PublicKey.findProgramAddressSync([Buffer.from('acceptance'), proposal.toBuffer(), Buffer.from(parcelId), owner.toBuffer()], program);
        const [anchor] = PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from(parcelId)], new PublicKey(PARCEL_PROGRAM_ID));
        expect(flags(ix)).toEqual([
            [proposal.toBase58(), false, true], [anchor.toBase58(), false, false], [ownership.toBase58(), false, false],
            [credential.toBase58(), false, false], [tally.toBase58(), false, true], [record.toBase58(), false, true],
            [owner.toBase58(), true, false], [payer.toBase58(), true, true], [web3.SystemProgram.programId.toBase58(), false, false]
        ]);
        expect([...ix.data.subarray(0, 8)]).toEqual([89, 240, 102, 93, 168, 200, 164, 125]);
        expect([...ix.data.subarray(-33)]).toEqual([1, ...payout.toBuffer()]);
        const theirs = browser.buildAcceptWithAttestationsIx({ proposal, parcelId, ownership, ownershipCredential: credential, owner, payer, payout });
        expect(flags(ix)).toEqual(flags(theirs.instruction));
        expect([...ix.data]).toEqual([...theirs.instruction.data]);
        const none = buildAcceptWithAttestationsIx({ proposalAccount: proposal, parcelId, ownershipAttestation: ownership, ownershipCredential: credential, owner });
        expect(none.data.at(-1)).toBe(0);
        expect(none.keys[7].pubkey.toBase58()).toBe(owner.toBase58()); // payer defaults to the owner
    });

    function acceptanceChain({ ownerCount = 1, lensHasMember = true, attestedOwner, tally } = {}) {
        const chain = fakeChain();
        const owner = Keypair.generate();
        const member = Keypair.generate().publicKey.toBase58();
        const proposal = Keypair.generate().publicKey;
        const ownership = Keypair.generate().publicKey;
        chain.put(proposal, proposalAccount(0, { parcelIds: [parcelId, 'HR-335550-1813/8'], lens: lensHasMember ? [member] : [Keypair.generate().publicKey.toBase58()] }));
        chain.putSas(ownership, attestationAccount('ownership', { member, fields: {
            parcelUid: parcelId, owner: attestedOwner || owner.publicKey.toBase58(), ownerCount, evidenceRef: 'sha256:x', sourceObservedAt: 1780000000
        } }));
        chain.put(deriveParcelAnchorPda(parcelId), parcelAccount(parcelId));
        if (tally) chain.put(deriveConsentTallyPda({ proposalAccount: proposal, parcelId }), tallyAccount({ proposal, parcelId, ...tally }));
        return { chain, owner, member, proposal, ownership };
    }

    it('signs once as owner and payer after checking lens, attestation, tally and anchor', async () => {
        const { chain, owner, member, proposal, ownership } = acceptanceChain();
        const sendAndConfirm = vi.fn(async (_connection, transaction, signers) => {
            expect(signers.map(signer => signer.publicKey.toBase58())).toEqual([owner.publicKey.toBase58()]);
            expect(transaction.instructions[0].keys[3].pubkey.toBase58()).toBe(deriveCredentialPda({ authority: member, name: 'LensMember' }));
            return 'accept-tx';
        });
        const result = await acceptWithAttestations({
            connection: chain.connection, ownerKeypair: owner, proposalAccount: proposal, parcelId,
            ownershipAttestation: ownership, member, sendAndConfirm
        });
        expect(result).toMatchObject({
            replayed: false, signature: 'accept-tx', executed: false,
            record: deriveAcceptanceRecordPda({ proposalAccount: proposal, parcelId, owner: owner.publicKey }).toBase58(),
            tally: deriveConsentTallyPda({ proposalAccount: proposal, parcelId }).toBase58()
        });
        expect(result.ownershipHash).toMatch(/^[0-9a-f]{64}$/);
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('lets a separate payer pay rent, both signing', async () => {
        const { chain, owner, member, proposal, ownership } = acceptanceChain();
        const payer = Keypair.generate();
        const sendAndConfirm = vi.fn(async (_connection, transaction, signers) => {
            expect(transaction.feePayer.toBase58()).toBe(payer.publicKey.toBase58());
            expect(signers.map(signer => signer.publicKey.toBase58())).toEqual([payer.publicKey.toBase58(), owner.publicKey.toBase58()]);
            return 'accept-tx';
        });
        await acceptWithAttestations({ connection: chain.connection, ownerKeypair: owner, payerKeypair: payer, proposalAccount: proposal, parcelId, ownershipAttestation: ownership, member, sendAndConfirm });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('replays an existing acceptance record without sending', async () => {
        const { chain, owner, member, proposal, ownership } = acceptanceChain();
        chain.put(deriveAcceptanceRecordPda({ proposalAccount: proposal, parcelId, owner: owner.publicKey }),
            recordAccount({ proposal, parcelId, owner: owner.publicKey, member, attestation: ownership }));
        const sendAndConfirm = vi.fn();
        const result = await acceptWithAttestations({ connection: chain.connection, ownerKeypair: owner, proposalAccount: proposal, parcelId, ownershipAttestation: ownership, member, sendAndConfirm });
        expect(result).toMatchObject({ replayed: true, signature: null, acceptance: { owner: owner.publicKey.toBase58(), member, payout: null, acceptedAt: 1790000000 } });
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('refuses a member outside the lens, an attestation for another owner, and a tally counted by another member', async () => {
        const sendAndConfirm = vi.fn();
        const outside = acceptanceChain({ lensHasMember: false });
        await expect(acceptWithAttestations({ connection: outside.chain.connection, ownerKeypair: outside.owner, proposalAccount: outside.proposal, parcelId, ownershipAttestation: outside.ownership, member: outside.member, sendAndConfirm }))
            .rejects.toThrow(/not in this proposal's lens/);
        const other = acceptanceChain({ attestedOwner: Keypair.generate().publicKey.toBase58() });
        await expect(acceptWithAttestations({ connection: other.chain.connection, ownerKeypair: other.owner, proposalAccount: other.proposal, parcelId, ownershipAttestation: other.ownership, member: other.member, sendAndConfirm }))
            .rejects.toThrow(/not the signer/);
        const counted = acceptanceChain({ ownerCount: 2, tally: { member: Keypair.generate().publicKey, required: 2, accepted: 1 } });
        await expect(acceptWithAttestations({ connection: counted.chain.connection, ownerKeypair: counted.owner, proposalAccount: counted.proposal, parcelId, ownershipAttestation: counted.ownership, member: counted.member, sendAndConfirm }))
            .rejects.toThrow(/already counted by member/);
        const wrongName = acceptanceChain();
        await expect(acceptWithAttestations({ connection: wrongName.chain.connection, ownerKeypair: wrongName.owner, proposalAccount: wrongName.proposal, parcelId, ownershipAttestation: wrongName.ownership, member: wrongName.member, credentialName: 'Other', sendAndConfirm }))
            .rejects.toThrow(/check credentialName/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('reads tallies and records back through their PDAs', async () => {
        const chain = fakeChain();
        const proposal = Keypair.generate().publicKey;
        const owner = Keypair.generate().publicKey;
        const member = Keypair.generate().publicKey;
        const payout = Keypair.generate().publicKey;
        chain.put(deriveConsentTallyPda({ proposalAccount: proposal, parcelId }), tallyAccount({ proposal, parcelId, member, required: 2, accepted: 1 }));
        chain.put(deriveAcceptanceRecordPda({ proposalAccount: proposal, parcelId, owner }), recordAccount({ proposal, parcelId, owner, member, attestation: member, payout }));
        expect(await readConsentTally({ connection: chain.connection, proposalAccount: proposal, parcelId }))
            .toMatchObject({ proposal: proposal.toBase58(), parcelId, member: member.toBase58(), required: 2, accepted: 1 });
        expect(await readAcceptanceRecord({ connection: chain.connection, proposalAccount: proposal, parcelId, owner }))
            .toMatchObject({ owner: owner.toBase58(), payout: payout.toBase58(), ownershipHash: '07'.repeat(32) });
        expect(await readConsentTally({ connection: chain.connection, proposalAccount: proposal, parcelId: 'other' })).toBeNull();
    });
});

describe('settle_with_verdict', () => {
    function verdictChain({ status = 0, verdict = 'expired', verdictMayExecute = false, inLens = true, parcelIds = ['HR-1'], accepted = [], openGround = false } = {}) {
        const chain = fakeChain();
        const member = Keypair.generate().publicKey.toBase58();
        const proposal = Keypair.generate().publicKey;
        const attestation = Keypair.generate().publicKey;
        chain.put(proposal, proposalAccount(status, {
            parcelIds, accepted, lens: inLens ? [member] : [], verdictMayExecute,
            siteHash: openGround ? Buffer.alloc(32, 1) : Buffer.alloc(32), openGround
        }));
        chain.putSas(attestation, attestationAccount('verdict', { member, fields: {
            proposalAccount: proposal.toBase58(), verdict, evidenceRef: 'agent-retire', sourceObservedAt: 1780000000
        } }));
        return { chain, member, proposal, attestation };
    }

    it('builds the IDL account order and matches the browser codec', () => {
        const [proposal, verdict, credential, submitter] = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
        const ix = buildSettleWithVerdictIx({ proposalAccount: proposal, verdictAttestation: verdict, verdictCredential: credential, submitter });
        const [record] = PublicKey.findProgramAddressSync([Buffer.from('verdict'), proposal.toBuffer(), verdict.toBuffer()], new PublicKey(PROPOSAL_PROGRAM_ID));
        expect(getVerdictRecordPda({ proposalAccount: proposal, verdictAttestation: verdict }).toBase58()).toBe(record.toBase58());
        expect(browser.getVerdictRecordPda(proposal, verdict)[0].toBase58()).toBe(record.toBase58());
        expect(flags(ix)).toEqual([
            [proposal.toBase58(), false, true], [verdict.toBase58(), false, false], [credential.toBase58(), false, false],
            [record.toBase58(), false, true], [submitter.toBase58(), true, true], [web3.SystemProgram.programId.toBase58(), false, false]
        ]);
        const theirs = browser.buildSettleWithVerdictIx({ proposal, verdict, verdictCredential: credential, submitter });
        expect([...ix.data]).toEqual([...theirs.data]);
        expect(flags(ix)).toEqual(flags(theirs));
    });

    it('submits an expired verdict from a lens member and replays once the proposal is Expired', async () => {
        const { chain, member, proposal, attestation } = verdictChain();
        const submitter = Keypair.generate();
        const sendAndConfirm = vi.fn(async (_connection, transaction) => {
            expect(transaction.instructions[0].keys[2].pubkey.toBase58()).toBe(deriveCredentialPda({ authority: member, name: 'LensMember' }));
            return 'settle-tx';
        });
        expect(await settleWithVerdict({ connection: chain.connection, submitterKeypair: submitter, proposalAccount: proposal, verdictAttestation: attestation, sendAndConfirm }))
            .toMatchObject({ replayed: false, signature: 'settle-tx', status: 'expired', member, record: getVerdictRecordPda({ proposalAccount: proposal, verdictAttestation: attestation }).toBase58() });
        chain.put(proposal, proposalAccount(3, { parcelIds: ['HR-1'], lens: [member] }));
        expect(await settleWithVerdict({ connection: chain.connection, submitterKeypair: submitter, proposalAccount: proposal, verdictAttestation: attestation, member, sendAndConfirm }))
            .toMatchObject({ replayed: true, signature: null, status: 'expired' });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('replays without sending when the VerdictRecord for that attestation already exists', async () => {
        const { chain, member, proposal, attestation } = verdictChain();
        const record = getVerdictRecordPda({ proposalAccount: proposal, verdictAttestation: attestation });
        // The proposal still reads Active: the record alone must stop a second send.
        chain.put(record, verdictRecordAccount({ proposal, member, attestation, verdictCode: 3 }));
        const read = await readVerdictRecord({ connection: chain.connection, proposalAccount: proposal, verdictAttestation: attestation });
        expect(read).toMatchObject({ address: record.toBase58(), proposal: proposal.toBase58(), member, verdictAttestation: attestation.toBase58(), verdict: 'expired', settledAt: 1790000000, bump: 251 });
        expect(browser.readVerdictRecord(verdictRecordAccount({ proposal, member, attestation }), record.toBase58()))
            .toMatchObject({ verdictAttestation: read.verdictAttestation, verdictHash: read.verdictHash, settledAt: read.settledAt });
        const sendAndConfirm = vi.fn();
        expect(await settleWithVerdict({ connection: chain.connection, submitterKeypair: Keypair.generate(), proposalAccount: proposal, verdictAttestation: attestation, sendAndConfirm }))
            .toMatchObject({ replayed: true, signature: null, status: 'expired', member, record: record.toBase58() });
        expect(sendAndConfirm).not.toHaveBeenCalled();
        expect(await readVerdictRecord({ connection: chain.connection, proposalAccount: proposal, verdictAttestation: Keypair.generate().publicKey })).toBeNull();
    });

    it('refuses an executed verdict without verdict_may_execute, a member outside the lens and a cancelled proposal', async () => {
        const sendAndConfirm = vi.fn();
        const submitterKeypair = Keypair.generate();
        const executed = verdictChain({ verdict: 'executed' });
        await expect(settleWithVerdict({ connection: executed.chain.connection, submitterKeypair, proposalAccount: executed.proposal, verdictAttestation: executed.attestation, sendAndConfirm }))
            .rejects.toThrow(/cannot skip per-parcel consent/);
        const outside = verdictChain({ inLens: false });
        await expect(settleWithVerdict({ connection: outside.chain.connection, submitterKeypair, proposalAccount: outside.proposal, verdictAttestation: outside.attestation, sendAndConfirm }))
            .rejects.toThrow(/not in this proposal's lens/);
        const cancelled = verdictChain({ status: 2 });
        await expect(settleWithVerdict({ connection: cancelled.chain.connection, submitterKeypair, proposalAccount: cancelled.proposal, verdictAttestation: cancelled.attestation, sendAndConfirm }))
            .rejects.toThrow(/not active/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
        const permitted = verdictChain({ verdict: 'executed', verdictMayExecute: true });
        const ok = await settleWithVerdict({ connection: permitted.chain.connection, submitterKeypair, proposalAccount: permitted.proposal, verdictAttestation: permitted.attestation, sendAndConfirm: vi.fn(async () => 'tx') });
        expect(ok).toMatchObject({ status: 'executed', signature: 'tx' });
    });

    it('v3: refuses an executed verdict on an empty binding without verdict_may_execute (no 0 == 0 shortcut)', async () => {
        const sendAndConfirm = vi.fn();
        const empty = verdictChain({ verdict: 'executed', parcelIds: [], openGround: true });
        await expect(settleWithVerdict({ connection: empty.chain.connection, submitterKeypair: Keypair.generate(), proposalAccount: empty.proposal, verdictAttestation: empty.attestation, sendAndConfirm }))
            .rejects.toThrow(/cannot skip per-parcel consent/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
        const permitted = verdictChain({ verdict: 'executed', parcelIds: [], openGround: true, verdictMayExecute: true });
        expect(await settleWithVerdict({ connection: permitted.chain.connection, submitterKeypair: Keypair.generate(), proposalAccount: permitted.proposal, verdictAttestation: permitted.attestation, sendAndConfirm: vi.fn(async () => 'tx') }))
            .toMatchObject({ status: 'executed', openGroundCleared: true });
    });

    it('v3: on open ground with parcels an executed verdict only clears the open ground until consent completes', async () => {
        const waiting = verdictChain({ verdict: 'executed', parcelIds: ['HR-1', 'HR-2'], accepted: ['HR-1'], openGround: true, verdictMayExecute: true });
        expect(await settleWithVerdict({ connection: waiting.chain.connection, submitterKeypair: Keypair.generate(), proposalAccount: waiting.proposal, verdictAttestation: waiting.attestation, sendAndConfirm: vi.fn(async () => 'tx') }))
            .toMatchObject({ status: 'active', verdict: 'executed', openGroundCleared: true });
        const complete = verdictChain({ verdict: 'executed', parcelIds: ['HR-1'], accepted: ['HR-1'], openGround: true, verdictMayExecute: true });
        expect(await settleWithVerdict({ connection: complete.chain.connection, submitterKeypair: Keypair.generate(), proposalAccount: complete.proposal, verdictAttestation: complete.attestation, sendAndConfirm: vi.fn(async () => 'tx') }))
            .toMatchObject({ status: 'executed', openGroundCleared: true });
    });

    it('expires by asking the lifecycle member for a verdict at the policy time, then settling it', async () => {
        const requestVerdict = vi.fn(async () => ({ address: 'verdict-address', authority: 'member-key', reused: false }));
        const settle = vi.fn(async () => ({ replayed: false, signature: 'settle-tx', status: 'expired' }));
        const lifecycle = { serviceUrl: 'http://lens.test', operatorToken: 't', key: 'member-key', credentialName: 'Lifecycle', evidenceRef: 'agent-retire' };
        const result = await expireWithVerdict({ connection: {}, submitterKeypair: Keypair.generate(), proposalAccount: 'P', lifecycle, sourceObservedAt: 1790000000, requestVerdict, settle });
        expect(requestVerdict).toHaveBeenCalledWith(expect.objectContaining({ proposalAccount: 'P', verdict: 'expired', sourceObservedAt: 1790000000, operatorToken: 't', evidenceRef: 'agent-retire' }));
        expect(settle).toHaveBeenCalledWith(expect.objectContaining({ verdictAttestation: 'verdict-address', member: 'member-key', credentialName: 'Lifecycle' }));
        expect(result).toMatchObject({ signature: 'settle-tx', verdictAttestation: 'verdict-address', sourceObservedAt: 1790000000 });
        await expect(expireWithVerdict({ connection: {}, submitterKeypair: Keypair.generate(), proposalAccount: 'P', lifecycle: { ...lifecycle, key: 'someone-else' }, sourceObservedAt: 1, requestVerdict, settle }))
            .rejects.toThrow(/signed as member-key/);
    });
});

describe('ownerless parcel anchors', () => {
    it('builds the v2 mint_parcel (parcel, payer, system) exactly as the browser codec', () => {
        const payer = Keypair.generate().publicKey;
        const parcelId = 'HR-335550-1813/6';
        const metadataUri = 'https://api.example.test/parcels/parcelIds?ids=x';
        const ix = buildMintParcelIx({ parcelId, payer, metadataUri });
        expect(ix.programId.toBase58()).toBe(PARCEL_PROGRAM_ID);
        expect(flags(ix)).toEqual([[deriveParcelAnchorPda(parcelId).toBase58(), false, true], [payer.toBase58(), true, true], [web3.SystemProgram.programId.toBase58(), false, false]]);
        const theirs = browser.buildMintParcelIx({ parcelId, metadataUri, payer }).instruction;
        expect([...ix.data]).toEqual([...theirs.data]);
        expect(flags(ix)).toEqual(flags(theirs));
    });

    it('mints a missing anchor and replays any existing one, whoever minted it', async () => {
        const payerKeypair = Keypair.generate();
        const sendAndConfirm = vi.fn(async () => 'mint-signature');
        const minted = await ensureParcelAnchor({
            connection: { getAccountInfo: vi.fn(async () => null) },
            payerKeypair, parcelId: 'HR-1-1', metadataUri: 'https://api.example.test/p', sendAndConfirm
        });
        expect(minted).toMatchObject({ replayed: false, signature: 'mint-signature', legacyOwner: null });
        expect(sendAndConfirm).toHaveBeenCalledTimes(1);

        const replay = vi.fn();
        const legacy = Keypair.generate().publicKey;
        const held = await ensureParcelAnchor({
            connection: { getAccountInfo: vi.fn(async () => ({ data: parcelAccount('HR-1-1', legacy) })) },
            payerKeypair, parcelId: 'HR-1-1', metadataUri: 'https://api.example.test/p', sendAndConfirm: replay
        });
        expect(held).toMatchObject({ replayed: true, signature: null, parcelAccount: minted.parcelAccount, legacyOwner: legacy.toBase58() });
        const ownerless = await ensureParcelAnchor({
            connection: { getAccountInfo: vi.fn(async () => ({ data: parcelAccount('HR-1-1') })) },
            payerKeypair, parcelId: 'HR-1-1', metadataUri: 'https://api.example.test/p', sendAndConfirm: replay
        });
        expect(ownerless).toMatchObject({ replayed: true, legacyOwner: null });
        expect(replay).not.toHaveBeenCalled();
    });
});
