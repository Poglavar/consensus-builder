import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { createCadastralGroundService } = require('../../frontend/js/parcels/ground-service.js');

const polygon = offset => ({
    type: 'Feature',
    properties: {},
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [16 + offset, 46],
            [16.001 + offset, 46],
            [16.001 + offset, 46.001],
            [16 + offset, 46.001],
            [16 + offset, 46]
        ]]
    }
});

const parcelFeature = (id, offset = 0) => ({
    ...polygon(offset),
    properties: { parcelId: String(id) }
});

const parcelResult = (ids, extra = {}) => ({
    ids: ids.map(String),
    features: ids.map((id, index) => parcelFeature(id, index * 0.01)),
    ...extra
});

function fixture(options = {}) {
    const loaded = options.loaded instanceof Set ? options.loaded : new Set(options.loaded || []);
    const presentedFeatures = options.presentedFeatures instanceof Map
        ? options.presentedFeatures
        : new Map(Array.from(loaded, id => [String(id), parcelFeature(id)]));
    const root = options.root || {};
    const fetchParcelsByIds = options.fetchParcelsByIds || vi.fn(async ids => {
        const features = ids.map((id, index) => parcelFeature(id, index * 0.01));
        return { ids, features };
    });
    const fetchParcelsUnderGeometry = options.fetchParcelsUnderGeometry || vi.fn(async () => ({
        ids: [], count: 0, queryMs: 1
    }));
    const ingestFeatures = options.ingestFeatures || vi.fn(async features => {
        features.forEach(feature => {
            const id = String(feature?.properties?.parcelId || '');
            if (!id) return;
            loaded.add(id);
            presentedFeatures.set(id, feature);
        });
        return features.map(feature => ({ feature }));
    });
    const service = createCadastralGroundService({
        root,
        resolveParcelLayerById: id => {
            const key = String(id);
            if (!loaded.has(key)) return null;
            return { id: key, feature: presentedFeatures.get(key) || parcelFeature(key) };
        },
        ingestFeatures,
        convertFeatures: featureCollection => featureCollection,
        transport: {
            fetchByIds: fetchParcelsByIds,
            fetchUnderGeometry: fetchParcelsUnderGeometry
        },
        footprintOf: record => record.footprint || null,
        baseParcelIdsOf: record => record.cadastreParcelIds || [],
        loadedCoverageOf: options.loadedCoverageOf || (() => ({ ids: [], coverage: 0 }))
    });
    return { service, loaded, presentedFeatures, ingestFeatures, fetchParcelsByIds, fetchParcelsUnderGeometry };
}

