import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { normalizeChainRef, readChainProposal } from '../proposals/chain-reader.js';

const SOL_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const SOL_ADDRESS = '11111111111111111111111111111111';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const accountDiscriminator = createHash('sha256').update('account:Proposal').digest().subarray(0, 8);
const borshString = value => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
};
const borshVec = values => {
    const length = Buffer.alloc(4); length.writeUInt32LE(values.length);
    return Buffer.concat([length, ...values.map(borshString)]);
};

function proposalAccount({ parcels = ['HR-1'], uri = 'ipfs://metadata-cid', lens = [SOL_ADDRESS], conditional = true, openGroundByte = 1 } = {}) {
    const sequence = Buffer.alloc(8);
    const owner = new PublicKey('Vote111111111111111111111111111111111111111').toBuffer();
    const conditionalByte = Buffer.from([conditional ? 1 : 0]);
    const accepted = Buffer.alloc(4);
    const lensLength = Buffer.alloc(4); lensLength.writeUInt32LE(lens.length);
    const tail = Buffer.concat([
        Buffer.from([1, 1]), // bump, verdict_may_execute
        Buffer.from('ab'.repeat(32), 'hex'),
        Buffer.from([openGroundByte, 0, 3]) // open_ground, cleared, layout_version
    ]);
    const body = Buffer.concat([
        accountDiscriminator, sequence, owner, borshVec(parcels), conditionalByte,
        borshString(uri), Buffer.from([1, 0]), Buffer.alloc(24), accepted,
        lensLength, ...lens.map(value => new PublicKey(value).toBuffer()), tail
    ]);
    const padded = Buffer.alloc(4096);
    body.copy(padded);
    return { data: padded, body, owner, proposalOwner: new PublicKey(owner).toBase58() };
}

describe('normalizeChainRef', () => {
    it('canonicalizes configured EVM and Solana locations', () => {
        expect(normalizeChainRef({ chainType: 'EVM', chainId: '0x14a34', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: '0005' }))
            .toEqual({ chainType: 'evm', chainId: '84532', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: '5' });
        expect(normalizeChainRef({ chainType: 'solana', chainId: 'devnet', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS }))
            .toEqual({ chainType: 'solana', chainId: 'solana-devnet', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS });
    });

    it('rejects unknown deployments, substituted contracts, and Canton public mirroring', () => {
        expect(() => normalizeChainRef({ chainType: 'evm', chainId: '84532', contract: '0x0000000000000000000000000000000000000001', tokenId: '1' }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-proof-invalid' }));
        expect(() => normalizeChainRef({ chainType: 'solana', chainId: 'mainnet-beta', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS }))
            .toThrow(expect.objectContaining({ status: 422 }));
        expect(() => normalizeChainRef({ chainType: 'canton', chainId: 'devnet', contract: 'canton', tokenId: 'cid' }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-mirror-private' }));
        expect(() => normalizeChainRef({ chainType: 'evm', chainId: '84532', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: '9'.repeat(79) }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-proof-invalid' }));
        expect(() => normalizeChainRef({ chainType: 'evm', chainId: '84532', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: ((1n << 256n) - 1n + 1n).toString() }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-proof-invalid' }));
    });
});

describe('readChainProposal (EVM)', () => {
    const ref = { chainType: 'evm', chainId: '84532', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: '5' };

    it('reads parcel consent, metadata URI, lens, conditional flag, and owner from the configured contract', async () => {
        const result = await readChainProposal(ref, {
            evmProviderFactory: async () => ({ getNetwork: async () => ({ chainId: 84532n }) }),
            evmContractFactory: async () => ({
                getProposal: async () => [['HR-1', 'HR-2'], true, 'ipfs://cid', true, 0, 0n, 0n, 0n, 0n, 0n],
                getLens: async () => ['0x000000000000000000000000000000000000000a'],
                ownerOf: async () => '0x000000000000000000000000000000000000000b'
            })
        });
        expect(result).toMatchObject({
            ref: { chainType: 'evm', chainId: '84532', tokenId: '5' },
            cadastreParcelIds: ['HR-1', 'HR-2'], metadataUri: 'ipfs://cid', isConditional: true,
            owner: '0x000000000000000000000000000000000000000b'
        });
        expect(result.lens).toEqual(['0x000000000000000000000000000000000000000a']);
        expect(result).not.toHaveProperty('siteHash');
    });

    it('rejects a provider connected to a different chain and hides RPC failures', async () => {
        await expect(readChainProposal(ref, { evmProviderFactory: async () => ({ getNetwork: async () => ({ chainId: 1n }) }) }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
        await expect(readChainProposal(ref, { evmProviderFactory: async () => { throw new Error('secret endpoint token'); } }))
            .rejects.toMatchObject({ status: 503, code: 'chain-proof-unavailable', message: expect.not.stringContaining('secret') });
    });

    it('destroys the provider when the read completes', async () => {
        let destroyed = false;
        await readChainProposal(ref, {
            evmProviderFactory: async () => ({ getNetwork: async () => ({ chainId: 84532n }), destroy: () => { destroyed = true; } }),
            evmContractFactory: async () => ({
                getProposal: async () => [['HR-1'], false, 'ipfs://cid'],
                getLens: async () => [], ownerOf: async () => '0x000000000000000000000000000000000000000b'
            })
        });
        expect(destroyed).toBe(true);
    });
});

describe('readChainProposal (Solana)', () => {
    const ref = { chainType: 'solana', chainId: 'devnet', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS };
    const valid = proposalAccount();
    const connectionFor = (owner = SOL_PROGRAM, data = valid.data, genesis = DEVNET_GENESIS) => ({
        getGenesisHash: async () => genesis,
        getAccountInfo: async () => ({ owner: new PublicKey(owner), data })
    });

    it('verifies devnet, program ownership, account layout, and decodes proposal fields', async () => {
        const result = await readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor() });
        expect(result).toMatchObject({
            cadastreParcelIds: ['HR-1'], metadataUri: 'ipfs://metadata-cid', lens: [SOL_ADDRESS],
            isConditional: true, owner: valid.proposalOwner, siteHash: 'ab'.repeat(32), openGround: true, layoutVersion: 3
        });
    });

    it('rejects wrong program owner, wrong cluster endpoint, wrong discriminator, and truncated fields', async () => {
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor(SOL_ADDRESS) }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor(SOL_PROGRAM, valid.data, 'wrong') }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
        const wrongDiscriminator = Buffer.from(valid.data); wrongDiscriminator[0] ^= 0xff;
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor(SOL_PROGRAM, wrongDiscriminator) }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor(SOL_PROGRAM, valid.data.subarray(0, 30)) }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor(SOL_PROGRAM, valid.body.subarray(0, valid.body.length - 1)) }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
        const badFlag = proposalAccount({ openGroundByte: 2 });
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => connectionFor(SOL_PROGRAM, badFlag.data) }))
            .rejects.toMatchObject({ status: 422, code: 'chain-proof-invalid' });
    });

    it('maps read failures to a sanitized 503', async () => {
        await expect(readChainProposal(ref, { solanaConnectionFactory: async () => ({ getGenesisHash: async () => { throw new Error('private rpc URL'); } }) }))
            .rejects.toMatchObject({ status: 503, code: 'chain-proof-unavailable', message: expect.not.stringContaining('private') });
    });
});
