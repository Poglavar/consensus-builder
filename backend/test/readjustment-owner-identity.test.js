// Verifies readjustment identity behavior: explicit owner IDs merge, while names never establish identity.
//
// Explicit provider IDs define identity; display names remain labels and unknown owners stay parcel-scoped.
//
// The editor's identity is run for real: a fresh editor from createReparcellizationEditor() in
// helpers/reparcellization-env.js, so it fails if the key goes back to the slot.

import { describe, it, expect, afterEach } from 'vitest';
import { makeEditor } from './helpers/reparcellization-env.js';

let env = null;
afterEach(() => { env?.dispose(); env = null; });

// A test states its cadastre inline rather than going through the live ownership cache: the maps
// below are what the editor's live fabric, cadastre repository and owner lookup answer.
function loadEditorOwnerIdentity() {
    const slotsById = new Map();
    const featuresById = new Map();
    const cadastreFeaturesById = new Map();
    const provenance = new Map();
    env?.dispose();
    env = makeEditor({
        draft: null,
        globals: {
            ensureParcelOwnerSlots: async parcelId => slotsById.get(String(parcelId)) || [],
            CadastralParcelRepository: cadastreFeaturesById,
            LiveParcelFabric: {
                cadastreIdsForParcelIds: ids => ids.flatMap(id => provenance.get(String(id)) || [String(id)]),
                get: id => featuresById.get(String(id)) || null
            }
        }
    });
    const { editor } = env;
    return {
        ownerIdentityForSlot: editor.ownerIdentityForSlot,
        buildOwnerShares: editor.buildOwnerShares,
        state: editor.state,
        slotsById, featuresById, cadastreFeaturesById, provenance
    };
}

it('builds the saved plan owner ledger from immutable facts after its live inputs were consumed', async () => {
    const editor = loadEditorOwnerIdentity();
    const id = 'HR-335550-1791/69';
    editor.cadastreFeaturesById.set(id, parcel(id, 500));
    editor.slotsById.set(id, [{ key: `parcel:${id}:owner:city`, ownerId: 'city:fixture', displayName: 'FIXTURE CITY', shareText: '1/1' }]);
    const owners = await editor.buildOwnerShares({ ids: [id], source: 'cadastre' });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ displayName: 'Owner A', ownerKey: 'city:fixture', area: 500, percent: 1 });
    expect(editor.featuresById.size).toBe(0);
});

// The editor reads authoritative GeoJSON features from LiveParcelFabric by parcel ID.
function parcel(parcelId, areaM2, extraProps = {}) {
    return {
        type: 'Feature',
        properties: { parcelId, calculatedArea: areaM2, BROJ_CESTICE: `${parcelId}-cc`, ...extraProps },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
    };
}

