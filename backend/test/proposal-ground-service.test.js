import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');

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
    status: 'ready',
    complete: true,
    ids: ids.map(String),
    features: ids.map((id, index) => parcelFeature(id, index * 0.01)),
    absentIds: [],
    ...extra
});

function fixture(options = {}) {
    const root = options.root || {};
    const fetchParcelsByIds = options.fetchParcelsByIds || vi.fn(async ids => {
        return parcelResult(ids);
    });
    const fetchParcelsUnderGeometry = options.fetchParcelsUnderGeometry || vi.fn(async () => ({
        status: 'ready', features: [], absentIds: [], count: 0, queryMs: 1
    }));
    const acceptedFeatures = [];
    const onFeatures = options.onFeatures || vi.fn(async features => {
        acceptedFeatures.push(...features);
    });
    const service = createCadastralParcelRepository({
        root,
        onFeatures,
        convertFeatures: featureCollection => featureCollection,
        transport: {
            fetchByIds: fetchParcelsByIds,
            fetchUnderGeometry: fetchParcelsUnderGeometry
        },
        footprintOf: record => record.footprint || null,
        cadastreParcelIdsOf: record => record.cadastreParcelIds || [],
        coverageOf: options.coverageOf || (() => ({ ids: [], coverage: 0 }))
    });
    return { service, acceptedFeatures, onFeatures, fetchParcelsByIds, fetchParcelsUnderGeometry };
}

