// The cross-section editor's honesty rules (road-editor.md decision 6), on the pure tail of
// frontend/js/corridor-editor.js: every refusal says why (and each reason is checked against the real
// transform refusing), a road-wide Apply keeps per-stretch cross-sections unless told otherwise, a
// Move / Widen toward commits the previewed cross-section with the shift, and a width change names
// the parcels its land adds and frees before anything is applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const profileApi = require('../../frontend/js/corridor-profile.js');
const {
    CORRIDOR_PROFILE_PRESETS,
    withLaneWidth,
    withLaneRemoved,
    withSeamMoved,
    withLaneTreeEvery,
    withLaneType
} = profileApi;

// In the browser the editor reads the profile model and the formatter as globals (classic scripts).
const GLOBALS = { ...profileApi, CbFormat: require('../../frontend/js/format.js') };
beforeAll(() => { Object.assign(globalThis, GLOBALS); });
afterAll(() => { Object.keys(GLOBALS).forEach(name => { delete globalThis[name]; }); });

const editor = require('../../frontend/js/corridor-editor.js');

const preset18 = () => ({ strips: CORRIDOR_PROFILE_PRESETS[18].map(strip => ({ ...strip })) });
const DRIVING = 3; // index of the first traffic lane in the 18 m preset
const PARKING = 2;

describe('refusal reasons', () => {
    const reasonFor = (profile, attempt) => editor.corridorEditorRefusalReason(profile, attempt);

    it('names the traffic-lane minimum for a too-narrow traffic lane', () => {
        expect(withLaneWidth(preset18(), DRIVING, 2)).toBe(null);
        expect(reasonFor(preset18(), { op: 'width', index: DRIVING, width: 2 }))
            .toEqual({ key: 'modal.corridor.refusedDrivingMin', fallback: expect.any(String), params: { min: 2.5 } });
    });

    it('names the lane and the half-metre minimum for any other lane', () => {
        expect(withLaneWidth(preset18(), 0, 0.25)).toBe(null);
        expect(reasonFor(preset18(), { op: 'width', index: 0, width: 0.25 }))
            .toMatchObject({ key: 'modal.corridor.refusedLaneMin', params: { laneType: 'sidewalk', min: 0.5 } });
    });

    it('asks for a number when the width is not one, and for a lane that is gone says so', () => {
        expect(withLaneWidth(preset18(), 0, Number('abc'))).toBe(null);
        expect(reasonFor(preset18(), { op: 'width', index: 0, width: Number('abc') }).key)
            .toBe('modal.corridor.refusedWidthNotNumber');
        expect(withLaneWidth(preset18(), 40, 3)).toBe(null);
        expect(reasonFor(preset18(), { op: 'width', index: 40, width: 3 }).key).toBe('modal.corridor.refusedLaneMissing');
    });

    it('explains a fixed-width parking lane that is already at its depth', () => {
        expect(withLaneWidth(preset18(), PARKING, 2.5)).not.toBe(null); // 2 m legacy lane snaps to 2.5
        const standard = withLaneWidth(preset18(), PARKING, 2.5);
        expect(withLaneWidth(standard, PARKING, 2.5)).toBe(null);
        expect(reasonFor(standard, { op: 'width', index: PARKING, width: 2.5 }))
            .toMatchObject({ key: 'modal.corridor.refusedFixedWidth', params: { laneType: 'parking', width: 2.5 } });
    });

    it('refuses to remove the last lane, saying a corridor needs one', () => {
        const single = { strips: [{ type: 'driving', width: 3, direction: 'forward' }] };
        expect(withLaneRemoved(single, 0)).toBe(null);
        expect(reasonFor(single, { op: 'remove', index: 0 }).key).toBe('modal.corridor.refusedLastLane');
    });

    it('says which lane stops a seam, on whichever side the drag squeezes', () => {
        const profile = { strips: [{ type: 'sidewalk', width: 2 }, { type: 'cycleway', width: 1.5, direction: 'forward' }] };
        expect(withSeamMoved(profile, 0, -1.8)).toBe(null);
        expect(reasonFor(profile, { op: 'seam', seamIndex: 0, delta: -1.8 }))
            .toMatchObject({ key: 'modal.corridor.refusedSeam', params: { laneType: 'sidewalk', min: 0.5 } });
        expect(withSeamMoved(profile, 0, 1.2)).toBe(null);
        expect(reasonFor(profile, { op: 'seam', seamIndex: 0, delta: 1.2 }).params.laneType).toBe('cycleway');
        // A seam against parking never moves at all.
        expect(withSeamMoved(preset18(), 1, 0.25)).toBe(null);
        expect(reasonFor(preset18(), { op: 'seam', seamIndex: 1, delta: 0.25 }).key).toBe('modal.corridor.seamLocked');
    });

    it('covers the planting count, an unknown type, and a setting the lane does not have', () => {
        expect(withLaneTreeEvery(preset18(), PARKING, -1)).toBe(null);
        expect(reasonFor(preset18(), { op: 'treeEvery', index: PARKING, treeEvery: -1 }).key)
            .toBe('modal.corridor.refusedTreeEvery');
        expect(reasonFor(preset18(), { op: 'treeEvery', index: 0, treeEvery: 2 }))
            .toMatchObject({ key: 'modal.corridor.refusedNotApplicable', params: { laneType: 'sidewalk' } });
        expect(withLaneType(preset18(), 0, 'helipad')).toBe(null);
        expect(reasonFor(preset18(), { op: 'type', index: 0, type: 'helipad' }).key).toBe('modal.corridor.refusedUnknownType');
        expect(reasonFor(preset18(), null).key).toBe('modal.corridor.refusedGeneric');
    });

    it('puts the reason into words: the lane by its label, the metres formatted', () => {
        const text = editor.corridorEditorRefusalText(reasonFor(preset18(), { op: 'width', index: 0, width: 0.25 }));
        expect(text).toBe('Sidewalk cannot be narrower than 0.5 m — narrower is a line, not a lane.');
        expect(editor.corridorEditorRefusalText(reasonFor(preset18(), { op: 'width', index: DRIVING, width: 1 })))
            .toBe('A traffic lane must be at least 2.5 m wide — narrower is not a traffic lane.');
    });
});

