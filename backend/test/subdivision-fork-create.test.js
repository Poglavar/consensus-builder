// Forking a site-only subdivision (a plan pooled from its site, poolSource 'site', on open ground with
// no parcels) must pass the create path's plan check: it used to require plan.parcelIds and refuse
// with "Reparcellization plan is missing". Fixture: the shape of local record 1348 (explore Tokyo).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
Object.assign(globalThis, require('../../frontend/js/corridor-profile.js'));
globalThis.turf = require('@turf/turf');
const turf = globalThis.turf;
const subdivision = require('../../frontend/js/proposals/subdivision.js');
const { reparcellizationAdapter } = require('../../frontend/js/proposal-editor-adapters.js');
const record = require('./fixtures/subdivision-site-only-1348.json');
const createSource = readFileSync(new URL('../../frontend/js/proposals/create.js', import.meta.url), 'utf8');

const clone = value => JSON.parse(JSON.stringify(value));

// What the editor shell hands the create dialog for a fork of the record: the draft's plan as the
// pending plan (seedDraftPendingState) and the draft's site as the site context.
function forkForCreate(source) {
    const draft = reparcellizationAdapter.draftFromProposal(clone(source));
    return { plan: clone(draft.editorPayload.plan), site: draft.fields.site, draft };
}

describe('fork of a site-only subdivision through the create path', () => {
    it('the fixture is what failed: a site plan with no parcelIds on a record with no parcels', () => {
        expect(record.reparcellization.poolSource).toBe('site');
        expect(record.reparcellization.parcelIds).toBeUndefined();
        expect(record.cadastreParcelIds).toEqual([]);
    });

    it('is accepted: the pool is the site, the (empty) selection is not compared', () => {
        const { plan, site } = forkForCreate(record);
        expect(site).toBeTruthy();
        expect(plan.parcelIds).toBeUndefined();
        expect(subdivision.planCreateVerdict(plan, { selectedParcelIds: [], site })).toEqual({ ok: true, reason: null });
    });

    it('a subdivision whose site binds parcels is accepted although no parcel is selected', () => {
        const { plan, site } = forkForCreate(record);
        plan.parcelIds = ['HR-339164-2972'];
        expect(subdivision.planCreateVerdict(plan, { selectedParcelIds: [], site }).ok).toBe(true);
    });

    it('refuses a site plan without a site, and one whose site was redrawn after the plots', () => {
        const { plan, site } = forkForCreate(record);
        expect(subdivision.planCreateVerdict(plan, { selectedParcelIds: [], site: null }).reason).toBe('site-missing');
        const moved = turf.transformTranslate(turf.feature(site), 30, 90, { units: 'meters' }).geometry;
        expect(subdivision.planCreateVerdict(plan, { selectedParcelIds: [], site: moved }).reason).toBe('site-changed');
        const noPolygons = { ...plan, polygons: [] };
        expect(subdivision.planCreateVerdict(noPolygons, { site }).reason).toBe('missing');
    });

    it('a parcel readjustment still needs its plan parcels and the same selection', () => {
        const plan = { polygons: [{ geometry: record.site }], parcelIds: ['A', 'B'] };
        expect(subdivision.planCreateVerdict(plan, { selectedParcelIds: ['B', 'A'] }).ok).toBe(true);
        expect(subdivision.planCreateVerdict(plan, { selectedParcelIds: ['A'] }).reason).toBe('parcels-changed');
        expect(subdivision.planCreateVerdict({ polygons: plan.polygons }, { selectedParcelIds: ['A'] }).reason).toBe('missing');
    });

    it('createProposal decides with planCreateVerdict, passing the site context, not a parcelIds requirement', () => {
        expect(createSource).toMatch(/__subdivision\.planCreateVerdict\(pendingReparcelPlan, \{/);
        expect(createSource).toMatch(/site: siteContext \? siteContext\.site : null/);
        expect(createSource).not.toMatch(/!Array\.isArray\(pendingReparcelPlan\.parcelIds\)/);
    });
});