describe('CadastralGroundService', () => {
    it('serves loaded and known-missing ids from its cache after one transport request', async () => {
        const loaded = new Set();
        const fetchParcelsByIds = vi.fn(async ids => {
            const found = ids.filter(id => id === 'HR-B');
            return parcelResult(found);
        });
        const { service, ingestFeatures } = fixture({ loaded, fetchParcelsByIds });
        await service.acceptFeatures([parcelFeature('HR-A')], { skipConversion: true });
        ingestFeatures.mockClear();

        const first = await service.ensureIds(['HR-A', 'HR-B', 'HR-MISSING']);
        const second = await service.ensureIds(['HR-A', 'HR-B', 'HR-MISSING']);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsByIds.mock.calls[0][0]).toEqual(['HR-B', 'HR-MISSING']);
        expect(first.missingIds).toEqual(['HR-MISSING']);
        expect(second.requestedIds).toEqual([]);
        expect(second.missingIds).toEqual(['HR-MISSING']);
    });

    it('does not let a consumer bypass the ground cache', async () => {
        const { service, fetchParcelsByIds } = fixture();

        await service.ensureIds(['HR-A']);
        await service.ensureIds(['HR-A'], { forceRefresh: true });

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
    });

    it('never treats a Leaflet layer as cadastral cache data', async () => {
        const loaded = new Set(['HR-A']);
        const { service, fetchParcelsByIds } = fixture({ loaded });

        await service.ensureIds(['HR-A']);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
    });

    it('recreates a removed registry layer from cached geometry without another server request', async () => {
        const loaded = new Set();
        const { service, presentedFeatures, ingestFeatures, fetchParcelsByIds } = fixture({ loaded });

        await service.ensureIds(['HR-A']);
        loaded.delete('HR-A');
        presentedFeatures.delete('HR-A');
        await service.ensureIds(['HR-A']);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsByIds).toHaveBeenCalledWith(['HR-A'], expect.any(Object));
        expect(ingestFeatures).toHaveBeenCalledTimes(2);
        expect(loaded.has('HR-A')).toBe(true);
    });

    it('does not send already-materialized viewport ground through the renderer again', async () => {
        const { service, ingestFeatures } = fixture();

        await service.acceptFeatures([parcelFeature('HR-A')], { skipConversion: true });
        await service.acceptFeatures([parcelFeature('HR-A', 1)], { skipConversion: true });

        expect(ingestFeatures).toHaveBeenCalledOnce();
        expect(service.snapshot().featureCount).toBe(1);
    });

    it('owns retained cadastral geometry independently of transport and map-layer mutations', async () => {
        const loaded = new Set();
        const first = parcelFeature('HR-A', 0);
        const fetchParcelsByIds = vi.fn(async () => ({ ids: ['HR-A'], features: [first] }));
        const { service, presentedFeatures, ingestFeatures } = fixture({ loaded, fetchParcelsByIds });

        await service.ensureIds(['HR-A']);
        first.geometry.coordinates[0][0][0] = 88;
        presentedFeatures.get('HR-A').geometry.coordinates[0][0][0] = 99;
        loaded.delete('HR-A');
        presentedFeatures.delete('HR-A');
        await service.ensureIds(['HR-A']);

        const restored = ingestFeatures.mock.calls.at(-1)[0][0];
        expect(restored.geometry.coordinates[0][0][0]).toBe(16);
        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
    });

    it('flattens generated parcel ids before they reach the cadastral transport', async () => {
        const { service, fetchParcelsByIds } = fixture();

        const result = await service.ensureIds([
            'HR-330264-574#c2-jpa5wmngei2g-1',
            'HR-330264-576#p-2526rs9dqxs-1',
            'HR-330264-574#another-9'
        ]);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsByIds.mock.calls[0][0]).toEqual([
            'HR-330264-574',
            'HR-330264-576'
        ]);
        expect(result.ids).toEqual(['HR-330264-574', 'HR-330264-576']);
    });

    it('joins overlapping in-flight id requests instead of fetching an id twice', async () => {
        const loaded = new Set();
        const releases = [];
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            releases.push(() => {
                ids.forEach(id => loaded.add(id));
                resolve(parcelResult(ids));
            });
        }));
        const { service } = fixture({ loaded, fetchParcelsByIds });

        const first = service.ensureIds(['HR-A', 'HR-B']);
        const second = service.ensureIds(['HR-B', 'HR-C']);
        await Promise.resolve();

        expect(fetchParcelsByIds).toHaveBeenCalledTimes(2);
        expect(fetchParcelsByIds.mock.calls.map(call => call[0])).toEqual([
            ['HR-A', 'HR-B'],
            ['HR-C']
        ]);
        releases.forEach(release => release());
        await Promise.all([first, second]);
    });

    it('does not cache a transport failure as missing ground', async () => {
        const loaded = new Set();
        const fetchParcelsByIds = vi.fn()
            .mockRejectedValueOnce(new Error('network down'))
            .mockImplementationOnce(async ids => {
                ids.forEach(id => loaded.add(id));
                return parcelResult(ids);
            });
        const { service } = fixture({ loaded, fetchParcelsByIds });

        await expect(service.ensureIds(['HR-A'])).rejects.toThrow('network down');
        await expect(service.ensureIds(['HR-A'])).resolves.toMatchObject({ missingIds: [] });

        expect(fetchParcelsByIds).toHaveBeenCalledTimes(2);
    });

    it('scopes positive and negative caches to the current city', async () => {
        let city = 'city-a';
        const fetchParcelsByIds = vi.fn(async () => ({ ids: [] }));
        const root = { CityConfigManager: { getCurrentCityId: () => city } };
        const { service } = fixture({ root, fetchParcelsByIds });

        await service.ensureIds(['same-local-id']);
        await service.ensureIds(['same-local-id']);
        city = 'city-b';
        await service.ensureIds(['same-local-id']);

        expect(fetchParcelsByIds).toHaveBeenCalledTimes(2);
    });

    it('uses a corridor\'s flat cadastral ids without a second footprint fetch', async () => {
        const { service, fetchParcelsByIds, fetchParcelsUnderGeometry } = fixture();
        const road = {
            proposalId: 'road-1',
            goal: 'road-track',
            cadastreParcelIds: ['HR-A', 'HR-B'],
            footprint: polygon(0),
            roadProposal: { definition: {} }
        };

        await service.ensureProposalGround([road], { purpose: 'application' });
        await service.ensureProposalGround([road], { purpose: 'application' });

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsUnderGeometry).not.toHaveBeenCalled();
    });

    it('uses every applied proposal\'s flat cadastral ids without a second footprint fetch', async () => {
        const { service, fetchParcelsByIds, fetchParcelsUnderGeometry } = fixture();
        const park = {
            proposalId: 'park-1',
            goal: 'park',
            cadastreParcelIds: ['HR-A', 'HR-B'],
            footprint: polygon(0)
        };

        await service.ensureProposalGround([park], { purpose: 'application' });
        await service.ensureProposalGround([park], { purpose: 'application' });

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsUnderGeometry).not.toHaveBeenCalled();
    });

    it('uses a footprint—not declared ids—when publishing the cadastral stamp', async () => {
        const { service, fetchParcelsByIds, fetchParcelsUnderGeometry } = fixture();
        const park = {
            proposalId: 'park-1',
            goal: 'park',
            cadastreParcelIds: ['HR-STALE'],
            footprint: polygon(0)
        };

        await service.ensureProposalGround([park], { purpose: 'publish' });

        expect(fetchParcelsByIds).not.toHaveBeenCalled();
        expect(fetchParcelsUnderGeometry).toHaveBeenCalledOnce();
    });

    it('fetches incomplete formation ground once and then serves that footprint from cache', async () => {
        const fetchParcelsUnderGeometry = vi.fn(async () => parcelResult(['HR-C'], { count: 1, queryMs: 2 }));
        const { service } = fixture({ fetchParcelsUnderGeometry });
        const building = {
            proposalId: 'building-1',
            goal: 'building',
            cadastreParcelIds: [],
            footprint: polygon(0)
        };

        await service.ensureProposalGround([building]);
        await service.ensureProposalGround([building]);

        expect(fetchParcelsUnderGeometry).toHaveBeenCalledOnce();
    });

    it('memoizes footprint metadata without retaining or exposing transport feature arrays', async () => {
        const transportFeature = parcelFeature('HR-C');
        const fetchParcelsUnderGeometry = vi.fn(async () => ({
            ids: ['HR-C'],
            features: [transportFeature],
            count: 1,
            coverage: 1
        }));
        const { service } = fixture({ fetchParcelsUnderGeometry });

        const first = await service.ensureFootprint(polygon(0), { parcelsOnly: false });
        const second = await service.ensureFootprint(polygon(0), { parcelsOnly: false });

        expect(first.result).toEqual({ ids: ['HR-C'], count: 1, coverage: 1, queryMs: null });
        expect(first.result).not.toHaveProperty('features');
        expect(Object.isFrozen(first.result)).toBe(true);
        expect(Object.isFrozen(first.result.ids)).toBe(true);
        expect(second.result).toBe(first.result);
        expect(fetchParcelsUnderGeometry).toHaveBeenCalledOnce();
    });

    it('joins concurrent requests for the same footprint', async () => {
        let release;
        const fetchParcelsUnderGeometry = vi.fn(() => new Promise(resolve => { release = resolve; }));
        const { service } = fixture({ fetchParcelsUnderGeometry });
        const building = { proposalId: 'building-1', goal: 'building', footprint: polygon(0) };

        const first = service.ensureProposalGround([building]);
        const second = service.ensureProposalGround([building]);
        await new Promise(resolve => setImmediate(resolve));

        expect(fetchParcelsUnderGeometry).toHaveBeenCalledOnce();
        release({ ids: [], count: 0 });
        await Promise.all([first, second]);
    });

    it('coalesces identical footprints within one proposal batch', async () => {
        const fetchParcelsUnderGeometry = vi.fn(async () => parcelResult(['HR-A'], { count: 1 }));
        const { service } = fixture({ fetchParcelsUnderGeometry });

        const result = await service.ensureProposalGround([
            { proposalId: 'one', footprint: polygon(0) },
            { proposalId: 'two', footprint: polygon(0) }
        ]);

        expect(fetchParcelsUnderGeometry).toHaveBeenCalledOnce();
        expect(fetchParcelsUnderGeometry.mock.calls[0][0].coordinates).toHaveLength(1);
        expect(result.loadedMembers).toBe(2);
    });

    it('waits for an in-flight id load before deciding whether a footprint needs the server', async () => {
        const loaded = new Set();
        let release;
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            release = () => {
                ids.forEach(id => loaded.add(id));
                resolve(parcelResult(ids));
            };
        }));
        const fetchParcelsUnderGeometry = vi.fn(async () => parcelResult(['HR-A'], { count: 1 }));
        const { service } = fixture({
            loaded,
            fetchParcelsByIds,
            fetchParcelsUnderGeometry,
            loadedCoverageOf: () => loaded.has('HR-A')
                ? { ids: ['HR-A'], coverage: 1 }
                : { ids: [], coverage: 0 }
        });

        const ids = service.ensureIds(['HR-A']);
        const footprint = service.ensureFootprint(polygon(0));
        await Promise.resolve();
        release();
        await Promise.all([ids, footprint]);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsUnderGeometry).not.toHaveBeenCalled();
    });

    it('also joins an in-flight id load for proposal-footprint fallback', async () => {
        const loaded = new Set();
        let release;
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            release = () => {
                ids.forEach(id => loaded.add(id));
                resolve(parcelResult(ids));
            };
        }));
        const fetchParcelsUnderGeometry = vi.fn(async () => parcelResult(['HR-A'], { count: 1 }));
        const { service } = fixture({
            loaded,
            fetchParcelsByIds,
            fetchParcelsUnderGeometry,
            loadedCoverageOf: () => loaded.has('HR-A')
                ? { ids: ['HR-A'], coverage: 1 }
                : { ids: [], coverage: 0 }
        });

        const ids = service.ensureIds(['HR-A']);
        const proposal = service.ensureProposalGround([{
            proposalId: 'legacy-building',
            footprint: polygon(0)
        }]);
        await Promise.resolve();
        release();
        await Promise.all([ids, proposal]);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsUnderGeometry).not.toHaveBeenCalled();
    });

    it('waits for an in-flight footprint load before deciding whether ids need the server', async () => {
        const loaded = new Set();
        let release;
        const fetchParcelsUnderGeometry = vi.fn(() => new Promise(resolve => {
            release = () => {
                loaded.add('HR-A');
                resolve(parcelResult(['HR-A'], { count: 1 }));
            };
        }));
        const { service, fetchParcelsByIds } = fixture({ loaded, fetchParcelsUnderGeometry });

        const footprint = service.ensureFootprint(polygon(0));
        await Promise.resolve();
        const ids = service.ensureIds(['HR-A']);
        release();
        await Promise.all([footprint, ids]);

        expect(fetchParcelsUnderGeometry).toHaveBeenCalledOnce();
        expect(fetchParcelsByIds).not.toHaveBeenCalled();
    });

    it('emits factual cache, load, and ready phases without exposing transport decisions to callers', async () => {
        const { service } = fixture();
        const phases = [];
        await service.ensureProposalGround([{
            proposalId: 'road-1',
            goal: 'road-track',
            cadastreParcelIds: ['HR-A'],
            footprint: polygon(0),
            roadProposal: { definition: {} }
        }], { onProgress: event => phases.push(event.phase) });

        expect(phases).toEqual(expect.arrayContaining([
            'ground-check',
            'ground-check-ids',
            'ground-load-ids',
            'ground-ids-ready',
            'ground-ready'
        ]));
    });
});