describe('the Apply mutation', () => {
    const own = { strips: [{ type: 'sidewalk', width: 1 }, { type: 'driving', width: 3, direction: 'forward' }] };
    const network = () => ({
        points: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }], [{ lat: 0, lng: 1 }, { lat: 1, lng: 1 }]],
        segmentIds: ['a', 'b'],
        profile: preset18(),
        width: 18,
        segmentProfiles: { b: JSON.parse(JSON.stringify(own)) },
        edgeFill: { limit: 'buildings', survey: 'gdi' }
    });
    const request = overrides => ({
        scope: 'road',
        segmentId: null,
        profile: { strips: CORRIDOR_PROFILE_PRESETS[26] },
        edgeFill: { limit: 'buildings', survey: 'gdi' },
        replaceStretchProfiles: false,
        ...overrides
    });

    it('keeps the stretches with their own cross-section on a road-wide Apply by default', () => {
        const definition = network();
        editor.corridorEditorProfileMutator(request())(definition);
        expect(definition.profile.strips).toEqual(CORRIDOR_PROFILE_PRESETS[26]);
        expect(definition.width).toBe(26);
        expect(definition.segmentProfiles).toEqual({ b: own });
        expect(definition.edgeFill).toEqual({ limit: 'buildings', survey: 'gdi' });
    });

    it('replaces them too when the user ticked "Also replace"', () => {
        const definition = network();
        editor.corridorEditorProfileMutator(request({ replaceStretchProfiles: true }))(definition);
        expect(definition.segmentProfiles).toBe(undefined);
        expect(definition.profile.strips).toEqual(CORRIDOR_PROFILE_PRESETS[26]);
    });

    it('writes one stretch in segment scope, and drops an override equal to the default', () => {
        const definition = network();
        editor.corridorEditorProfileMutator(request({ scope: 'segment', segmentId: 'a', profile: own }))(definition);
        expect(definition.segmentProfiles).toEqual({ a: own, b: own });
        expect(definition.profile).toEqual(preset18());

        editor.corridorEditorProfileMutator(request({ scope: 'segment', segmentId: 'b', profile: preset18() }))(definition);
        expect(Object.keys(definition.segmentProfiles)).toEqual(['a']);
    });

    it('copies the profile, so a later edit of the editor copy cannot reach the stored record', () => {
        const working = preset18();
        const definition = network();
        editor.corridorEditorProfileMutator(request({ profile: working }))(definition);
        working.strips[0].width = 9;
        expect(definition.profile.strips[0].width).toBe(2);
    });

    it('counts only live stretches that carry their own cross-section', () => {
        expect(editor.corridorEditorOwnProfileCount(network())).toBe(1);
        expect(editor.corridorEditorOwnProfileCount({ ...network(), segmentProfiles: { gone: own, b: own } })).toBe(1);
        expect(editor.corridorEditorOwnProfileCount({ ...network(), segmentProfiles: undefined })).toBe(0);
    });

    it('offers "Also replace" only road-wide on a placed road that has such stretches, with the preview note while off', () => {
        const html = editor.corridorEditorStretchesOptionHtml({
            mode: 'proposal', scope: 'road', count: 2, checked: false, label: 'Also replace the 2 stretches', note: 'preview note'
        });
        expect(html).toContain('class="corridor-editor-stretches-input"');
        expect(html).not.toContain(' checked');
        expect(html).toContain('preview note');
        const ticked = editor.corridorEditorStretchesOptionHtml({ mode: 'proposal', scope: 'road', count: 2, checked: true, label: 'x', note: 'preview note' });
        expect(ticked).toContain(' checked');
        expect(ticked).not.toContain('preview note');
        expect(editor.corridorEditorStretchesOptionHtml({ mode: 'proposal', scope: 'segment', count: 2 })).toBe('');
        expect(editor.corridorEditorStretchesOptionHtml({ mode: 'proposal', scope: 'road', count: 0 })).toBe('');
        expect(editor.corridorEditorStretchesOptionHtml({ mode: 'drawing', scope: 'road', count: 2 })).toBe('');
    });
});

