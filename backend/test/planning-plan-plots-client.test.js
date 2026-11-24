import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plots = require('../../frontend/js/planning/plan-plots.js');
const scene = require('../../frontend/js/planning/scene.js');

const feature = (id, coordinates, properties = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coordinates] }, properties: { parcelId: id, ...properties } });
const square = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];

describe('plan plot client contract', () => {
    it('keeps nearby multipart cover, excludes distant pieces, and labels cadastral parts', () => {
        const near = feature('plot#1', square(0, 0, .001, .001), { readjustmentPiece: { role: 'plot' }, cadastreParcelIds: ['lot-1'] });
        const part = feature('lot-1#cadastre-1', square(.001, 0, .0015, .001), { cadastralPart: true, cadastreParcelIds: ['lot-1'] });
        const far = feature('lot-1#cadastre-2', square(1, 1, 1.001, 1.001), { cadastralPart: true, cadastreParcelIds: ['lot-1'] });
        const fabric = { peekBounds: () => [near], entriesForCadastre: () => [near, part, far] };
        expect(plots.forBox(fabric, [0, 0, .001, .001]).map(item => item.properties.parcelId)).toEqual(['plot#1', 'lot-1#cadastre-1']);
        expect(plots.toPlot(fabric, part).kind).toBe('part');
    });

    it('derives planning area from the saved design source reference and public cession', () => {
        const piece = feature('plot#1', square(0, 0, .001, .001), { readjustmentPiece: { role: 'plot' }, producedByProposalId: 'design-1', cadastreParcelIds: ['lot-1'] });
        const road = feature('road#1', square(.001, 0, .002, .001), { isCorridor: true, producedByProposalId: 'design-1', cadastreParcelIds: ['lot-1'] });
        const fabric = { producedBy: () => [piece, road], peekBounds: () => [piece], entriesForCadastre: () => [], };
        const getDesign = () => ({ sourceReferences: [{ providerId: 'alatau-genplan-727', recordId: 'alatau-1' }] });
        const output = plots.toPlot(fabric, piece, { getDesign, area: item => item === road ? 100 : 900 });
        expect(output.planningArea).toEqual({ source: 'alatau-genplan-727', recordId: 'alatau-1' });
        expect(output.cessionM2).toBe(100);
    });

    it('evicts and aborts only matching viewport flights', async () => {
        const cache = scene.createViewportCache();
        let signal;
        const pending = cache.load('envelopes:zagreb:src', [0, 0, 1, 1], s => {
            signal = s;
            return new Promise((resolve, reject) => s.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        });
        cache.evict(entry => entry.scope === 'envelopes:zagreb:src');
        expect(signal.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(cache.pending).toBe(0);
    });
});
