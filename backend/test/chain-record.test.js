// Portable mint metadata, read side (frontend/js/proposals/chain-record.js): a minted proposal's NFT
// metadata must hold exactly an authored record, which must agree with the chain's commitments. The
// write side went with the design mint path (plan-design-agreement.md, M2); agreements mint in M3, so
// a portable record carries no terms, kind or runtime state at all.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chainRecord = require('../../frontend/js/proposals/chain-record.js');
const siteHash = require('../../frontend/js/proposals/site-hash.js');
const approval = require('../../frontend/js/proposals/approval.js');
const SITE = {
    type: 'Polygon',
    coordinates: [[[15.970, 45.800], [15.971, 45.800], [15.971, 45.801], [15.970, 45.801], [15.970, 45.800]]]
};
// A portable record as a minted proposal's metadata carries it.
function portable(overrides = {}) {
    return {
        proposalId: 'portable-1', city: 'zagreb', type: 'structure', goal: 'park', title: 'Pocket park', titleOrigin: 'user',
        description: 'A small authored park', author: 'Guest 12', lens: ['0x000000000000000000000000000000000000000a'],
        site: SITE, binding: { coverage: 'complete', parcels: [{ parcelId: 'HR-1', overlapM2: 100 }], toleranceM: 0 },
        cadastreSnapshot: { protocol: 'cadastre-snapshot/1', source: 'cadastre-v1', regionHasCadastre: true,
            parcels: [{ id: 'HR-1', sourceId: 'cadastre-v1', sourceVersion: null, sourceGeometryHash: null, geometryHash: 'a'.repeat(64), geometry: SITE }] },
        structureProposal: { geometry: SITE }, cadastreParcelIds: ['HR-1'],
        ...overrides
    };
}
const metadata = record => ({ properties: { proposalProtocol: chainRecord.PROTOCOL, proposal: record } });
const refusal = expect.objectContaining({ code: 'chain-record-invalid', status: 422 });

describe('reading a portable proposal from NFT metadata', () => {
    it('restores the full authored site and geometry as a copy of the metadata', () => {
        const record = portable({ freePlacement: true });
        const restored = chainRecord.fromMetadata(metadata(record));
        expect(chainRecord.PROTOCOL).toBe('proposal-chain/1');
        expect(restored).toEqual(record);
        expect(restored).not.toBe(record);
        expect(restored.site).toEqual(SITE);
        expect(restored.structureProposal.geometry).toEqual(SITE);
        expect(restored.cadastreSnapshot.parcels[0].geometry).toEqual(SITE);
        expect(restored.freePlacement).toBe(true);
    });

    it('refuses metadata that is not a complete portable proposal', () => {
        const record = portable();
        const broken = [
            { properties: { proposalProtocol: 'proposal-chain/0', proposal: record } },
            { properties: { proposalProtocol: chainRecord.PROTOCOL } },
            { properties: { proposalProtocol: chainRecord.PROTOCOL, proposal: [record] } },
            null
        ];
        broken.forEach(value => expect(() => chainRecord.fromMetadata(value)).toThrowError(refusal));
        for (const key of ['site', 'binding', 'cadastreSnapshot']) {
            const { [key]: _dropped, ...rest } = record;
            expect(() => chainRecord.fromMetadata(metadata(rest))).toThrow(/missing its site, binding, or cadastral snapshot/);
        }
    });

    it('refuses terms, kinds, runtime state and server preparation: only authored fields are portable', () => {
        const foreign = {
            offer: 1000, offerCurrency: 'EUR', budget: 5, kind: 'community-vote', isConditional: false, expiresAt: '2027-01-01T00:00:00.000Z',
            voteExpiryDays: 30, depositEnabled: true, decayEnabled: true, disbursementMode: 'escrow', isVote: true, effectHash: 'e-1',
            acceptedParcelIds: ['HR-1'], ownerAcceptances: { 'HR-1': true }, status: 'Executed', applied: true, appliedAt: 'later',
            childParcelIds: ['generated'], preparation: { id: 'prep', signature: 'server-key' }, preparedArtifact: { signature: 'server-key' }
        };
        for (const [key, value] of Object.entries(foreign)) {
            expect(chainRecord.FIELDS).not.toContain(key);
            expect(() => chainRecord.fromMetadata(metadata(portable({ [key]: value }))), key).toThrow(/non-authored fields/);
        }
    });

    it('refuses duplicate or derived parcel ids and a browser-local origin', () => {
        expect(() => chainRecord.fromMetadata(metadata(portable({ cadastreParcelIds: ['HR-1', 'HR-1'] })))).toThrow(/unique, original cadastral/);
        expect(() => chainRecord.fromMetadata(metadata(portable({ cadastreParcelIds: ['HR-1#2'] })))).toThrow(/unique, original cadastral/);
        expect(() => chainRecord.fromMetadata(metadata(portable({ cadastreParcelIds: [' HR-1'] })))).toThrow(/unique, original cadastral/);
        expect(() => chainRecord.fromMetadata(metadata(portable({
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'p-local' } }
        })))).toThrow(/browser-local key/);
        const cid = require('../../frontend/js/cid.js').cidOfObject({ schema: 'design/v1', title: 'Source' });
        const published = portable({ proposalOrigin: { relation: 'copy', source: { kind: 'design', cid } } });
        expect(chainRecord.fromMetadata(metadata(published)).proposalOrigin).toEqual(published.proposalOrigin);
    });

    it('restores the normalized approval setup and refuses one the engine cannot read', () => {
        const rights = { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-1' },
            parcels: [{ parcelId: 'HR-1', complete: true, areaM2: 100, owners: [{ ownerId: 'owner-b', share: '2/4' }, { ownerId: 'owner-a', share: '1/2' }] }] };
        const config = { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } };
        const restored = chainRecord.fromMetadata(metadata(portable({ approvalConfig: config })));
        expect(restored.approvalConfig).toEqual(approval.normalizeConfig(config));
        expect(restored.approvalConfig.rights.parcels[0].owners).toEqual([{ ownerId: 'owner-a', share: '1/2' }, { ownerId: 'owner-b', share: '1/2' }]);
        expect(() => chainRecord.fromMetadata(metadata(portable({ approvalConfig: { schema: 'wrong' } })))).toThrow(/approval setup is invalid/);
        expect(() => chainRecord.fromMetadata(metadata(portable({ approvalConfig: { ...config, rights: [] } })))).toThrow(/approval setup is invalid/);
    });
});