describe('Move / Widen toward carries the previewed cross-section', () => {
    const MOVED = [{ lat: 0.5, lng: 0 }, { lat: 0.5, lng: 1 }];

    it('commits the shift and the preview together on a single-stretch road', () => {
        const definition = { points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }], profile: preset18(), width: 18 };
        const wider = withLaneWidth(preset18(), 0, 3);
        editor.corridorEditorFitShiftMutator(MOVED, { scope: 'road', segmentId: null }, {
            scope: 'road', segmentId: null, profile: wider, edgeFill: { limit: 'none', survey: 'gdi' }, replaceStretchProfiles: false
        })(definition);
        expect(definition.points).toEqual(MOVED);
        expect(definition.profile).toEqual(wider);
        expect(definition.width).toBe(19);
    });

    it('moves and re-sections only the scoped stretch in segment scope', () => {
        const other = [{ lat: 5, lng: 0 }, { lat: 5, lng: 1 }];
        const definition = {
            points: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }], other],
            segmentIds: ['a', 'b'],
            profile: preset18()
        };
        const wider = withLaneWidth(preset18(), 0, 3);
        editor.corridorEditorFitShiftMutator(MOVED, { scope: 'segment', segmentId: 'a' }, {
            scope: 'segment', segmentId: 'a', profile: wider, edgeFill: { limit: 'none', survey: 'gdi' }, replaceStretchProfiles: false
        })(definition);
        expect(definition.points[0]).toEqual(MOVED);
        expect(definition.points[1]).toBe(other);
        expect(definition.segmentProfiles).toEqual({ a: wider });
        expect(definition.profile).toEqual(preset18());
    });

    it('leaves the cross-section alone when there is no preview to carry', () => {
        const definition = { points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }], profile: preset18() };
        editor.corridorEditorFitShiftMutator(MOVED, { scope: 'road', segmentId: null }, null)(definition);
        expect(definition.points).toEqual(MOVED);
        expect(definition.profile).toEqual(preset18());
        expect(definition.edgeFill).toBe(undefined);
    });
});

