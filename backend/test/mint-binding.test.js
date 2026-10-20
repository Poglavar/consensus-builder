// Local mint binding: derive the chain consent set and cadastral snapshot from loaded source geometry.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
// Browser pages expose Turf globally; plan-order's pure helper reads that same global in Node.
globalThis.turf = turf;
const mintBinding = require('../../frontend/js/proposals/mint-binding.js');
const box = (west, south, east, north) => ({
    type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const SITE = box(15.970, 45.800, 15.972, 45.801);
const LEFT = box(15.970, 45.800, 15.971, 45.801);
const RIGHT = box(15.971, 45.800, 15.972, 45.801);
const features = (overrides = {}) => [
    { id: 'HR-1', geometry: LEFT, properties: { parcelId: 'HR-1', ...overrides.left } },
    { id: 'HR-2', geometry: RIGHT, properties: { parcelId: 'HR-2', ...overrides.right } }
];
const proposal = (overrides = {}) => ({
    proposalId: 'proposal-a', city: 'zagreb', type: 'structure', goal: 'park',
    title: 'A small park', site: SITE, structureProposal: { geometry: SITE },
    cadastreParcelIds: [], ...overrides
});

afterEach(() => {
    delete globalThis.CityConfigManager;
});
afterAll(() => { delete globalThis.turf; });

describe('mint binding from cadastral source geometry', () => {
    it('includes both adjacent parcels covered by the site, even when only one was selected', async () => {
        const result = await mintBinding.buildRecord(proposal({ cadastreParcelIds: ['HR-1'] }), {
            parcels: features(), source: 'zagreb-source', turf
        });
        expect(result.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(result.binding.parcels.map(hit => hit.parcelId)).toEqual(['HR-1', 'HR-2']);
    });

    it('keeps a parcel act on exactly its declared parcels', async () => {
        const result = await mintBinding.buildRecord(proposal({
            goal: 'ownership-transfer', cadastreParcelIds: ['HR-1']
        }), { parcels: features(), source: 'zagreb-source', turf });
        expect(result.cadastreParcelIds).toEqual(['HR-1']);
        expect(result.binding.parcels.map(hit => hit.parcelId)).toEqual(['HR-1']);
        expect(result.binding.subject).toBe('declared-parcels');
        expect(result.cadastreSnapshot.parcels.map(parcel => parcel.id)).toEqual(['HR-1']);
    });

    it('carries only shared, explicit source provenance into a locally computed binding', async () => {
        const descriptor = { sourceId: 'ca-on-toronto', snapshotId: 'snapshot-7' };
        const sourced = await mintBinding.buildRecord(proposal(), {
            parcels: features({ left: { parcelSource: descriptor }, right: { parcelSource: descriptor } }),
            source: 'capture-label-only', turf
        });
        expect(sourced.binding.parcelSource).toEqual(descriptor);

        const unknown = await mintBinding.buildRecord(proposal(), { parcels: features(), source: 'ca-on-toronto', turf });
        expect(unknown.binding.parcelSource).toBeNull();
        const mixed = await mintBinding.buildRecord(proposal(), {
            parcels: features({ left: { parcelSource: descriptor }, right: { parcelSource: { sourceId: 'other-source', snapshotId: null } } }), turf
        });
        expect(mixed.binding.parcelSource).toBeNull();
    });

    it('keeps unavailable source revision/hash null and saves source geometry plus its computed hash', async () => {
        const result = await mintBinding.buildRecord(proposal(), {
            parcels: features(), source: 'zagreb-source', turf,
            now: () => new Date('2026-10-11T00:00:00Z')
        });
        const snapshot = result.cadastreSnapshot.parcels.find(parcel => parcel.id === 'HR-1');
        expect(result.cadastreSnapshot).toMatchObject({ protocol: 'cadastre-snapshot/1', source: 'zagreb-source', capturedAt: '2026-10-11T00:00:00.000Z' });
        expect(snapshot).toMatchObject({ sourceId: 'zagreb-source', sourceVersion: null, sourceGeometryHash: null, geometry: LEFT });
        expect(snapshot.geometryHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses a failed cadastral footprint read instead of minting invented open ground', async () => {
        const repository = {
            ensureFootprint: vi.fn(async () => { throw new Error('source unavailable'); })
        };
        const cityConfig = { parcels: { source: 'government', sourceId: 'zagreb-source' } };
        await expect(mintBinding.prepareForMint(proposal(), { cityConfig, repository, turf }))
            .rejects.toThrow('source unavailable');
        expect(repository.ensureFootprint).toHaveBeenCalledOnce();
    });

    it('allows an authored site-only proposal in a city with no cadastre', async () => {
        const result = await mintBinding.prepareForMint(proposal(), {
            cityConfig: { parcels: { source: 'none', sourceId: 'none' } }, turf,
            now: () => new Date('2026-10-11T00:00:00Z')
        });
        expect(result.cadastreParcelIds).toEqual([]);
        expect(result.binding).toMatchObject({ coverage: 'none', parcels: [] });
        expect(result.cadastreSnapshot).toMatchObject({ regionHasCadastre: false, source: 'none', parcels: [] });
    });

    it('builds corridor geometry in its local frame regardless of the active city configuration', () => {
        const road = {
            type: 'road', goal: 'road-track', title: 'Test corridor',
            roadProposal: { definition: { width: 12, points: [
                { lat: 45.8001, lng: 15.9701 }, { lat: 45.8004, lng: 15.9712 }, { lat: 45.8011, lng: 15.9716 }
            ], segments: [[
                { lat: 45.8001, lng: 15.9701 }, { lat: 45.8004, lng: 15.9712 }, { lat: 45.8011, lng: 15.9716 }
            ]] } }
        };
        globalThis.CityConfigManager = { getCityConfig: () => ({ id: 'zagreb', center: [15.97, 45.8] }) };
        const first = mintBinding.buildLand(road).roadProposal.definition;
        globalThis.CityConfigManager = { getCityConfig: () => ({ id: 'quito', center: [-78.5, -0.2] }) };
        const second = mintBinding.buildLand(road).roadProposal.definition;
        expect(second.polygon).toEqual(first.polygon);
        expect(second.constructionFrame).toEqual(first.constructionFrame);
        expect(second.constructionFrame.kind).toBe('local-tmerc');
    });

    it('removes old server preparation and signature fields before minting', async () => {
        const result = await mintBinding.buildRecord(proposal({
            preparation: { id: 'prep_x', digest: 'deadbeef', signature: 'server-signature' },
            preparedArtifact: { site: box(0, 0, 1, 1) }
        }), { parcels: features(), source: 'zagreb-source', turf });
        expect(result).not.toHaveProperty('preparation');
        expect(result).not.toHaveProperty('preparedArtifact');
    });
});