describe('a portable proposal against its chain commitments', () => {
    it('rejects disagreement between metadata and the chain consent parcel list', async () => {
        const record = portable();
        await expect(chainRecord.verifyAgainstChain(record, { cadastreParcelIds: ['HR-2'], lens: record.lens })).rejects.toMatchObject({ code: 'chain-record-invalid', status: 422 });
        // The binding must name the same parcels as the consent list.
        const unbound = portable({ binding: { coverage: 'complete', parcels: [{ parcelId: 'HR-9', overlapM2: 100 }], toleranceM: 0 } });
        await expect(chainRecord.verifyAgainstChain(unbound, { cadastreParcelIds: ['HR-1'], lens: unbound.lens })).rejects.toThrow(/binding and consent list disagree/);
    });

    it('compares the lens case-insensitively for EVM addresses only', async () => {
        const record = portable();
        const upper = [record.lens[0].toUpperCase().replace('0X', '0x')];
        await expect(chainRecord.verifyAgainstChain(record, { ref: { chainType: 'evm' }, cadastreParcelIds: ['HR-1'], lens: upper })).resolves.toEqual(record);
        await expect(chainRecord.verifyAgainstChain(record, { ref: { chainType: 'solana' }, cadastreParcelIds: ['HR-1'], lens: upper }))
            .rejects.toThrow(/on-chain lens disagree/);
    });

    it('rejects a changed authored site hash and an open-ground flag mismatch', async () => {
        const record = portable();
        const committedHash = await siteHash.siteHashHex(record.site);
        const chain = { cadastreParcelIds: ['HR-1'], lens: record.lens, siteHash: committedHash, openGround: false };
        const changed = { ...record, site: {
            type: 'Polygon', coordinates: [[[15.970, 45.800], [15.972, 45.800], [15.972, 45.801], [15.970, 45.801], [15.970, 45.800]]]
        } };
        await expect(chainRecord.verifyAgainstChain(changed, chain)).rejects.toMatchObject({ code: 'chain-record-invalid', status: 422 });
        await expect(chainRecord.verifyAgainstChain(record, { ...chain, openGround: true })).rejects.toMatchObject({ code: 'chain-record-invalid', status: 422 });
    });

    it('accepts matching chain consent, lens and Solana site commitments', async () => {
        const record = portable();
        const siteArgs = await siteHash.chainSiteArgs({ site: record.site, binding: record.binding, parcelIds: record.cadastreParcelIds });
        await expect(chainRecord.verifyAgainstChain(record, {
            ref: { chainType: 'solana' }, cadastreParcelIds: ['HR-1'], lens: record.lens,
            siteHash: await siteHash.siteHashHex(record.site), openGround: siteArgs.openGround
        })).resolves.toEqual(record);
    });
});
