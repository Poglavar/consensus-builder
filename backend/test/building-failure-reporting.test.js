// A rejected backend query must retain its HTTP status through the actual map request/banner path.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const client = require('../../frontend/js/building-source-client.js');
const settings = require('../../frontend/js/parcel-source-settings.js');
const source = readFileSync(new URL('../../frontend/js/map-core.js', import.meta.url), 'utf8');
const functions = new Map(parse(source, { sourceType: 'script' }).program.body
    .filter(node => node.type === 'FunctionDeclaration')
    .map(node => [node.id.name, source.slice(node.start, node.end)]));
const bounds = {
    getWest: () => 2, getSouth: () => 1, getEast: () => 2.01, getNorth: () => 1.01,
    getSouthWest: () => ({ lng: 2, lat: 1 }), getNorthEast: () => ({ lng: 2.01, lat: 1.01 })
};

function harness(status) {
    const reportFailure = vi.fn();
    const fetch = vi.fn(async () => Response.json({ error: 'Query rejected' }, { status }));
    const window = {
        fetch, getBackendBase: () => 'https://api.example',
        CityConfigManager: { getCurrentCityConfig: () => ({ buildings: { source: 'osm' } }) },
        ParcelSourceSettings: { ...settings, reportFailure }
    };
    window.BuildingSourceClient = { request: (path, body) => client.request(path, body, { global: window }) };
    const context = {
        window, fetch, console: { warn: vi.fn(), error: vi.fn() },
        buildingsRetryAt: 0, osmBuildingsRetryAt: 0,
        hasFootprintProvider: () => true, showFetchedOsmBuildingLayer: vi.fn()
    };
    vm.createContext(context);
    vm.runInContext(['fetchBuildings', 'loadProviderFootprints', 'loadGdiFootprints',
        'fetchOsmBuildings', 'reportBuildingsUnavailable'].map(name => functions.get(name)).join('\n'), context);
    return { context, fetch, reportFailure };
}

describe('building request failure reporting', () => {
    it('reports a backend POST rejection rather than claiming the configured OSM server is busy', async () => {
        const h = harness(405);
        await h.context.fetchBuildings(bounds);
        expect(h.fetch).toHaveBeenCalledWith('https://api.example/buildings/footprints', expect.objectContaining({ method: 'POST' }));
        expect(h.reportFailure).toHaveBeenCalledWith(h.context.window,
            expect.stringContaining('Our server could not complete the building-data request (HTTP 405).'),
            'building', expect.any(Function));
        expect(h.reportFailure.mock.calls[0][1]).not.toMatch(/busy|rate.limit/i);
    });

    it('retains an OSM reference HTTP failure and retry delay without inferring rate limiting', async () => {
        const h = harness(503);
        await h.context.fetchOsmBuildings(bounds);
        expect(h.reportFailure.mock.calls[0][1]).toContain('HTTP 503');
        expect(h.reportFailure.mock.calls[0][1]).toContain('Try again in about 1 min');
        expect(h.reportFailure.mock.calls[0][1]).not.toMatch(/busy|rate.limit/i);
        expect(h.context.osmBuildingsRetryAt).toBeGreaterThan(Date.now());
    });

    it('retains the surveyed-building HTTP status for the shared banner', async () => {
        const h = harness(502);
        await expect(h.context.loadGdiFootprints({ url: 'https://api.example/buildings' }))
            .rejects.toMatchObject({ status: 502 });
    });
});
