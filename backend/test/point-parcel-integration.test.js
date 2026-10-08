import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { parcelSourceCatalog, withSourceConcurrency, withSourceCooldown } from '../parcels/sources.js';

const require = createRequire(import.meta.url);
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');
const { createController } = require('../../frontend/js/parcels/point-map.js');
const fetchTransportSource = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');

const descriptor = parcelSourceCatalog.sources.find(source => source.id === 'ge-msda-napr-registered-land-plots');
const cadCode = '01.16.06.023.021';
const parcelId = `GE-NAPR-${cadCode}`;
const point = [44.80665, 41.70893];
const wktShape = 'POLYGON ((44.80672966388622 41.708941444187076, 44.80666646292635 41.70899857722461, 44.80656614161029 41.70894133479246, 44.80655259169339 41.708933603691264, 44.806565920829 41.70891834915187, 44.80662768274834 41.70884766073413, 44.8067449407609 41.70891718488199, 44.80672132924812 41.70893659604853, 44.80672966388622 41.708941444187076))';
const fixtureFeature = {
    type: 'Feature',
    id: parcelId,
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [44.80672966388622, 41.708941444187076], [44.80666646292635, 41.70899857722461],
            [44.80656614161029, 41.70894133479246], [44.80655259169339, 41.708933603691264],
            [44.806565920829, 41.70891834915187], [44.80662768274834, 41.70884766073413],
            [44.8067449407609, 41.70891718488199], [44.80672132924812, 41.70893659604853],
            [44.80672966388622, 41.708941444187076]
        ]]
    },
    properties: {
        id: parcelId, parcelId, sourceId: descriptor.id, sourceParcelId: cadCode,
        parcelNumber: cadCode, sourceProperties: { cadCode }
    }
};

function application(fetchImpl) {
    const app = express();
    setupParcelSourcesRoute(app, { fetchImpl, sources: [descriptor] });
    return app;
}

function repository({ fetchPoint, fetchByIds = vi.fn(), onFeatures = vi.fn(async () => {}) }) {
    const service = createCadastralParcelRepository({
        root: { CityConfigManager: { getCurrentCityId: () => 'tbilisi' } },
        transport: { fetchPoint, fetchByIds, fetchBounds: vi.fn(), fetchUnderGeometry: vi.fn() },
        convertFeatures: collection => collection,
        boundsKeysOf: () => ['tbilisi:point-cell'],
        onFeatures
    });
    return { service, fetchByIds, onFeatures };
}

