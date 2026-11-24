import { describe, expect, it } from 'vitest';
import { evaluatePlot } from '../planning/providers/nyc-pilot.js';
import { __clearCache } from '../zoning/pluto.js';

const rect = (w = 0.0001, h = 0.0003) => ({ type: 'Polygon', coordinates: [[[ -73.98, 40.70], [-73.98 + w, 40.70], [-73.98 + w, 40.70 + h], [-73.98, 40.70 + h], [-73.98, 40.70]]] });
const row = (bbl, zonedist1 = 'R6A') => ({ bbl, address: 'Test', borough: 'BK', cd: '303', version: '2025', zonedist1, splitzone: 'N', lottype: '5', irrlotcode: 'N', lotarea: 2000, lotfront: 30, lotdepth: 100, residfar: 3 });
const opts = rows => ({ fetchImpl: async url => ({ ok: true, json: async () => { const found = rows.find(r => new URL(url).searchParams.get('bbl') === r.bbl); return found ? [found] : []; } }) });

describe('NYC plan-plot pilot', () => {
    it('reports merged frontage over the pilot tier as outside scope', async () => {
        __clearCache();
        const answer = await evaluatePlot(null, { plot: { geometry: rect(0.0003, 0.0003), cadastreParcelIds: ['US-NYC-BBL-3000010001', 'US-NYC-BBL-3000010002'] }, frontage:{frontEdge:0}, standing:()=>({corner:false,openEdges:[0]}) }, opts([row('3000010001'), row('3000010002')]));
        expect(answer.reason).toBe('outside-scope');
        expect(answer.evidence.screening.issues.some(issue => issue.code === 'dimensions-outside-tier')).toBe(true);
    });
    it('distinguishes mixed districts and missing PLUTO rows', async () => {
        __clearCache();
        const mixed = await evaluatePlot(null, { plot: { geometry: rect(), cadastreParcelIds: ['US-NYC-BBL-3000010001', 'US-NYC-BBL-3000010002'] }, frontage:{frontEdge:0}, standing:()=>({corner:false,openEdges:[0]}) }, opts([row('3000010001', 'R6A'), row('3000010002', 'R7A')]));
        expect(mixed.reason).toBe('plot-spans-districts');
        __clearCache();
        const missing = await evaluatePlot(null, { plot: { geometry: rect(), cadastreParcelIds: ['US-NYC-BBL-3000010001', 'US-NYC-BBL-3000010002'] }, frontage:{frontEdge:0}, standing:()=>({corner:false,openEdges:[0]}) }, opts([row('3000010001')]));
        expect(missing.reason).toBe('plot-without-lot-record');
    });
    it('requires frontage evidence and marks non-rectangular plots irregular', async () => {
        __clearCache();
        const noFrontage = await evaluatePlot(null, { plot: { geometry: rect(), cadastreParcelIds: ['US-NYC-BBL-3000010001'] } }, opts([row('3000010001')]));
        expect(noFrontage).toMatchObject({ reason: 'needs-review', evidence: { code: 'frontage-unresolved' } });
        __clearCache();
        const irregular = { type: 'Polygon', coordinates: [[[-73.98,40.7],[-73.9798,40.7],[-73.9798,40.7003],[-73.9799,40.7002],[-73.98,40.7]]] };
        const answer = await evaluatePlot(null, { plot: { geometry: irregular, cadastreParcelIds: ['US-NYC-BBL-3000010001'] }, frontage:{frontEdge:0}, standing:()=>({corner:false,openEdges:[0]}) }, opts([row('3000010001')]));
        expect(answer.reason).toBe('outside-scope');
        expect(answer.evidence.pluto.irregularLot).toBe(true);
    });
});