describe('the ground service is the only parcel transport consumer', () => {
    const frontendJsRoot = fileURLToPath(new URL('../../frontend/js', import.meta.url));
    const frontendRoot = fileURLToPath(new URL('../../frontend', import.meta.url));
    const excluded = new Set(['parcels/fetch.js', 'parcels/ground-service.js']);
    const walk = directory => readdirSync(directory).flatMap(name => {
        const absolute = join(directory, name);
        return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    });
    const consumerFiles = walk(frontendJsRoot)
        .filter(path => path.endsWith('.js'))
        .filter(path => !excluded.has(relative(frontendJsRoot, path)));
    const rawTransportReference = /\b(?:__cadastralGroundTransport|fetchSingleParcelById|fetchParcelsByIds|fetchParcelsUnderGeometry|fetchParcelsForIds|fetchParcelFeaturesByIds|requestParcelBatchForCurrentCity|requestParcelBatchFrom[A-Za-z]+|ensureParentParcelsLoaded|ensureParentParcelsFetched)/;
    const directFootprintEndpoint = /fetch\s*\(\s*`[^`]*\/parcels\/under/;

    it.each(consumerFiles)('%s requests ground through CadastralGroundService', absolutePath => {
        const source = readFileSync(absolutePath, 'utf8');
        expect(source).not.toMatch(rawTransportReference);
        expect(source).not.toMatch(directFootprintEndpoint);
    });

    it('keeps the raw transport private and policy-free', () => {
        const source = readFileSync(join(frontendJsRoot, 'parcels/fetch.js'), 'utf8');
        const serviceSource = readFileSync(join(frontendJsRoot, 'parcels/ground-service.js'), 'utf8');
        const idTransport = source.slice(
            source.indexOf('async function fetchParcelsByIds'),
            source.indexOf('async function fetchParcelFeaturesByIds')
        );
        const footprintTransport = source.slice(
            source.indexOf('async function fetchParcelsUnderGeometry'),
            source.indexOf('global.fetchParcelData = fetchParcelData')
        );
        expect(source).toContain('global.__cadastralGroundTransport = Object.freeze({');
        expect(serviceSource).toContain('delete global.__cadastralGroundTransport');
        expect(source).not.toMatch(/global\.(?:fetchParcelsByIds|fetchParcelsUnderGeometry|fetchParcelFeaturesByIds)\s*=/);
        expect(source).not.toContain('options.forceRefresh');
        expect(serviceSource).not.toContain('ParcelsState');
        expect(serviceSource).not.toContain('parcelCache');
        expect(serviceSource).not.toContain('layer.feature');
        expect(serviceSource).not.toContain('__cadastreAncestry');
        expect(idTransport).not.toContain('ingestParcelFeatures(');
        expect(idTransport).not.toContain('resolveParcelLayerById');
        expect(footprintTransport).not.toContain('ingestParcelFeatures(');
        expect(footprintTransport).not.toContain('resolveParcelLayerById');
        expect(idTransport).toContain('features: rawFeatures');
        expect(footprintTransport).toContain('features,');
        expect(source).toContain('await ground.acceptFeatures(allFeatures');
        expect(source).toContain('cache.grid.set(cell, {');
        expect(source).not.toContain("cache.grid.set(cell, { type: 'FeatureCollection'");
    });

    it('captures the private transport before any feature consumer loads', () => {
        const html = readFileSync(join(frontendRoot, 'index.html'), 'utf8');
        const fetchIndex = html.indexOf("'js/parcels/fetch.js'");
        const serviceIndex = html.indexOf("'js/parcels/ground-service.js'");
        const managerIndex = html.indexOf("'js/proposal-manager.js'");
        expect(fetchIndex).toBeGreaterThanOrEqual(0);
        expect(serviceIndex).toBeGreaterThan(fetchIndex);
        expect(managerIndex).toBeGreaterThan(serviceIndex);
    });

    it('does not use viewport fetching as a proposal-ground loader', () => {
        ['proposals/sharing-routes.js', 'proposals/dialog-share.js'].forEach(relativePath => {
            const source = readFileSync(join(frontendJsRoot, relativePath), 'utf8');
            expect(source).not.toMatch(/\bfetchParcelData\s*\(/);
        });
    });
});
