// The review shown before a recognition run must describe the run that will actually happen: the
// same request body, the same scoped evidence, and an honest refusal when it cannot run at all.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyRunPlan = require('../../frontend/js/lane-topology-run-plan.js');

const { buildRunPlan, evidenceForBbox, featureBbox } = LaneTopologyRunPlan;

function way(id, coordinates) {
    return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { osm_id: id }
    };
}

function baseInput(overrides) {
    return {
        provider: 'claude',
        city: 'zagreb',
        bbox: [15.95, 45.79, 15.96, 45.8],
        evidence: { features: [way(1, [[15.955, 45.795], [15.956, 45.796]])], snapshotAt: '2026-07-28T00:00:00Z' },
        graph: { stats: { sections: 12, nodes: 9, lanes: 20, connections: 4, unresolvedIntersections: 2 } },
        junctions: [
            { name: 'Savska × Vukovarska', armCount: 4, nodeIds: ['osm-node:1', 'osm-node:2'] },
            { name: 'Ilica × Frankopanska', armCount: 3, nodeIds: ['osm-node:9'] }
        ],
        parentSolution: { id: 24, sourceKind: 'deterministic' },
        imagery: { key: 'zagreb_cdof_2022', label: 'CDOF 2022' },
        crop: { width: 1024, height: 768, effectiveGsdM: 0.18 },
        maxRecognitionGsdM: 0.35,
        providerAvailable: true,
        providerVersion: '1.2.3',
        promptVersion: 'lane-topology-v9',
        ...overrides
    };
}

describe('buildRunPlan', () => {
    it('produces the exact body that will be posted', () => {
        const plan = buildRunPlan(baseInput());
        expect(plan.request).toEqual({
            city: 'zagreb',
            bbox: [15.95, 45.79, 15.96, 45.8],
            provider: 'claude',
            imagerySource: 'zagreb_cdof_2022',
            baseSolutionId: 24
        });
        expect(plan.canRun).toBe(true);
        expect(plan.blockers).toEqual([]);
    });

    it('names the junctions the run will solve', () => {
        const plan = buildRunPlan(baseInput());
        expect(plan.summary.junctionCount).toBe(2);
        expect(plan.summary.junctions[0]).toEqual({
            name: 'Savska × Vukovarska', armCount: 4, nodeCount: 2
        });
    });

    it('refuses a crop the backend would reject, and says how to proceed', () => {
        const plan = buildRunPlan(baseInput({ crop: { width: 400, height: 300, effectiveGsdM: 0.52 } }));
        expect(plan.canRun).toBe(false);
        expect(plan.blockers[0]).toContain('0.52 m/px');
        expect(plan.blockers[0]).toContain('run without imagery');
    });

    it('runs once imagery is detached from a crop that was too coarse', () => {
        const plan = buildRunPlan(baseInput({ imagery: null, crop: null }));
        expect(plan.canRun).toBe(true);
        expect(plan.request.imagerySource).toBeNull();
        expect(plan.warnings.join(' ')).toContain('No orthophoto attached');
    });

    // An unsized crop silently becoming "no imagery" would run a different job than the one reviewed.
    it('blocks rather than silently dropping imagery when the crop cannot be sized', () => {
        const plan = buildRunPlan(baseInput({ crop: null }));
        expect(plan.canRun).toBe(false);
        expect(plan.blockers.join(' ')).toContain('Could not size the orthophoto crop');
        expect(plan.request.imagerySource).toBe('zagreb_cdof_2022');
    });

    it('blocks when the CLI is unavailable', () => {
        const plan = buildRunPlan(baseInput({ providerAvailable: false }));
        expect(plan.canRun).toBe(false);
        expect(plan.blockers.join(' ')).toContain('claude CLI is not available');
    });

    it('blocks when there is no evidence to reason over', () => {
        const plan = buildRunPlan(baseInput({ evidence: { features: [] } }));
        expect(plan.canRun).toBe(false);
        expect(plan.blockers.join(' ')).toContain('No OSM evidence');
    });

    it('warns when the run would have nothing to decide', () => {
        const plan = buildRunPlan(baseInput({ junctions: [] }));
        expect(plan.canRun).toBe(true);
        expect(plan.warnings.join(' ')).toContain('No unsolved junctions');
    });

    it('warns when evidence hit the feature cap', () => {
        const plan = buildRunPlan(baseInput({
            evidence: { features: [way(1, [[15.955, 45.795], [15.956, 45.796]])], truncated: true, limit: 5000 }
        }));
        expect(plan.warnings.join(' ')).toContain('5000 way cap');
    });

    it('reports no parent solution as a fresh base rather than inventing an id', () => {
        const plan = buildRunPlan(baseInput({ parentSolution: null }));
        expect(plan.summary.parentSolution).toBeNull();
        expect(plan.request.baseSolutionId).toBeNull();
    });
});

describe('evidenceForBbox', () => {
    // The client holds evidence for a padded area but the run targets the viewport, so previewing
    // the unfiltered set would promise junctions the run never sees.
    const evidence = {
        snapshotAt: '2026-07-28T00:00:00Z',
        features: [
            way(1, [[15.951, 45.791], [15.952, 45.792]]),   // inside
            way(2, [[15.9995, 45.7995], [16.001, 45.8005]]), // outside, east
            way(3, [[15.949, 45.789], [15.9505, 45.7905]])   // straddles the west edge
        ]
    };

    it('keeps ways that intersect the bbox, including ones that straddle the edge', () => {
        const scoped = evidenceForBbox(evidence, [15.95, 45.79, 15.96, 45.8]);
        expect(scoped.features.map(feature => feature.properties.osm_id)).toEqual([1, 3]);
    });

    it('preserves the rest of the evidence envelope', () => {
        const scoped = evidenceForBbox(evidence, [15.95, 45.79, 15.96, 45.8]);
        expect(scoped.snapshotAt).toBe('2026-07-28T00:00:00Z');
    });

    it('passes everything through when no bbox is given', () => {
        expect(evidenceForBbox(evidence, null).features).toHaveLength(3);
    });

    it('handles missing or malformed geometry without throwing', () => {
        const scoped = evidenceForBbox({ features: [{ type: 'Feature' }, way(4, [])] }, [0, 0, 1, 1]);
        expect(scoped.features).toEqual([]);
        expect(featureBbox({ geometry: { coordinates: [] } })).toBeNull();
    });
});
