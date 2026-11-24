import { describe, expect, it, vi } from 'vitest';
import { evaluatePlot } from '../planning/providers/zagreb-gup.js';

const plot = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };

describe('Zagreb plan-plot solver adapter', () => {
    it('is disabled unless explicitly enabled', async () => {
        await expect(evaluatePlot(null, { plot })).resolves.toEqual({ reason: 'plot-solver-disabled' });
    });
    it('posts one bounded geometry and preserves hypothetical evidence', async () => {
        const fetch = vi.fn(async (_url, request) => ({ ok: true, json: async () => ({
            solver_version: 'solver-test', rule_id: 'R-1', variables: { height: 12 }, resolver_evidence: { source: 'test' },
            gbp_m2: 420, volumes: [{ geometry: plot, base_elevation_m: 0, top_elevation_m: 12 }]
        }) }));
        const answer = await evaluatePlot(null, { plot, parcel: { id: 'HR-1-2' } }, { enabled: true, endpoint: 'http://solver.test/envelope/solve-geometry', fetch });
        expect(fetch).toHaveBeenCalledOnce();
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ gup_id: 2025, geometry: plot });
        expect(answer.item.sourceEvidence.plot).toMatchObject({ solverVersion: 'solver-test', gupId: 2025, ruleId: 'R-1', hypothetical_plot: true });
        expect(answer.item.sourceEvidence.plot.note).toContain('outside the citywide');
    });
    it('rejects plots over one square kilometre before transport', async () => {
        const fetch = vi.fn();
        const huge = { type: 'Polygon', coordinates: [[[-1, 0], [1, 0], [1, 1], [-1, 1], [-1, 0]]] };
        await expect(evaluatePlot(null, { plot: huge }, { enabled: true, endpoint: 'http://solver.test', fetch })).resolves.toEqual({ reason: 'plot-area-too-large' });
        expect(fetch).not.toHaveBeenCalled();
    });
});