describe('CadastralParcelRepository', () => {
    it('serves loaded and known-missing ids from its cache after one transport request', async () => {
        const fetchParcelsByIds = vi.fn(async ids => {
            const found = ids.filter(id => id === 'HR-B');
            return parcelResult(found, { absentIds: ['HR-MISSING'] });
        });
        const { service, onFeatures } = fixture({ fetchParcelsByIds });
        await service.acceptFeatures([parcelFeature('HR-A')], { skipConversion: true });
        onFeatures.mockClear();

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
        const root = { parcelLayerById: new Map([['HR-A', { feature: parcelFeature('HR-A') }]]) };
        const { service, fetchParcelsByIds } = fixture({ root });

        await service.ensureIds(['HR-A']);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
    });

    it('serves retained facts without requesting them again and provisions every consumer', async () => {
        const { service, onFeatures, fetchParcelsByIds } = fixture();

        await service.ensureIds(['HR-A']);
        await service.ensureIds(['HR-A']);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(fetchParcelsByIds).toHaveBeenCalledWith(['HR-A'], expect.any(Object));
        expect(onFeatures).toHaveBeenCalledTimes(2);
        expect(service.get('HR-A')).toMatchObject({ properties: { parcelId: 'HR-A' } });
    });

    it('accepts identical facts idempotently, reprovisions them, and rejects conflicting geometry', async () => {
        const { service, onFeatures } = fixture();

        await service.acceptFeatures([parcelFeature('HR-A')], { skipConversion: true });
        await service.acceptFeatures([parcelFeature('HR-A')], { skipConversion: true });

        expect(onFeatures).toHaveBeenCalledTimes(2);
        expect(service.snapshot().featureCount).toBe(1);
        await expect(service.acceptFeatures([parcelFeature('HR-A', 1)], { skipConversion: true }))
            .rejects.toMatchObject({ code: 'cadastral-feature-conflict' });
    });

    it('owns retained cadastral geometry independently of transport and returned clones', async () => {
        const first = parcelFeature('HR-A', 0);
        const fetchParcelsByIds = vi.fn(async () => parcelResult(['HR-A'], { features: [first] }));
        const { service, onFeatures } = fixture({ fetchParcelsByIds });

        const result = await service.ensureIds(['HR-A']);
        first.geometry.coordinates[0][0][0] = 88;
        result.features[0].geometry.coordinates[0][0][0] = 99;
        await service.ensureIds(['HR-A']);

        expect(service.get('HR-A').geometry.coordinates[0][0][0]).toBe(16);
        expect(onFeatures).toHaveBeenCalledTimes(2);
        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
    });

    it('provisions one retained fact into each explicit fabric mutation without refetching', async () => {
        const { service, onFeatures, fetchParcelsByIds } = fixture();
        const firstTransaction = { id: 'fabric-one' };
        const secondTransaction = { id: 'fabric-two' };

        await service.ensureIds(['HR-A'], { mutation: firstTransaction });
        await service.ensureIds(['HR-A'], { mutation: secondTransaction });

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(onFeatures).toHaveBeenCalledTimes(2);
        expect(onFeatures.mock.calls.map(call => call[1].mutation)).toEqual([
            firstTransaction,
            secondTransaction
        ]);
    });

    it('provisions concurrent consumers independently while sharing one transport request', async () => {
        let release;
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            release = () => resolve(parcelResult(ids));
        }));
        const { service, onFeatures } = fixture({ fetchParcelsByIds });
        const firstTransaction = { id: 'fabric-one' };
        const secondTransaction = { id: 'fabric-two' };

        const first = service.ensureIds(['HR-A'], { mutation: firstTransaction });
        const second = service.ensureIds(['HR-A'], { mutation: secondTransaction });
        await Promise.resolve();
        release();
        await Promise.all([first, second]);

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(onFeatures).toHaveBeenCalledTimes(2);
        expect(new Set(onFeatures.mock.calls.map(call => call[1].mutation))).toEqual(
            new Set([firstTransaction, secondTransaction])
        );
    });

    it('retains immutable facts when provisioning fails and retries provisioning without refetching', async () => {
        const onFeatures = vi.fn()
            .mockRejectedValueOnce(new Error('fabric transaction rolled back'))
            .mockResolvedValueOnce(undefined);
        const { service, fetchParcelsByIds } = fixture({ onFeatures });

        await expect(service.ensureIds(['HR-A'], { mutation: { id: 'failed' } }))
            .rejects.toThrow('fabric transaction rolled back');
        await expect(service.ensureIds(['HR-A'], { mutation: { id: 'retry' } }))
            .resolves.toMatchObject({ foundIds: ['HR-A'], requestedIds: [] });

        expect(fetchParcelsByIds).toHaveBeenCalledOnce();
        expect(onFeatures).toHaveBeenCalledTimes(2);
        expect(service.get('HR-A')).toMatchObject({ properties: { parcelId: 'HR-A' } });
    });

    it('passes opaque ids verbatim to the cadastral authority instead of parsing their spelling', async () => {
        const { service, fetchParcelsByIds } = fixture();
        const opaqueIds = [
            'HR-330264-574#c2-jpa5wmngei2g-1',
            'HR-330264-576#p-2526rs9dqxs-1',
            'HR-330264-574#another-9'
        ];

        await expect(service.ensureIds(opaqueIds)).resolves.toMatchObject({ foundIds: opaqueIds });

        expect(fetchParcelsByIds).toHaveBeenCalledWith(opaqueIds, expect.any(Object));
    });

    it('joins overlapping in-flight id requests instead of fetching an id twice', async () => {
        const releases = [];
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            releases.push(() => {
                resolve(parcelResult(ids));
            });
        }));
        const { service } = fixture({ fetchParcelsByIds });

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
        const fetchParcelsByIds = vi.fn()
            .mockRejectedValueOnce(new Error('network down'))
            .mockImplementationOnce(async ids => parcelResult(ids));
        const { service } = fixture({ fetchParcelsByIds });

        await expect(service.ensureIds(['HR-A'])).rejects.toThrow('network down');
        await expect(service.ensureIds(['HR-A'])).resolves.toMatchObject({ missingIds: [] });

        expect(fetchParcelsByIds).toHaveBeenCalledTimes(2);
    });

    it('scopes positive and negative caches to the current city', async () => {
        let city = 'city-a';
        const fetchParcelsByIds = vi.fn(async ids => parcelResult([], { absentIds: ids.map(String) }));
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

    it('memoizes repository-backed footprint results and returns isolated clones', async () => {
        const transportFeature = parcelFeature('HR-C');
        const fetchParcelsUnderGeometry = vi.fn(async () => ({
            ids: ['HR-C'],
            features: [transportFeature],
            count: 1,
            coverage: 1
        }));
        const { service } = fixture({ fetchParcelsUnderGeometry });

        const first = await service.ensureFootprint(polygon(0), { parcelsOnly: false });
        first.result.features[0].geometry.coordinates[0][0][0] = 99;
        const second = await service.ensureFootprint(polygon(0), { parcelsOnly: false });

        expect(first.result).toMatchObject({ ids: ['HR-C'], count: 1, coverage: 1, queryMs: null });
        expect(second.result.features[0].geometry.coordinates[0][0][0]).toBe(16);
        expect(second.result).not.toBe(first.result);
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
        release({ status: 'ready', features: [], absentIds: [], count: 0 });
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
        let release;
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            release = () => {
                resolve(parcelResult(ids));
            };
        }));
        const fetchParcelsUnderGeometry = vi.fn(async () => parcelResult(['HR-A'], { count: 1 }));
        const { service } = fixture({
            fetchParcelsByIds,
            fetchParcelsUnderGeometry,
            coverageOf: (_footprint, stored) => stored.some(feature => feature.properties.parcelId === 'HR-A')
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
        let release;
        const fetchParcelsByIds = vi.fn(ids => new Promise(resolve => {
            release = () => {
                resolve(parcelResult(ids));
            };
        }));
        const fetchParcelsUnderGeometry = vi.fn(async () => parcelResult(['HR-A'], { count: 1 }));
        const { service } = fixture({
            fetchParcelsByIds,
            fetchParcelsUnderGeometry,
            coverageOf: (_footprint, stored) => stored.some(feature => feature.properties.parcelId === 'HR-A')
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
        let release;
        const fetchParcelsUnderGeometry = vi.fn(() => new Promise(resolve => {
            release = () => {
                resolve(parcelResult(['HR-A'], { count: 1 }));
            };
        }));
        const { service, fetchParcelsByIds } = fixture({ fetchParcelsUnderGeometry });

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

    it.each(consumerFiles)('%s requests ground through CadastralParcelRepository', absolutePath => {
        const source = readFileSync(absolutePath, 'utf8');
        expect(source).not.toMatch(rawTransportReference);
        expect(source).not.toMatch(directFootprintEndpoint);
    });

    it('keeps the raw transport private and policy-free', () => {
        const source = readFileSync(join(frontendJsRoot, 'parcels/fetch.js'), 'utf8');
        const serviceSource = readFileSync(join(frontendJsRoot, 'parcels/ground-service.js'), 'utf8');
        const idTransport = source.slice(
            source.indexOf('async function fetchByIds'),
            source.indexOf('function datasetToLatLng')
        );
        const footprintTransport = source.slice(
            source.indexOf('async function fetchUnderGeometry'),
            source.indexOf('async function fetchParcelData')
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
        expect(idTransport).toContain('features: Array.from(byId.values())');
        expect(footprintTransport).toContain('features: payload.features');
        expect(source).not.toContain('.acceptFeatures(');
        expect(source).not.toContain('parcelCache');
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
