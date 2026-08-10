// One owner is one contributor, however many parcels they came in with.
//
// The ownership SLOT is scoped to its parcel — `parcel:<id>:owner:<name>` — because the ownership
// panel asks "who signs for THIS parcel". The readjustment editor used that slot as its owner key,
// so GRAD ŠIBENIK entering with three parcels became three owners: three legend rows, three
// colours, and three separate plots out of the sweep. This pins the merge, and pins the case that
// must NOT merge — an unreadable parcel is an unknown owner, not the same unknown owner everywhere.
//
// The editor's identity is lifted out of reparcellization.js and run for real, so it fails if the
// key goes back to the slot.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const source = read('../../frontend/js/reparcellization.js');
const { normalizeOwnerSlots } = require('../../frontend/js/reparcellization-shares.js');
const { resolveOwnerDisplayName } = require('../../frontend/js/reparcellization-ui-state.js');
const contributions = require('../../frontend/js/proposals/readjustment-contributions.js');

// English strings with {{param}} interpolation — enough for the two keys these functions read.
function t(key, fallback, params = {}) {
    let out = String(fallback ?? key);
    Object.keys(params || {}).forEach(name => {
        out = out.replace(new RegExp(`{{\\s*${name}\\s*}}`, 'g'), String(params[name]));
    });
    return out;
}

function loadEditorOwnerIdentity() {
    const start = source.indexOf('    function ownerIdentityForSlot(');
    expect(start, 'ownerIdentityForSlot not found').toBeGreaterThan(-1);
    const end = source.indexOf('    function safeIntersect(', start);
    expect(end, 'end of buildOwnerShares not found').toBeGreaterThan(start);
    const body = source.slice(start, end);

    const state = {};
    // eslint-disable-next-line no-new-func
    const factory = new Function(
        't', 'resolveOwnerDisplayName', 'window', 'computeFeatureArea', 'getParcelLandValue',
        'ensureParcelOwnerSlots', 'normalizeOwnerSlots', 'state', 'pickOwnerColor',
        `${body} return { ownerIdentityForSlot, buildOwnerShares };`
    );

    // A test states its cadastre inline rather than going through the live ownership cache.
    const slotsById = new Map();
    const ensureParcelOwnerSlots = async (parcelId) => slotsById.get(String(parcelId)) || [];

    const api = factory(
        t,
        resolveOwnerDisplayName,
        { __readjustmentContributions: contributions },
        feature => Number(feature?.properties?.calculatedArea) || 0,
        (feature, area) => Number(feature?.properties?.estimatedMarketPrice) || (Number(area) || 0) * 100,
        ensureParcelOwnerSlots,
        normalizeOwnerSlots,
        state,
        (ownerKey, index) => `color:${ownerKey || index}`
    );
    return { ...api, state, slotsById };
}

// A parcel as the editor sees it: a Leaflet layer wrapping a GeoJSON feature.
function parcel(parcelId, areaM2, extraProps = {}) {
    return {
        feature: {
            type: 'Feature',
            properties: { parcelId, calculatedArea: areaM2, BROJ_CESTICE: `${parcelId}-cc`, ...extraProps },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
        }
    };
}

const realSlot = (name, shareText = '1/1', extra = {}) => ({
    key: `slot-${name}`,
    displayName: name,
    shareText,
    shareDetail: '',
    type: 'human',
    agentId: null,
    placeholder: false,
    ...extra
});