function readyPoint(features = [fixtureFeature]) {
    return { status: 'ready', complete: true, queryType: 'point', features, absentIds: [], returnsWGS84: true };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function bootPointTransport(fetchImpl) {
    const window = {
        fetch: fetchImpl,
        CityConfigManager: {
            getCityConfig: city => city === 'tbilisi' ? { parcels: {
                strategy: 'point', source: 'parcel-source', sourceId: descriptor.id
            } } : null
        },
        getBackendBase: () => 'https://api.example.test',
        getCurrentCityId: () => 'tbilisi',
        getCurrentDataSource: () => 'backend'
    };
    const context = vm.createContext({ window, fetch: fetchImpl, URL, URLSearchParams, console, setTimeout });
    vm.runInContext(fetchTransportSource, context);
    return window.__cadastralGroundTransport;
}

describe('point parcel lookup integration', () => {
    it('routes a Tbilisi point query through the configured MSDA adapter and returns verified geometry', async () => {
        const fetchImpl = vi.fn(async (url, options) => {
            expect(url).toBe(`${descriptor.endpoint}/search-by-xy`);
            expect(JSON.parse(options.body)).toEqual({ lrIds: [261415], x: point[0], y: point[1], zoom: 20 });
            return new Response(JSON.stringify({ naprTchParcel: { layerRecords: [{ cadCode, wktShape }] } }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        });
        const response = await request(application(fetchImpl))
            .get(`/parcel-sources/${descriptor.id}?point=${point.join(',')}`);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ complete: true, queryType: 'point', sourceId: descriptor.id, returnsWGS84: true });
        expect(response.body.features).toHaveLength(1);
        expect(response.body.features[0]).toMatchObject({
            id: parcelId, geometry: { type: 'Polygon' },
            properties: { parcelId, sourceId: descriptor.id, sourceParcelId: cadCode, parcelNumber: cadCode }
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('rejects invalid and mixed queries, and never reports point-only bounds or under requests as complete', async () => {
        const fetchImpl = vi.fn();
        const app = application(fetchImpl);
        const invalid = await request(app).get(`/parcel-sources/${descriptor.id}?point=44.8,91`);
        const mixed = await request(app).get(`/parcel-sources/${descriptor.id}?point=44.8,41.7&bbox=44,41,45,42`);
        const missing = await request(app).get(`/parcel-sources/${descriptor.id}`);
        const bounds = await request(app).get(`/parcel-sources/${descriptor.id}?bbox=44,41,45,42`);
        const under = await request(app).post(`/parcel-sources/${descriptor.id}/under`).send({
            srid: 4326, geometry: { type: 'Polygon', coordinates: [] }
        });

        expect(invalid.status).toBe(400);
        expect(mixed.status).toBe(400);
        expect(missing.status).toBe(400);
        expect(bounds.status).toBe(422);
        expect(under.status).toBe(422);
        for (const response of [invalid, mixed, missing, bounds, under]) {
            expect(response.body.complete).not.toBe(true);
            expect(response.body.features).toBeUndefined();
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('sends point lookups through the frontend transport and rejects an incomplete gateway reply', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
                complete: true, queryType: 'point', sourceId: descriptor.id, features: [fixtureFeature]
            }) })
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
                complete: false, queryType: 'point', sourceId: descriptor.id, features: []
            }) });
        const transport = bootPointTransport(fetchImpl);

        await expect(transport.fetchPoint(point, { city: 'tbilisi' })).resolves.toMatchObject({
            status: 'ready', complete: true, queryType: 'point', features: [fixtureFeature], absentIds: [], returnsWGS84: true
        });
        expect(fetchImpl.mock.calls[0][0]).toBe(
            `https://api.example.test/parcel-sources/${descriptor.id}?point=${point.join('%2C')}`
        );
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: 'no-store', headers: { Accept: 'application/json' } });
        await expect(transport.fetchPoint(point, { city: 'tbilisi' })).rejects.toThrow(/incomplete point response/);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('keeps point calls inside shared concurrency and cooldown wrappers', async () => {
        let now = 0;
        const pointGate = deferred();
        const upstreamFailure = Object.assign(new Error('provider paused'), {
            code: 'parcel-source-unavailable', retryAfterSeconds: 30
        });
        const raw = {
            queryBounds: vi.fn(async () => 'bounds'),
            queryIds: vi.fn(async () => 'ids'),
            queryGeometry: vi.fn(async () => 'geometry'),
            queryPoint: vi.fn().mockReturnValueOnce(pointGate.promise).mockRejectedValueOnce(upstreamFailure).mockResolvedValue('recovered')
        };
        const wrapped = withSourceCooldown(withSourceConcurrency(raw, { limit: 1 }), { now: () => now });

        const pendingPoint = wrapped.queryPoint(point);
        const queuedIds = wrapped.queryIds([parcelId]);
        await Promise.resolve();
        expect(raw.queryPoint).toHaveBeenCalledOnce();
        expect(raw.queryIds).not.toHaveBeenCalled();
        pointGate.resolve('point');
        await expect(pendingPoint).resolves.toBe('point');
        await expect(queuedIds).resolves.toBe('ids');
        await expect(wrapped.queryPoint(point)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        await expect(wrapped.queryPoint(point)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(raw.queryPoint).toHaveBeenCalledTimes(2);
        now = 30000;
        await expect(wrapped.queryPoint(point)).resolves.toBe('recovered');
        expect(raw.queryPoint).toHaveBeenCalledTimes(3);
    });

    it('retains exact point geometry without marking a bounds cell loaded, then serves ensureIds from cache', async () => {
        const fetchPoint = vi.fn(async () => readyPoint());
        const setup = repository({ fetchPoint });

        const identified = await setup.service.ensurePoint(point, { city: 'tbilisi', retainOnly: true });
        expect(identified).toMatchObject({ status: 'ready', queryType: 'point', ids: [parcelId] });
        expect(setup.service.snapshot()).toMatchObject({ featureCount: 1, boundsCount: 0, boundsKeys: [] });
        expect(setup.service.isPointLoaded(point[0], point[1], { city: 'tbilisi' })).toBe(false);

        const exact = await setup.service.ensureIds([parcelId], { city: 'tbilisi' });
        expect(exact).toMatchObject({ ids: [parcelId], foundIds: [parcelId], cachedIds: [parcelId], requestedIds: [] });
        expect(exact.features[0].geometry).toEqual(fixtureFeature.geometry);
        expect(setup.fetchByIds).not.toHaveBeenCalled();
        expect(fetchPoint).toHaveBeenCalledOnce();
    });

    it('does not cache a point miss and allows a later click to find the parcel', async () => {
        const fetchPoint = vi.fn().mockResolvedValueOnce(readyPoint([])).mockResolvedValueOnce(readyPoint());
        const setup = repository({ fetchPoint });

        await expect(setup.service.ensurePoint(point, { city: 'tbilisi', retainOnly: true }))
            .resolves.toMatchObject({ status: 'ready', queryType: 'point', ids: [], features: [] });
        expect(setup.service.snapshot()).toMatchObject({ featureCount: 0, loadedIds: new Set(), absentIds: new Set(), boundsCount: 0 });
        await expect(setup.service.ensurePoint(point, { city: 'tbilisi', retainOnly: true }))
            .resolves.toMatchObject({ ids: [parcelId], features: [{ properties: { parcelId } }] });
        expect(fetchPoint).toHaveBeenCalledTimes(2);
    });

    it('retries a failed point request without recording it as an absence', async () => {
        const fetchPoint = vi.fn().mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValueOnce(readyPoint());
        const setup = repository({ fetchPoint });

        await expect(setup.service.ensurePoint(point, { city: 'tbilisi', retainOnly: true })).rejects.toThrow('temporary outage');
        expect(setup.service.snapshot()).toMatchObject({ featureCount: 0, absentIds: new Set(), boundsCount: 0 });
        await expect(setup.service.ensurePoint(point, { city: 'tbilisi', retainOnly: true }))
            .resolves.toMatchObject({ ids: [parcelId] });
        expect(fetchPoint).toHaveBeenCalledTimes(2);
    });

    it('suppresses identify while interaction is disabled and ignores reversed or stale-city results', async () => {
        const disabledRepository = { ensurePoint: vi.fn(), ensureIds: vi.fn() };
        const disabled = createController({
            city: () => 'tbilisi', canIdentify: () => false, repository: disabledRepository,
            select: vi.fn(), status: vi.fn(), failed: vi.fn()
        });
        await expect(disabled.identify(point, {})).resolves.toBeNull();
        expect(disabledRepository.ensurePoint).not.toHaveBeenCalled();

        const first = deferred(), second = deferred();
        let city = 'tbilisi';
        const repositoryStub = { ensurePoint: vi.fn()
            .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), ensureIds: vi.fn(async () => {}) };
        const select = vi.fn();
        const controller = createController({ city: () => city, canIdentify: () => true, repository: repositoryStub,
            select, status: vi.fn(), failed: vi.fn() });
        const oldClick = controller.identify([1, 1], { key: 'old' });
        const newClick = controller.identify([2, 2], { key: 'new' });
        second.resolve({ ids: ['new-id'] });
        await newClick;
        first.resolve({ ids: ['old-id'] });
        await oldClick;
        expect(select).toHaveBeenCalledOnce();
        expect(select).toHaveBeenCalledWith('new-id', { key: 'new' });

        const cityResult = deferred();
        repositoryStub.ensurePoint.mockReturnValueOnce(cityResult.promise);
        const cityClick = controller.identify([3, 3], { key: 'city-change' });
        city = 'batumi';
        cityResult.resolve({ ids: ['tbilisi-id'] });
        await cityClick;
        expect(repositoryStub.ensureIds).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledTimes(1);
    });

    it('integrates cached point facts through ensureIds before selecting the parcel', async () => {
        const order = [];
        const setup = repository({
            fetchPoint: vi.fn(async () => readyPoint()),
            onFeatures: vi.fn(async features => { order.push(['integrated', features.map(feature => feature.properties.parcelId)]); })
        });
        const controller = createController({
            city: () => 'tbilisi', canIdentify: () => true, repository: setup.service,
            status: vi.fn(), failed: vi.fn(), select: id => order.push(['selected', id])
        });

        await controller.identify(point, { originalEvent: { type: 'click' } });
        expect(setup.service.snapshot().loadedIds).toEqual(new Set([parcelId]));
        expect(setup.fetchByIds).not.toHaveBeenCalled();
        expect(order).toEqual([['integrated', [parcelId]], ['selected', parcelId]]);
    });
});
