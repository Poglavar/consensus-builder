import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { namedPlanScoreScope, measureParcelRows } = require('../../frontend/js/proposals/grain-score-rules.js');
const { resultingParcels } = require('../../frontend/js/proposals/plan-yield.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

const plan = { proposalRowIds: ['41'], members: [{ proposalRowId: '41', authoredProposalId: 'published', changed: false }] };
const member = { proposalId: 'local-member', serverProposalId: '41', applied: true, cadastreParcelIds: ['A'] };
const parcel = (id, west = 0, east = 0.0002, properties = {}) => ({
    type: 'Feature', properties: { parcelId: id, ...properties },
    geometry: { type: 'Polygon', coordinates: [[[west, 0], [east, 0], [east, 0.0002], [west, 0.0002], [west, 0]]] }
});

describe('named score uses the whole applied composition as its boundary', () => {
    it('permits exactly the verified named members', () => {
        expect(namedPlanScoreScope(plan, [member])).toEqual({ error: null, proposals: [member] });
    });

    it('keeps missing originals distinct from outside proposals', () => {
        const fork = { proposalId: 'fork', replacementOfProposalId: '41' };
        expect(namedPlanScoreScope(plan, [fork])).toEqual({ error: 'members', proposals: null });
    });

    it.each([
        ['a corridor on the same cadastre', { goal: 'road-track', cadastreParcelIds: ['A'] }],
        ['a formation spanning several anchors', { goal: 'reparcellization', cadastreParcelIds: ['A', 'B'] }],
        ['a distant proposal', { cadastreParcelIds: ['B'] }],
        ['a proposal on open ground', { cadastreParcelIds: [] }],
    ])('refuses %s outside the named plan', (_label, fields) => {
        const outsider = { proposalId: 'outside', applied: true, ...fields };
        expect(namedPlanScoreScope(plan, [member, outsider])).toEqual({ error: 'composition', proposals: null });
        expect(outsider.applied).toBe(true); // Eligibility does not change the user's map.
    });

    it('permits scoring again once outside proposals are unapplied', () => {
        const outside = { proposalId: 'outside', applied: true };
        expect(namedPlanScoreScope(plan, [member, outside]).error).toBe('composition');
        expect(namedPlanScoreScope(plan, [member]).proposals).toEqual([member]);
    });
});

describe('parcel measurements come from one captured fabric', () => {
    it('keeps counts and shapes from the captured revision even if a live ID is reused', async () => {
        const live = createLiveParcelFabric();
        const commit = async change => {
            const draft = live.beginMutation();
            change(draft);
            await draft.prepare();
            draft.publish();
        };
        await commit(draft => draft.seedCadastre([parcel('A')]));
        const properties = { cadastreParcelIds: ['A'], producedByProposalId: member.proposalId };
        await commit(draft => draft.replaceCadastreScope(['A'], [parcel('piece-1', 0, 0.0002, properties)]));
        const captured = live.entriesForCadastre(['A'], { includeCorridors: false });
        const revision = live.snapshot().revision;
        const fabric = resultingParcels([member], { appliedOnly: true, materializedFeatures: captured });

        await commit(draft => draft.replaceCadastreScope(['A'], [
            parcel('piece-1', 0, 0.0001, properties), parcel('piece-2', 0.0001, 0.0002, properties)
        ]));

        const rows = measureParcelRows(fabric.resulting, captured);
        const current = measureParcelRows(['piece-1'], live.entriesForCadastre(['A']));
        expect(live.snapshot().revision).toBeGreaterThan(revision);
        expect(fabric.resulting).toEqual(['piece-1']);
        expect(rows[0].widthMeters).toBeGreaterThan(current[0].widthMeters * 1.9);
        expect(rows[0].feature.geometry).toEqual(captured[0].geometry);
    });

    it('does not turn an absent materialized result into unchanged cadastral ground', () => {
        const rows = measureParcelRows(['A'], []);
        expect(rows).toEqual([{ id: 'A', feature: null, widthMeters: null, depthMeters: null }]);
    });

    it('uses explicit source fallback only when supplied, with live shapes taking precedence', () => {
        const source = parcel('A');
        const materialized = parcel('A', 0, 0.0001);
        expect(measureParcelRows(['A'], [], [source])[0].feature).toBe(source);
        expect(measureParcelRows(['A'], [materialized], [source])[0].feature).toBe(materialized);
    });
});