describe('who an owner is, in a readjustment', () => {
    const { ownerIdentityForSlot } = loadEditorOwnerIdentity();

    it('is the person, not the parcel slot', () => {
        const a = ownerIdentityForSlot(realSlot('GRAD ŠIBENIK'), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('GRAD ŠIBENIK'), 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe(b.ownerKey);
        expect(a.ownerKey).not.toMatch(/HR-1-10/);
    });

    it('reads through spelling noise the cadastre leaves behind', () => {
        const a = ownerIdentityForSlot(realSlot('Ivan Horvat'), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('IVAN  HORVAT '), 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe(b.ownerKey);
    });

    it('agrees with the contribution accounting', () => {
        const identity = ownerIdentityForSlot(realSlot('GRAD ŠIBENIK'), 'HR-1-100', 'Owner of 100');
        expect(identity.ownerKey).toBe(contributions.ownerKeyOf({ name: 'GRAD ŠIBENIK' }));
    });

    it('ignores the slot address — it is a postal address, not an identity', () => {
        const withPlace = realSlot('GRAD ŠIBENIK', '1/1', { agentId: 'ŠIBENIK, TRG PALIH BORACA 1' });
        const without = realSlot('GRAD ŠIBENIK');
        expect(ownerIdentityForSlot(withPlace, 'HR-1-100', 'Owner of 100').ownerKey)
            .toBe(ownerIdentityForSlot(without, 'HR-1-101', 'Owner of 101').ownerKey);
    });

    it('keeps two different people apart', () => {
        const a = ownerIdentityForSlot(realSlot('GRAD ŠIBENIK'), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('JAVNO DOBRO U OPĆOJ UPORABI - GRAD ŠIBENIK'), 'HR-1-100', 'Owner of 100');
        expect(a.ownerKey).not.toBe(b.ownerKey);
    });

    it('does NOT merge unreadable parcels — an unknown owner is unknown per parcel', () => {
        const placeholder = { key: 'parcel:x:owner', displayName: 'Single owner', shareText: '100%', placeholder: true };
        const a = ownerIdentityForSlot(placeholder, 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(placeholder, 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).not.toBe(b.ownerKey);
        // ...and it says WHICH parcel, so the legend cannot show two identical rows.
        expect(a.displayName).toBe('Owner of 100');
        expect(b.displayName).toBe('Owner of 101');
    });

    it('names a nameless owner after its parcel rather than "Unassigned"', () => {
        const identity = ownerIdentityForSlot(realSlot('Unassigned'), 'HR-1-100', 'Owner of 100');
        expect(identity.displayName).toBe('Owner of 100');
        expect(identity.ownerKey).toBe(contributions.ownerKeyOf({ name: 'Owner of 100' }));
    });
});

describe('pooling the same owner across parcels', () => {
    it('gives them one share, one colour and the sum of their land', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.slotsById.set('HR-1-100', [realSlot('GRAD ŠIBENIK')]);
        editor.slotsById.set('HR-1-101', [realSlot('GRAD ŠIBENIK')]);
        editor.slotsById.set('HR-1-102', [realSlot('JAVNO DOBRO')]);

        const shares = await editor.buildOwnerShares({
            ids: ['HR-1-100', 'HR-1-101', 'HR-1-102'],
            layers: [parcel('HR-1-100', 600), parcel('HR-1-101', 400), parcel('HR-1-102', 1000)]
        });

        expect(shares).toHaveLength(2);
        const grad = shares.find(s => s.displayName === 'GRAD ŠIBENIK');
        expect(grad.area).toBeCloseTo(1000, 6);
        expect(grad.percent).toBeCloseTo(0.5, 6);
        expect(grad.parcelIds.sort()).toEqual(['HR-1-100', 'HR-1-101']);
        // One key means one colour: the two-colour legend was the visible symptom.
        expect(new Set(shares.map(s => s.color)).size).toBe(2);
    });

    it('carries recorded shares over, then aggregates the person across parcels', async () => {
        const editor = loadEditorOwnerIdentity();
        // Ana holds half of one parcel and all of another; Boris holds the other half of the first.
        editor.slotsById.set('HR-1-100', [realSlot('Ana', '1/2'), realSlot('Boris', '1/2')]);
        editor.slotsById.set('HR-1-101', [realSlot('Ana')]);

        const shares = await editor.buildOwnerShares({
            ids: ['HR-1-100', 'HR-1-101'],
            layers: [parcel('HR-1-100', 800), parcel('HR-1-101', 200)]
        });

        expect(shares).toHaveLength(2);
        expect(shares.find(s => s.displayName === 'Ana').area).toBeCloseTo(600, 6);
        expect(shares.find(s => s.displayName === 'Boris').area).toBeCloseTo(400, 6);
    });

    it('still shows one row per unreadable parcel', async () => {
        const editor = loadEditorOwnerIdentity();
        const placeholder = { key: 'parcel:x:owner', displayName: 'Single owner', shareText: '100%', placeholder: true };
        editor.slotsById.set('HR-1-100', [placeholder]);
        editor.slotsById.set('HR-1-101', [placeholder]);

        const shares = await editor.buildOwnerShares({
            ids: ['HR-1-100', 'HR-1-101'],
            layers: [parcel('HR-1-100', 500), parcel('HR-1-101', 500)]
        });

        expect(shares).toHaveLength(2);
        expect(shares.map(s => s.displayName).sort()).toEqual(['Owner of HR-1-100-cc', 'Owner of HR-1-101-cc']);
    });
});
