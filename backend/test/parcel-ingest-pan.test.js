// Parcel ingestion is a domain write, not a Leaflet operation. The presenter owns redraw
// coalescing when the resulting fabric revision commits.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/ingest.js', import.meta.url), 'utf8');

const parcel = (id, properties = {}) => ({
    type: 'Feature',
    properties: { parcelId: id, ...properties },
    geometry: { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]] }
});

function loadIngest(overrides = {}) {
    const calls = [];
    const repository = {
        acceptFeatures: vi.fn(async (features, options) => {
            calls.push(['accept', features, options]);
            return features.map(feature => feature.properties.parcelId);
        })
    };
    const context = {
        console,
        performance,
        Map,
        Set,
        Promise,
        CadastralParcelRepository: repository,
        convertGeoJSON: vi.fn(collection => collection),
        ...overrides
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return { context, repository, calls };
}

describe('parcel ingest boundary', () => {
    it('delegates a declared cadastral batch to the authoritative repository', async () => {
        const { context, repository, calls } = loadIngest();
        const features = [parcel('opaque-one'), parcel('opaque-two')];
        const result = await context.ingestCadastralParcelFeatures(features, { skipConversion: true });

        expect(Array.from(result)).toEqual(['opaque-one', 'opaque-two']);
        expect(repository.acceptFeatures).toHaveBeenCalledOnce();
        expect(calls[0][0]).toBe('accept');
        expect(calls[0][1]).toBe(features);
        expect(calls[0][2]).toEqual({ skipConversion: true });
    });

    it('hands an enclosing mutation token to repository provisioning', async () => {
        const { context, repository } = loadIngest();
        await context.ingestCadastralParcelFeatures([parcel('opaque')], {
            skipConversion: true,
            transaction: 'outer-token',
            city: 'sibenik'
        });

        expect(repository.acceptFeatures.mock.calls[0][1]).toEqual({
            city: 'sibenik',
            transaction: 'outer-token',
            skipConversion: true
        });
    });

    it('does not convert, classify or otherwise interpret repository input itself', async () => {
        const convertGeoJSON = vi.fn();
        const feature = parcel('opaque#still-cadastral');
        const { context, repository } = loadIngest({ convertGeoJSON });

        await context.ingestCadastralParcelFeatures([feature]);

        expect(convertGeoJSON).not.toHaveBeenCalled();
        expect(repository.acceptFeatures.mock.calls[0][0][0]).toBe(feature);
        expect(repository.acceptFeatures.mock.calls[0][1]).toEqual({ skipConversion: false });
    });

    it('fails closed when the authoritative repository is unavailable', async () => {
        const { context } = loadIngest({ CadastralParcelRepository: null });
        await expect(context.ingestCadastralParcelFeatures([parcel('HR-A')], { skipConversion: true }))
            .rejects.toThrow('Cadastral parcel repository is unavailable');
    });
});

describe('the shared presenter canvas', () => {
    it('coalesces redraw requests while a fabric revision is swapped', () => {
        const log = [];
        class Canvas {
            constructor() { this._map = {}; }
            _requestRedraw() { log.push('redraw-request'); }
            _extendRedrawBounds() { log.push('extend-bounds'); }
            _draw() { log.push('draw'); }
            _redraw() { log.push('redraw'); }
        }
        Canvas.extend = overrides => {
            class Extended extends Canvas { }
            Object.assign(Extended.prototype, overrides);
            return Extended;
        };
        const { context } = loadIngest({
            L: {
                Canvas,
                canvas: () => new Canvas(),
                Util: { requestAnimFrame: fn => { log.push('raf'); fn(); return 1; } }
            }
        });
        const renderer = context.parcelCanvasRenderer();

        renderer.holdRedraws();
        renderer._requestRedraw({});
        renderer._requestRedraw({});
        renderer.releaseRedraws();

        expect(log.filter(entry => entry === 'extend-bounds')).toHaveLength(2);
        expect(log.filter(entry => entry === 'redraw-request')).toHaveLength(0);
        expect(log.filter(entry => entry === 'raf')).toHaveLength(1);
        expect(context.__parcelCanvasStats.redrawsCoalesced).toBe(2);
    });
});

describe('the derivation breathes on the clock', () => {
    const manager = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
    const body = manager.slice(
        manager.indexOf('async _deriveCorridorFabricBody(options = {}) {'),
        manager.indexOf('const undecided = new Set(')
    );

    it('yields when 12 ms have passed, not every Nth item', () => {
        expect(body).toContain('const breatheIfDue = async () => {');
        expect(body).toContain('>= 12');
        expect(body).not.toContain('await breathe();\n        }');
    });

    it('clips one parcel per step, so the clock is consulted between clips', () => {
        expect(body).toContain('A.fabricOver(parcels.slice(i, i + 1), takes, hitsById)');
    });

    it('hands precomputed intersections to the clip loop', () => {
        expect(body).toContain('A.takeHitsOn(entry.feature, relevantTakes)');
        expect(body).not.toContain('A.takesOverlapping(');
        expect(body).toContain('hitsById.set(id, A.takeHitsOn(entry.feature, relevantTakes))');
    });
});
