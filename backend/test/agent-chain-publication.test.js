import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
    agentParcelSource, mirrorAgentPublication, prepareAgentPublication, verifyPublicationReadable
} from '../agents/chain-publication.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const chainRecord = require('../../frontend/js/proposals/chain-record.js');

const polygon = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const LEFT = polygon(15.970, 45.7995, 15.971, 45.8015);
const RIGHT = polygon(15.971, 45.7995, 15.972, 45.8015);
const BUILDING = polygon(15.9707, 45.8002, 15.9713, 45.8008);
const LENS = ['5x8hiYo9V6kWpG8eVoyXZf4BHXnKSoCP3r7r3PyMBg4z'];
const PINNED_IMAGE = { ipfsUri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh3q5gq2v6gzb7h2t2z2z2z2z2z2z2z2', gatewayUrl: 'https://gateway.example/image.png' };
const PINNED_METADATA = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh3q5gq2v6gzb7h2t2z2z2z2z2z2z2z3';

function fixture() {
    const candidate = {
        candidateId: 'candidate-a',
        parcelId: 'HR-1',
        offerEur: 18000,
        normalizedRule: { maxHeightM: 9 },
        massing: {
            type: 'Feature',
            geometry: BUILDING,
            properties: { height: 9, floors: 3 }
        }
    };
    const pick = { proposalId: 'agent-test-01', candidateId: 'candidate-a', name: 'A cross-boundary building', rationale: 'A compact mixed-use infill.' };
    const persona = { name: 'builder-02', wallet: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg', stakeUsdc: '0.25', controller: 'algorithm' };
    const args = { pool: {}, candidate, pick, persona, runId: '2026-10-11-h09-builder-02', city: 'zagreb', lens: LENS };
    const loadGround = vi.fn(async () => ({
        source: 'zagreb-cadastre-v1',
        parcels: [
            { type: 'Feature', geometry: LEFT, properties: { parcelId: 'HR-1', sourceId: 'zagreb-cadastre-v1', sourceVersion: '2026-10-01' } },
            { type: 'Feature', geometry: RIGHT, properties: { parcelId: 'HR-2', sourceId: 'zagreb-cadastre-v1', sourceVersion: '2026-10-01' } }
        ]
    }));
    const checkBinding = vi.fn(async () => ({ ok: true, binding: { coverage: 'complete' } }));
    const render = vi.fn(async () => ({ buffer: Buffer.from('rendered png') }));
    const pinImage = vi.fn(async () => PINNED_IMAGE);
    const pinMetadata = vi.fn(async () => ({ ipfsUri: PINNED_METADATA }));
    const now = () => new Date('2026-10-11T09:30:00.000Z');
    return { args, deps: { loadGround, checkBinding, render, pinImage, pinMetadata, now }, spies: { loadGround, checkBinding, render, pinImage, pinMetadata } };
}


describe('agent chain publication', () => {
    it('keeps explicit NYC tax-lot identity even when that source is not the city default', () => {
        const source = agentParcelSource({ city: 'new_york', cadastreParcelIds: ['US-NYC-BBL-1001440001'] },
            [{ city: 'new_york', sourceId: 'us-nyc-dof-digital-tax-map' }]);
        expect(source.descriptor.id).toBe('us-nyc-dof-digital-tax-map');
        expect(agentParcelSource({ city: 'zagreb', cadastreParcelIds: ['HR-335061-2316/1'] })).toBeNull();
    });
    it('uses the selected cadastral source for the independent pre-mint check', async () => {
        const { args, deps, spies } = fixture();
        const baseLoad = deps.loadGround;
        deps.loadGround = async (...params) => ({ ...await baseLoad(...params), parcelSourceId: 'explicit-source' });
        await prepareAgentPublication(args, deps);
        expect(spies.checkBinding.mock.calls[0][3].parcelSourceId).toBe('explicit-source');
    });
    it('works with backend-only node_modules and no global Turf, as deployed', async () => {
        const resolve = Module._resolveFilename;
        Module._resolveFilename = function (request, parent, ...args) {
            if (request === '@turf/turf' && parent?.filename?.includes('/frontend/')) {
                throw new Error('Frontend node_modules is not installed in production');
            }
            return resolve.call(this, request, parent, ...args);
        };
        try {
            const { args, deps } = fixture();
            const publication = await prepareAgentPublication(args, deps);
            expect(publication.record.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        } finally { Module._resolveFilename = resolve; }
    });
    it('binds the actual building across both parcels and pins its exact authored record', async () => {
        const { args, deps, spies } = fixture();
        const publication = await prepareAgentPublication(args, deps);
        const record = publication.record;
        const metadata = spies.pinMetadata.mock.calls[0][0];
        const authored = metadata.properties.proposal;

        expect(record.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(record.binding.parcels.map(parcel => parcel.parcelId)).toEqual(['HR-1', 'HR-2']);
        expect(record.site).toEqual({ type: 'MultiPolygon', coordinates: [BUILDING.coordinates] });
        expect(record.cadastreSnapshot).toMatchObject({
            protocol: 'cadastre-snapshot/1', source: 'zagreb-cadastre-v1',
            capturedAt: '2026-10-11T09:30:00.000Z', regionHasCadastre: true,
            parcels: [
                { id: 'HR-1', sourceId: 'zagreb-cadastre-v1', sourceVersion: '2026-10-01', geometry: LEFT },
                { id: 'HR-2', sourceId: 'zagreb-cadastre-v1', sourceVersion: '2026-10-01', geometry: RIGHT }
            ]
        });
        for (const parcel of record.cadastreSnapshot.parcels) expect(parcel.geometryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(record.geometry.buildings[0].geometry).toEqual(BUILDING);
        expect(authored).toMatchObject({
            proposalId: 'agent-test-01', author: args.persona.wallet, lens: LENS,
            agent: { persona: 'builder-02', rationale: args.pick.rationale, run_id: args.runId, controller: 'algorithm' },
            cadastreParcelIds: ['HR-1', 'HR-2'], site: record.site, cadastreSnapshot: record.cadastreSnapshot
        });
        expect(authored.geometry).toEqual(record.geometry);
        expect(authored.site).toEqual(record.site);
        expect(authored.cadastreSnapshot).toEqual(record.cadastreSnapshot);
        expect(spies.checkBinding).toHaveBeenCalledWith(args.pool, record, ['HR-1', 'HR-2'], expect.objectContaining({ site: record.site, city: 'zagreb' }));
        expect(spies.render).toHaveBeenCalledOnce();
        expect(spies.pinImage).toHaveBeenCalledOnce();
        expect(publication).toMatchObject({ metadataUri: PINNED_METADATA, imageUri: PINNED_IMAGE.ipfsUri });
    });

    it('refuses binding/source failures before rendering or either pin operation', async () => {
        const cases = [
            ['binding refusal', { checkBinding: vi.fn(async () => ({ ok: false, error: 'binding rejected' })) }, /binding rejected/],
            ['incomplete binding coverage', { checkBinding: vi.fn(async () => ({ ok: true, binding: { coverage: 'partial' } })) }, /complete candidate footprint/],
            ['cadastral source failure', { loadGround: vi.fn(async () => { throw new Error('source unavailable'); }) }, /source unavailable/]
        ];
        for (const [label, overrides, error] of cases) {
            const { args, deps: baseDeps, spies: baseSpies } = fixture();
            const deps = { ...baseDeps, ...overrides };
            await expect(prepareAgentPublication(args, deps), label).rejects.toThrow(error);
            expect(baseSpies.render, label).not.toHaveBeenCalled();
            expect(baseSpies.pinImage, label).not.toHaveBeenCalled();
            expect(baseSpies.pinMetadata, label).not.toHaveBeenCalled();
        }
    });

    it('refuses metadata readback that differs from the prepared authored record', async () => {
        const { args, deps } = fixture();
        const publication = await prepareAgentPublication(args, deps);
        const changed = { ...publication.record, title: 'Changed after pinning' };
        await expect(verifyPublicationReadable(publication, {
            readMetadata: async () => ({ properties: chainRecord.metadataProperties(changed) })
        })).rejects.toThrow(/differs from the record prepared for minting/);
    });
});

const MINT = {
    chainId: 'solana-devnet',
    contractAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
    proposalPda: 'Fq6vQHmvTsvZzpYBbdmPKYQL2mVd6wDhLVv69q6rXmYz',
    metadataUri: PINNED_METADATA
};
const EXPECTED_REF = { chainType: 'solana', chainId: 'solana-devnet', contract: MINT.contractAddress, tokenId: MINT.proposalPda };
const EXPECTED_PROPOSAL_ID = `chain_${createHash('sha256').update(JSON.stringify(EXPECTED_REF)).digest('hex')}`;

describe('agent publication mirror', () => {
    it.each([201, 409])('sends only the chain location and accepts a verified canonical response (%s)', async status => {
        const fetchImpl = vi.fn(async () => ({ status, json: async () => ({ id: 61, proposalId: EXPECTED_PROPOSAL_ID }) }));
        await expect(mirrorAgentPublication({ apiBase: 'https://api.example/', mint: MINT, fetchImpl }))
            .resolves.toEqual({ id: 61, proposalId: EXPECTED_PROPOSAL_ID, status, method: 'chain-mirror' });
        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://api.example/proposals/mirror');
        expect(JSON.parse(init.body)).toEqual({ chainRef: EXPECTED_REF });
        expect(Object.keys(JSON.parse(init.body))).toEqual(['chainRef']);
    });

    it.each([
        ['missing proposal ID', { id: 61 }],
        ['different canonical proposal ID', { id: 61, proposalId: `chain_${'0'.repeat(64)}` }],
        ['explicit proof conflict', { id: 61, proposalId: EXPECTED_PROPOSAL_ID, code: 'chain-mirror-conflict' }]
    ])('does not treat a 409 %s as an idempotent success', async (_label, body) => {
        const fetchImpl = vi.fn(async () => ({ status: 409, json: async () => body }));
        await expect(mirrorAgentPublication({ apiBase: 'https://api.example', mint: MINT, fetchImpl }))
            .rejects.toThrow(/Chain mirror HTTP 409/);
    });

    it('does not mirror an earlier mint that used an HTTP metadata URI', async () => {
        const fetchImpl = vi.fn();
        await expect(mirrorAgentPublication({
            apiBase: 'https://api.example', mint: { ...MINT, metadataUri: 'https://api.example/proposals/6' }, fetchImpl
        })).rejects.toThrow(/no portable immutable metadata/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