function setParcels(editor, ...features) {
    features.forEach(feature => editor.featuresById.set(feature.properties.parcelId, feature));
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
    // A fresh editor per call, so no test sees another's state.
    const ownerIdentityForSlot = (...args) => loadEditorOwnerIdentity().ownerIdentityForSlot(...args);

    it('merges slots with the same explicit ID across parcels', () => {
        const a = ownerIdentityForSlot(realSlot('GRAD ŠIBENIK', '1/1', { ownerId: 'city:si:001' }), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('Šibenik', '1/1', { ownerId: 'city:si:001' }), 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe('city:si:001');
        expect(b.ownerKey).toBe(a.ownerKey);
    });

    it('keeps homonyms with different explicit IDs separate', () => {
        const a = ownerIdentityForSlot(realSlot('Ivan Horvat', '1/1', { ownerId: 'person:1' }), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('IVAN HORVAT', '1/1', { ownerId: 'person:2' }), 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe('person:1');
        expect(b.ownerKey).toBe('person:2');
        expect(a.ownerKey).not.toBe(b.ownerKey);
    });

    it('does not merge missing IDs based on equal names', () => {
        const a = ownerIdentityForSlot(realSlot('Ivan Horvat'), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('Ivan Horvat'), 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe('draft-owner:HR-1-100:0');
        expect(b.ownerKey).toBe('draft-owner:HR-1-101:0');
        expect(a.ownerKey).not.toBe(b.ownerKey);
    });

    it('keeps an explicit ID stable when names or addresses change', () => {
        const a = ownerIdentityForSlot(realSlot('Ana Horvat', '1/1', { ownerId: 'person:stable', agentId: 'Old address' }), 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(realSlot('A. Horvat', '1/1', { ownerId: 'person:stable', agentId: 'New address' }), 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe(b.ownerKey);
    });

    it('uses parcel-scoped identity for unknown owners and a neutral label', () => {
        const placeholder = { key: 'parcel:x:owner', displayName: 'Single owner', shareText: '100%', placeholder: true };
        const a = ownerIdentityForSlot(placeholder, 'HR-1-100', 'Owner of 100');
        const b = ownerIdentityForSlot(placeholder, 'HR-1-101', 'Owner of 101');
        expect(a.ownerKey).toBe('draft-owner:HR-1-100:0');
        expect(b.ownerKey).toBe('draft-owner:HR-1-101:0');
        expect(a.displayName).toBe('Owner A');
    });
});

describe('pooling the same owner across parcels', () => {
    it('gives them one share, one colour and the sum of their land', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.slotsById.set('HR-1-100', [realSlot('GRAD ŠIBENIK', '1/1', { ownerId: 'municipality:grad-sibenik' })]);
        editor.slotsById.set('HR-1-101', [realSlot('GRAD ŠIBENIK', '1/1', { ownerId: 'municipality:grad-sibenik' })]);
        editor.slotsById.set('HR-1-102', [realSlot('JAVNO DOBRO', '1/1', { ownerId: 'public:parcel-owner' })]);
        setParcels(editor,
            parcel('HR-1-100', 600),
            parcel('HR-1-101', 400),
            parcel('HR-1-102', 1000));

        const shares = await editor.buildOwnerShares({
            ids: ['HR-1-100', 'HR-1-101', 'HR-1-102']
        });

        expect(shares).toHaveLength(2);
        const grad = shares.find(s => s.ownerKey === 'municipality:grad-sibenik');
        expect(grad.area).toBeCloseTo(1000, 6);
        expect(grad.percent).toBeCloseTo(0.5, 6);
        expect(grad.parcelIds.sort()).toEqual(['HR-1-100', 'HR-1-101']);
        // One key means one colour: the two-colour legend was the visible symptom.
        expect(new Set(shares.map(s => s.color)).size).toBe(2);
    });

    it('carries recorded shares over, then aggregates the person across parcels', async () => {
        const editor = loadEditorOwnerIdentity();
        // Ana holds half of one parcel and all of another; Boris holds the other half of the first.
        editor.slotsById.set('HR-1-100', [realSlot('Ana', '1/2', { ownerId: 'person:ana' }), realSlot('Boris', '1/2', { ownerId: 'person:boris' })]);
        editor.slotsById.set('HR-1-101', [realSlot('Ana', '1/1', { ownerId: 'person:ana' })]);
        setParcels(editor, parcel('HR-1-100', 800), parcel('HR-1-101', 200));

        const shares = await editor.buildOwnerShares({
            ids: ['HR-1-100', 'HR-1-101']
        });

        expect(shares).toHaveLength(2);
        expect(shares.find(s => s.ownerKey === 'person:ana').area).toBeCloseTo(600, 6);
        expect(shares.find(s => s.ownerKey === 'person:boris').area).toBeCloseTo(400, 6);
    });

    it('still shows one row per unreadable parcel', async () => {
        const editor = loadEditorOwnerIdentity();
        const placeholder = { key: 'parcel:x:owner', displayName: 'Single owner', shareText: '100%', placeholder: true };
        editor.slotsById.set('HR-1-100', [placeholder]);
        editor.slotsById.set('HR-1-101', [placeholder]);
        setParcels(editor, parcel('HR-1-100', 500), parcel('HR-1-101', 500));

        const shares = await editor.buildOwnerShares({
            ids: ['HR-1-100', 'HR-1-101']
        });

        expect(shares).toHaveLength(2);
        expect(shares.map(s => s.ownerKey).sort()).toEqual(['draft-owner:HR-1-100:0', 'draft-owner:HR-1-101:0']);
        expect(shares.every(s => /^Owner [A-B]$/.test(s.displayName))).toBe(true);
    });

    it('uses declared provider rights as the owner source and labels against every uploaded owner ID', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.state.approvalConfig = { rights: { parcels: [
            { parcelId: 'HR-1-100', complete: true, owners: [{ ownerId: 'abstract:a', share: '1/1' }] },
            { parcelId: 'HR-1-101', complete: true, owners: [{ ownerId: 'abstract:b', share: '1/1' }] }
        ] } };
        // Deliberately disagree with the local cadastre source: declared rights must take precedence.
        editor.slotsById.set('HR-1-100', [realSlot('Wrong name', '1/1', { ownerId: 'local:wrong' })]);
        setParcels(editor, parcel('HR-1-100', 500));

        const shares = await editor.buildOwnerShares({ ids: ['HR-1-100'] });

        expect(shares).toHaveLength(1);
        expect(shares[0]).toMatchObject({ ownerKey: 'abstract:a', displayName: 'Owner A', area: 500, percent: 1 });
    });

    it('keeps output recipient IDs when a newer rights snapshot changes input owner IDs', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.state.approvalConfig = { rights: { parcels: [
            { parcelId: 'cad:1', complete: true, owners: [{ ownerId: 'abstract:z', share: '1/1' }] }
        ] } };
        editor.state.initialPolygons = [{ ownerKey: 'abstract:a', owners: [{ ownerKey: 'abstract:a', share: 1 }] }];
        editor.provenance.set('live:1', ['cad:1']);
        editor.featuresById.set('live:1', parcel('live:1', 500));
        editor.cadastreFeaturesById.set('cad:1', parcel('cad:1', 500));

        const shares = await editor.buildOwnerShares({ ids: ['live:1'], source: 'fabric' });
        const savedRecipient = shares.find(entry => entry.ownerKey === 'abstract:a');
        const currentContributor = shares.find(entry => entry.ownerKey === 'abstract:z');

        expect(savedRecipient).toMatchObject({ displayName: 'Owner A', area: 0, percent: 0, unresolvedContribution: true });
        expect(currentContributor).toMatchObject({ displayName: 'Owner B', area: 500, percent: 1 });
        expect(editor.state.initialPolygons[0].displayName).toBe('Owner A');
    });

    it('restores saved ledger metadata including explicit nulls when reusing saved owner shares', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.state.savedOwnerShares = [{ ownerKey: 'source:a', contributedArea: 120, contributedValue: null }];
        editor.state.savedLedgerMetadata = { contributionBasis: 'area', totalValue: null, poolUnitValue: null };
        editor.state.initialPolygons = [{ ownerKey: 'recipient:b' }];

        const shares = await editor.buildOwnerShares(null);

        expect(editor.state).toMatchObject({ contributionBasis: 'area', totalValue: null, poolUnitValue: null });
        expect(shares.find(entry => entry.ownerKey === 'recipient:b')).toMatchObject({ area: 0, unresolvedContribution: true });
    });

    it('derives totals only for an explicit saved EUR valuation basis', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.state.savedOwnerShares = [
            { ownerKey: 'source:a', contributedArea: 40, contributedValue: 80 },
            { ownerKey: 'source:b', contributedArea: 60, contributedValue: 120 }
        ];
        editor.state.savedLedgerMetadata = { contributionBasis: 'value', valuationCurrency: 'EUR' };

        await editor.buildOwnerShares(null);

        expect(editor.state.totalValue).toBe(200);
        expect(editor.state.poolUnitValue).toBe(2);
        expect(editor.state.contributionBasis).toBe('value');

        const unknown = loadEditorOwnerIdentity();
        unknown.state.savedOwnerShares = [{ ownerKey: 'source:unknown', contributedArea: 50, contributedValue: null }];
        unknown.state.savedLedgerMetadata = {};
        await unknown.buildOwnerShares(null);
        expect(unknown.state).toMatchObject({ contributionBasis: 'area', totalValue: null, poolUnitValue: null });
    });

    it('replaces saved amend input owners only by exact cadastral ID, not composite provenance', async () => {
        const editor = loadEditorOwnerIdentity();
        editor.state.algorithm = 'amend';
        editor.state.approvalConfig = { rights: { parcels: [
            { parcelId: 'cad:a', complete: true, owners: [
                { ownerId: 'current:a', share: '3/4' }, { ownerId: 'current:minority', share: '1/4' }
            ] },
            { parcelId: 'cad:b', complete: true, owners: [{ ownerId: 'current:b', share: '1/1' }] }
        ] } };
        editor.state.amendInputs = [
            { parcelId: 'live:a', owners: [{ ownerKey: 'saved:a', share: 1 }] },
            { parcelId: 'live:composite', owners: [{ ownerKey: 'saved:composite', share: 1 }] }
        ];
        editor.provenance.set('live:a', ['cad:a']);
        editor.provenance.set('live:composite', ['cad:a', 'cad:b']);
        editor.featuresById.set('live:a', parcel('live:a', 100));
        editor.featuresById.set('live:composite', parcel('live:composite', 200));

        await editor.buildOwnerShares({ ids: ['live:a', 'live:composite'], source: 'fabric' });

        expect(editor.state.amendInputs[0]).toMatchObject({ cadastreParcelId: 'cad:a', owners: [
            { ownerKey: 'current:a', share: 0.75 }, { ownerKey: 'current:minority', share: 0.25 }
        ] });
        expect(editor.state.amendInputs[1]).toMatchObject({ owners: [{ ownerKey: 'saved:composite', share: 1 }] });
    });
});


describe('readjustment valuation basis', () => {
    it('uses area for the entire pool when a contribution price has an unknown or different currency', async () => {
        for (const currency of [undefined, 'USD']) {
            const editor = loadEditorOwnerIdentity();
            setParcels(editor, parcel('A', 100, { estimatedMarketPrice: 1000, estimatedMarketPriceCurrency: 'EUR' }),
                parcel('B', 300, { estimatedMarketPrice: 1000, estimatedMarketPriceCurrency: currency }));
            const shares = await editor.buildOwnerShares({ ids: ['A', 'B'] });
            expect(editor.state.contributionBasis).toBe('area');
            expect(editor.state.valuationCurrency).toBeNull();
            expect(editor.state.totalValue).toBeNull();
            expect(shares.map(entry => entry.percent).sort()).toEqual([0.25, 0.75]);
        }
    });
});
