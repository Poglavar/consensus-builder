import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
    acceptProposal, buildAcceptProposalIx, buildCancelProposalIx, buildMintParcelIx, cancelProposal,
    ensureParcelCertificate, PARCEL_PROGRAM_ID, PROPOSAL_PROGRAM_ID
} from '../agents/lifecycle-actions.js';
import { instructionDiscriminator } from '../agents/minter.js';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');

function string(value) {
    const text = Buffer.from(value);
    const length = Buffer.alloc(4); length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
}

function stringVector(values) {
    const count = Buffer.alloc(4); count.writeUInt32LE(values.length);
    return Buffer.concat([count, ...values.map(string)]);
}

function proposalAccount(status, { owner = Keypair.generate().publicKey, parcelIds = [], accepted = [] } = {}) {
    return Buffer.concat([
        Buffer.alloc(8), Buffer.alloc(8), owner.toBuffer(), stringVector(parcelIds),
        Buffer.from([1]), string(''), Buffer.from([1, status]), Buffer.alloc(24),
        stringVector(accepted), Buffer.alloc(4), Buffer.from([255])
    ]);
}

function parcelAccount(parcelId, owner) {
    return Buffer.concat([Buffer.alloc(8), string(parcelId), string(''), owner.toBuffer(), Buffer.from([255])]);
}

describe('shared terminal lifecycle actions', () => {
    it('builds the same owner-only cancellation instruction as the wallet flow', () => {
        const proposal = Keypair.generate().publicKey;
        const owner = Keypair.generate().publicKey;
        const ix = buildCancelProposalIx({ proposalAccount: proposal, owner });
        expect(ix.programId.toBase58()).toBe(PROPOSAL_PROGRAM_ID);
        expect(ix.keys.map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable])).toEqual([
            [proposal.toBase58(), false, true], [owner.toBase58(), true, true]
        ]);
        expect([...ix.data]).toEqual([...instructionDiscriminator('cancel_and_refund')]);
    });

    it('builds the same parcel-owner acceptance instruction as the wallet flow', () => {
        const proposal = Keypair.generate().publicKey;
        const owner = Keypair.generate().publicKey;
        const parcelId = 'HR-335550-1813/2';
        const ix = buildAcceptProposalIx({ proposalAccount: proposal, parcelId, accepter: owner });
        expect(ix.programId.toBase58()).toBe(PROPOSAL_PROGRAM_ID);
        expect(ix.keys[2].pubkey.toBase58()).toBe(PARCEL_PROGRAM_ID);
        expect(ix.keys[3]).toMatchObject({ isSigner: true, isWritable: false });
        expect([...ix.data.subarray(0, 8)]).toEqual([...instructionDiscriminator('accept_proposal')]);
        expect(ix.data.subarray(12).toString()).toBe(parcelId);
    });

    it('does not submit cancellation twice after the chain is already terminal', async () => {
        const ownerKeypair = Keypair.generate();
        const sendAndConfirm = vi.fn();
        const result = await cancelProposal({
            connection: { getAccountInfo: vi.fn(async () => ({ data: proposalAccount(2) })) },
            ownerKeypair, proposalAccount: Keypair.generate().publicKey,
            sendAndConfirm
        });
        expect(result).toEqual({ replayed: true, signature: null, status: 'cancelled' });
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('submits one signed cancellation for an active proposal', async () => {
        const ownerKeypair = Keypair.generate();
        const sendAndConfirm = vi.fn(async () => 'cancel-tx');
        const result = await cancelProposal({
            connection: { getAccountInfo: vi.fn(async () => ({ data: proposalAccount(0, { owner: ownerKeypair.publicKey }) })) },
            ownerKeypair, proposalAccount: Keypair.generate().publicKey,
            sendAndConfirm
        });
        expect(result).toEqual({ replayed: false, signature: 'cancel-tx', status: 'cancelled' });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('checks parcel ownership before signing an acceptance', async () => {
        const parcelId = 'HR-335550-1813/2';
        const accepterKeypair = Keypair.generate();
        const actualOwner = Keypair.generate();
        const proposal = Keypair.generate().publicKey;
        const connection = { getAccountInfo: vi.fn()
            .mockResolvedValueOnce({ data: proposalAccount(0, { owner: Keypair.generate().publicKey, parcelIds: [parcelId] }) })
            .mockResolvedValueOnce({ data: parcelAccount(parcelId, actualOwner.publicKey) }) };
        const sendAndConfirm = vi.fn();
        await expect(acceptProposal({
            connection, accepterKeypair, proposalAccount: proposal, parcelId, sendAndConfirm
        })).rejects.toThrow('signer is not the on-chain parcel owner');
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });
});

describe('parcel certificates for the executed case', () => {
    it('builds the same first-come mint_parcel instruction as the wallet flow', () => {
        const owner = Keypair.generate().publicKey;
        const parcelId = 'HR-335550-1813/6';
        const ix = buildMintParcelIx({ parcelId, owner, metadataUri: 'https://api.example.test/parcels/parcelIds?ids=x' });
        expect(ix.programId.toBase58()).toBe(PARCEL_PROGRAM_ID);
        expect(ix.keys.map(key => [key.isSigner, key.isWritable])).toEqual([[false, true], [true, true], [false, false]]);
        expect(ix.keys[1].pubkey.toBase58()).toBe(owner.toBase58());
        expect([...ix.data.subarray(0, 8)]).toEqual([...instructionDiscriminator('mint_parcel')]);
        expect(ix.data.subarray(12, 12 + parcelId.length).toString()).toBe(parcelId);
    });

    it('mints a missing certificate to the signer and replays one the signer already holds', async () => {
        const ownerKeypair = Keypair.generate();
        const sendAndConfirm = vi.fn(async () => 'mint-signature');
        const minted = await ensureParcelCertificate({
            connection: { getAccountInfo: vi.fn(async () => null) },
            ownerKeypair, parcelId: 'HR-1-1', metadataUri: 'https://api.example.test/p', sendAndConfirm
        });
        expect(minted).toMatchObject({ replayed: false, signature: 'mint-signature', owner: ownerKeypair.publicKey.toBase58() });
        expect(sendAndConfirm).toHaveBeenCalledTimes(1);

        const replay = vi.fn();
        const held = await ensureParcelCertificate({
            connection: { getAccountInfo: vi.fn(async () => ({ data: parcelAccount('HR-1-1', ownerKeypair.publicKey) })) },
            ownerKeypair, parcelId: 'HR-1-1', metadataUri: 'https://api.example.test/p', sendAndConfirm: replay
        });
        expect(held).toMatchObject({ replayed: true, signature: null, parcelAccount: minted.parcelAccount });
        expect(replay).not.toHaveBeenCalled();
    });

    it('refuses to touch a certificate held by another wallet', async () => {
        const ownerKeypair = Keypair.generate();
        const other = Keypair.generate().publicKey;
        const sendAndConfirm = vi.fn();
        await expect(ensureParcelCertificate({
            connection: { getAccountInfo: vi.fn(async () => ({ data: parcelAccount('HR-1-1', other) })) },
            ownerKeypair, parcelId: 'HR-1-1', metadataUri: 'https://api.example.test/p', sendAndConfirm
        })).rejects.toThrow(/held by/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });
});