describe('the parcels a width change takes and frees', () => {
    it('splits two takes into added, removed and unchanged, largest take first', () => {
        const diff = editor.corridorEditorParcelTakeDiff(
            [{ id: 'P-1', areaM2: 40 }, { id: 'P-2', areaM2: 12 }, { id: 'P-9', areaM2: 3 }],
            [{ id: 'P-1', areaM2: 55 }, { id: 'P-3', areaM2: 4 }, { id: 'P-4', areaM2: 30 }, { id: 'P-4', areaM2: 2 }]
        );
        expect(diff.added).toEqual([{ id: 'P-4', areaM2: 32 }, { id: 'P-3', areaM2: 4 }]);
        expect(diff.removed).toEqual([{ id: 'P-2', areaM2: 12 }, { id: 'P-9', areaM2: 3 }]);
        expect(diff.unchanged).toEqual([{ id: 'P-1', beforeM2: 40, afterM2: 55 }]);
    });

    it('compares ids as strings and keeps an unknown area unknown rather than zero', () => {
        const diff = editor.corridorEditorParcelTakeDiff([{ id: 7, areaM2: 5 }], [{ id: '7', areaM2: 6 }, { id: 8, areaM2: null }]);
        expect(diff.added).toEqual([{ id: '8', areaM2: null }]);
        expect(diff.removed).toEqual([]);
    });

    const format = { width: metres => `${metres} m`, area: squareMetres => `${squareMetres} m²` };

    it('names the width change, up to five parcels per list, and how many more', () => {
        const added = Array.from({ length: 7 }, (_, index) => ({ id: `A-${index}`, areaM2: 70 - index }));
        const message = editor.corridorEditorTakeMessage({
            widthBefore: 18, widthAfter: 21.5, diff: { added, removed: [{ id: 'R-1', areaM2: 9 }, { id: 'R-2', areaM2: 8 }] }, unmeasured: 0
        }, format).split('\n');
        expect(message[0]).toBe('Width 18 m → 21.5 m.');
        expect(message[1]).toBe('This cross-section takes land from 7 more parcels:');
        expect(message.slice(2, 7)).toEqual(['A-0 · 70 m²', 'A-1 · 69 m²', 'A-2 · 68 m²', 'A-3 · 67 m²', 'A-4 · 66 m²']);
        expect(message[7]).toBe('plus 2 more');
        expect(message[8]).toBe('It frees 2 parcels:');
        expect(message.slice(9)).toEqual(['R-1 · 9 m²', 'R-2 · 8 m²']);
    });

    it('says so when no parcel is added or freed, and when pieces could not be measured', () => {
        const message = editor.corridorEditorTakeMessage({
            widthBefore: 18, widthAfter: 18.5, diff: { added: [], removed: [] }, unmeasured: 3
        }, format);
        expect(message).toMatch(/No parcel is added or freed/);
        expect(message).toMatch(/3 parcel pieces could not be measured/);
    });

    it('says why the parcels cannot be listed instead of skipping the question', () => {
        expect(editor.corridorEditorTakeMessage({ widthBefore: 10, widthAfter: 12, unavailable: 'no-parcels' }, format))
            .toBe('Width 10 m → 12 m.\nThere are no surveyed parcels under this road (unsurveyed land), so there are none to list.');
        expect(editor.corridorEditorTakeMessage({ widthBefore: 10, widthAfter: 12, unavailable: 'no-fabric' }, format))
            .toMatch(/parcel map is not loaded/);
        expect(editor.corridorEditorTakeMessage({ widthBefore: 10, widthAfter: 12, unavailable: 'footprint' }, format))
            .toMatch(/could not be built/);
    });
});
