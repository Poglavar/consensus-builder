// reparcel-edit-impact.js — editing a saved land readjustment re-forms its ground. Only the plots
// whose shape CHANGED displace what stands on them; untouched plots keep their proposals.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let impact;

beforeAll(() => {
    impact = require('../../frontend/js/proposals/reparcel-edit-impact.js');
});

const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const plot = (x0, y0, x1, y1) => ({ geometry: { type: 'Polygon', coordinates: [ring(x0, y0, x1, y1)] } });

// Exact for axis-aligned rectangles, which is all these fixtures use.
const box = f => {
    const r = (f.geometry.type === 'Feature' ? f.geometry.geometry : f.geometry).coordinates[0];
    const xs = r.map(p => p[0]);
    const ys = r.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const ctx = {
    area: f => { const b = box(f); return (b.x1 - b.x0) * (b.y1 - b.y0); },
    intersectionArea: (a, b) => {
        const A = box(a), B = box(b);
        const w = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
        const h = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
        return (w > 0 && h > 0) ? w * h : 0;
    }
};

describe('changedPlotIndices', () => {
    const before = [plot(0, 0, 10, 10), plot(10, 0, 20, 10), plot(20, 0, 30, 10)];

    it('reports nothing when the plan is untouched', () => {
        expect(impact.changedPlotIndices(before, before.slice(), ctx)).toEqual([]);
    });

    it('ignores plot reordering — same ground, different list position', () => {
        const after = [before[2], before[0], before[1]];
        expect(impact.changedPlotIndices(before, after, ctx)).toEqual([]);
    });

    it('reports only the plot whose boundary moved', () => {
        const after = [before[0], plot(10, 0, 22, 10), before[2]];
        expect(impact.changedPlotIndices(before, after, ctx)).toEqual([1]);
    });

    it('reports a deleted plot', () => {
        expect(impact.changedPlotIndices(before, [before[0], before[2]], ctx)).toEqual([1]);
    });

    it('tolerates vertex noise below the threshold', () => {
        const after = [plot(0, 0, 10.02, 10), before[1], before[2]];
        expect(impact.changedPlotIndices(before, after, ctx)).toEqual([]);
    });

    it('catches a plot that kept its area but moved', () => {
        const after = [plot(40, 40, 50, 50), before[1], before[2]];
        expect(impact.changedPlotIndices(before, after, ctx)).toEqual([0]);
    });

    it('returns nothing without usable geometry helpers', () => {
        expect(impact.changedPlotIndices(before, [], null)).toEqual([]);
    });
});

describe('childIdsForPlots', () => {
    it('maps plot indices to the child parcels minted for them', () => {
        const ids = ['HR-1-2#c-rep-1', 'HR-1-2#c-rep-2', 'HR-1-2#c-rep-3'];
        expect(impact.childIdsForPlots([0, 2], ids)).toEqual(['HR-1-2#c-rep-1', 'HR-1-2#c-rep-3']);
    });

    it('skips indices with no minted child', () => {
        expect(impact.childIdsForPlots([0, 9], ['only-one'])).toEqual(['only-one']);
    });
});

describe('proposalsOnPlots', () => {
    const applied = [
        { key: 'c-bldg', proposal: { title: 'Block A', parentParcelIds: ['HR-1-2#c-rep-2'] } },
        { key: 'c-park', proposal: { title: 'Park', structureProposal: { parentParcelIds: ['HR-1-2#c-rep-9'] } } },
        { key: 'c-road', proposal: { title: 'Road', roadProposal: { parentParcelIds: ['HR-1-2#c-rep-2'] } } }
    ];

    it('finds proposals standing on a changed plot, top-level or typology parents', () => {
        const hits = impact.proposalsOnPlots(['HR-1-2#c-rep-2'], applied);
        expect(hits.map(h => h.key).sort()).toEqual(['c-bldg', 'c-road']);
        expect(hits.find(h => h.key === 'c-bldg').title).toBe('Block A');
    });

    it('leaves proposals on untouched plots alone', () => {
        expect(impact.proposalsOnPlots(['HR-1-2#c-rep-5'], applied)).toEqual([]);
    });

    it('never reports the reparcellization being edited', () => {
        const withSelf = applied.concat([{ key: 'c-rep', proposal: { title: 'The plan', parentParcelIds: ['HR-1-2#c-rep-2'] } }]);
        const hits = impact.proposalsOnPlots(['HR-1-2#c-rep-2'], withSelf, { selfKey: 'c-rep' });
        expect(hits.map(h => h.key)).not.toContain('c-rep');
    });

    it('is empty when nothing changed', () => {
        expect(impact.proposalsOnPlots([], applied)).toEqual([]);
    });
});
