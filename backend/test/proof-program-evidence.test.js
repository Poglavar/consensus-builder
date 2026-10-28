import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import {
    createProgramEvidenceReader,
    PROGRAM_EVIDENCE_TTL_MS,
    readProgramEvidence
} from '../hackathon/program-evidence.js';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAMS = [{ name: 'Fixture', address: new PublicKey(Buffer.alloc(32, 7)).toBase58() }];
const PROGRAM_DATA_ADDRESS = new PublicKey(Buffer.alloc(32, 8));
const BINARY = Buffer.from([0, 1, 2, 127, 128, 255]);
const SLOT = 987654321n;

function programAccount({ owner = LOADER, executable = true, dataAddress = PROGRAM_DATA_ADDRESS } = {}) {
    const data = Buffer.alloc(36);
    data.writeUInt32LE(2, 0);
    dataAddress.toBuffer().copy(data, 4);
    return { owner, executable, data };
}

function programDataAccount({ owner = LOADER, binary = BINARY, slot = SLOT } = {}) {
    const data = Buffer.alloc(45 + binary.length);
    data.writeUInt32LE(3, 0);
    data.writeBigUInt64LE(slot, 4);
    data[12] = 1;
    Buffer.alloc(32, 9).copy(data, 13);
    binary.copy(data, 45);
    return { owner, data };
}

function fakeConnection({ genesis = DEVNET_GENESIS_HASH, executable = programAccount(), programData = programDataAccount() } = {}) {
    return {
        getGenesisHash: vi.fn(async () => genesis),
        getMultipleAccountsInfo: vi.fn(async (addresses) => addresses.map((address) => {
            if (address.equals(new PublicKey(PROGRAMS[0].address))) return executable;
            if (address.equals(PROGRAM_DATA_ADDRESS)) return programData;
            return programAccount({ dataAddress: PROGRAM_DATA_ADDRESS });
        }))
    };
}

describe('readProgramEvidence', () => {
    it('parses fixture accounts and hashes only deployed bytes, timestamping the observation', async () => {
        const connection = fakeConnection();
        const observedAt = Date.UTC(2026, 9, 25, 12);
        const result = await readProgramEvidence(connection, { programs: PROGRAMS, now: () => observedAt });

        expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ state: 'verified', verifiedAt: new Date(observedAt).toISOString() });
        expect(result.programs[0]).toMatchObject({
            ...PROGRAMS[0], network: 'solana:devnet',
            programDataAddress: PROGRAM_DATA_ADDRESS.toBase58(),
            lastDeployedSlot: Number(SLOT),
            binarySha256: createHash('sha256').update(BINARY).digest('hex'),
            upgradeAuthority: new PublicKey(Buffer.alloc(32, 9)).toBase58()
        });
    });

    it('rejects a non-devnet genesis hash', async () => {
        await expect(readProgramEvidence(fakeConnection({ genesis: 'wrong' }), { programs: PROGRAMS }))
            .rejects.toThrow('Expected Solana devnet');
    });

    it.each([
        ['wrong program owner', { executable: programAccount({ owner: new PublicKey(Buffer.alloc(32, 3)) }) }],
        ['non-executable program', { executable: programAccount({ executable: false }) }],
        ['missing ProgramData', { programData: null }],
        ['wrong ProgramData owner', { programData: programDataAccount({ owner: new PublicKey(Buffer.alloc(32, 4)) }) }]
    ])('rejects %s', async (_label, options) => {
        await expect(readProgramEvidence(fakeConnection(options), { programs: PROGRAMS })).rejects.toThrow();
    });
});

describe('createProgramEvidenceReader cache', () => {
    it('keeps the successful observation timestamp during the 15-minute cache window', async () => {
        let now = 1000;
        const connection = fakeConnection();
        const reader = createProgramEvidenceReader({ connection, now: () => now });
        const first = await reader();
        now += PROGRAM_EVIDENCE_TTL_MS - 1;
        const cached = await reader();

        expect(cached).toBe(first);
        expect(cached.verifiedAt).toBe(new Date(1000).toISOString());
        expect(connection.getGenesisHash).toHaveBeenCalledTimes(1);
    });

    it('rechecks after expiry and reports the new successful observation time', async () => {
        let now = 1000;
        const connection = fakeConnection();
        const reader = createProgramEvidenceReader({ connection, now: () => now });
        const first = await reader();
        now += PROGRAM_EVIDENCE_TTL_MS;
        const refreshed = await reader();

        expect(refreshed).not.toBe(first);
        expect(refreshed.verifiedAt).toBe(new Date(now).toISOString());
        expect(connection.getGenesisHash).toHaveBeenCalledTimes(2);
    });

    it('does not serve an expired result when the recheck fails', async () => {
        let now = 1000;
        const connection = fakeConnection();
        connection.getGenesisHash.mockResolvedValueOnce(DEVNET_GENESIS_HASH).mockResolvedValueOnce('wrong');
        const reader = createProgramEvidenceReader({ connection, now: () => now });
        const first = await reader();
        now += PROGRAM_EVIDENCE_TTL_MS;

        await expect(reader()).rejects.toThrow('Expected Solana devnet');
        expect(first.verifiedAt).toBe(new Date(1000).toISOString());
        expect(connection.getGenesisHash).toHaveBeenCalledTimes(2);
    });
});
