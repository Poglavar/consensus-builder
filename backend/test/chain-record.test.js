// Portable mint metadata: round-trip authored geometry and require it to agree with chain commitments.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chainRecord = require('../../frontend/js/proposals/chain-record.js');
const siteHash = require('../../frontend/js/proposals/site-hash.js');
const SITE = {
    type: 'Polygon',
    coordinates: [[[15.970, 45.800], [15.971, 45.800], [15.971, 45.801], [15.970, 45.801], [15.970, 45.800]]]
};
function authored(overrides = {}) {
    return chainRecord.authoredRecord({
        proposalId: 'portable-1', city: 'zagreb', type: 'structure', goal: 'park', title: 'Pocket park',
        description: 'A small authored park', author: 'Guest 12', isConditional: false, lens: ['0x000000000000000000000000000000000000000a'],
        site: SITE, binding: { coverage: 'complete', parcels: [{ parcelId: 'HR-1', overlapM2: 100 }], toleranceM: 0 },
        cadastreSnapshot: { protocol: 'cadastre-snapshot/1', source: 'cadastre-v1', regionHasCadastre: true,
            parcels: [{ id: 'HR-1', sourceId: 'cadastre-v1', sourceVersion: null, sourceGeometryHash: null, geometryHash: 'a'.repeat(64), geometry: SITE }] },
        structureProposal: { geometry: SITE }, cadastreParcelIds: ['HR-1'],
        ...overrides
    });
}

describe('portable chain proposal record', () => {
    it('round-trips the full authored site and geometry through NFT metadata', async () => {
        const record = authored();
        const metadata = { properties: chainRecord.metadataProperties(record) };
        const restored = chainRecord.fromMetadata(metadata);
        expect(metadata.properties.proposalProtocol).toBe('proposal-chain/1');
        expect(restored.site).toEqual(SITE);
        expect(restored.structureProposal.geometry).toEqual(SITE);
        expect(restored.cadastreSnapshot.parcels[0].geometry).toEqual(SITE);
        expect(restored).toEqual(record);
    });

    it('omits runtime state, acceptance claims, and server preparation/signature from the portable record', async () => {
        const record = authored({
            acceptedParcelIds: ['HR-1'], ownerAcceptances: { 'HR-1': true },
            status: 'Executed', applied: true, appliedAt: 'later', childParcelIds: ['generated'],
            preparation: { id: 'prep', digest: 'x', signature: 'server-key' },
            preparedArtifact: { signature: 'server-key' }
        });
        const metadataRecord = chainRecord.metadataProperties(record).proposal;
        for (const key of ['acceptedParcelIds', 'ownerAcceptances', 'status', 'applied', 'appliedAt', 'childParcelIds', 'preparation', 'preparedArtifact']) {
            expect(metadataRecord).not.toHaveProperty(key);
        }
    });

    it('rejects disagreement between metadata and the chain consent parcel list', async () => {
        const record = authored();
        await expect(chainRecord.verifyAgainstChain(record, {
            cadastreParcelIds: ['HR-2'], lens: record.lens, isConditional: false
        })).rejects.toMatchObject({ code: 'chain-record-invalid', status: 422 });
    });

    it('rejects a changed authored site hash and an open-ground flag mismatch', async () => {
        const record = authored();
        const committedHash = await siteHash.siteHashHex(record.site);
        const chain = { cadastreParcelIds: ['HR-1'], lens: record.lens, isConditional: false, siteHash: committedHash, openGround: false };
        const changed = { ...record, site: {
            type: 'Polygon', coordinates: [[[15.970, 45.800], [15.972, 45.800], [15.972, 45.801], [15.970, 45.801], [15.970, 45.800]]]
        } };
        await expect(chainRecord.verifyAgainstChain(changed, chain)).rejects.toMatchObject({ code: 'chain-record-invalid', status: 422 });
        await expect(chainRecord.verifyAgainstChain(record, { ...chain, openGround: true })).rejects.toMatchObject({ code: 'chain-record-invalid', status: 422 });
    });

    it('accepts matching chain consent, lens, conditional and Solana site commitments', async () => {
        const record = authored();
        const siteArgs = await siteHash.chainSiteArgs({ site: record.site, binding: record.binding, parcelIds: record.cadastreParcelIds });
        await expect(chainRecord.verifyAgainstChain(record, {
            ref: { chainType: 'solana' }, cadastreParcelIds: ['HR-1'], lens: record.lens,
            isConditional: false, siteHash: await siteHash.siteHashHex(record.site), openGround: siteArgs.openGround
        })).resolves.toEqual(record);
    });
});
