// The renderer module has no cadastral write API. The presenter owns redraw coalescing when a
// ground-service-backed fabric revision commits.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/ingest.js', import.meta.url), 'utf8');

function loadIngest(overrides = {}) {
    const context = {
        console,
        performance,
        Map,
        Set,
        Promise,
        ...overrides
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return { context };
}

describe('parcel renderer boundary', () => {
    it('does not expose a second cadastral ingestion path', () => {
        const { context } = loadIngest();
        expect(context.ingestCadastralParcelFeatures).toBeUndefined();
        expect(context.normalizeFeatureParcelId).toBeUndefined();
        expect(source).not.toContain('CadastralParcelRepository');
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
