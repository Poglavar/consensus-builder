// Unit tests for frontend/js/agreement-ground.js: an agreement's inputs and outputs derived from a
// fake live fabric, the current/stale check of a stored agreement (its designs named by CID), and the
// holders the local owner records name, joint pools included.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const ground = require('../../frontend/js/agreement-ground.js');
const record = require('../../frontend/js/agreement-record.js');
const approval = require('../../frontend/js/proposals/approval.js');
const openGround = require('../../frontend/js/proposals/open-ground.js');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const Cid = require('../../frontend/js/cid.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

// Rectangles in units of 1e-3 degree from the test origin (≈ 78 m east, 111 m north).
function rect(x0, y0, x1, y1) {
    const LON = 15.96, LAT = 45.8;
    const at = (x, y) => [LON + x * 1e-3, LAT + y * 1e-3];
    return { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}
const piece = (parcelId, geometry, properties = {}) => ({ type: 'Feature', properties: { parcelId, ...properties }, geometry });
const clone = value => JSON.parse(JSON.stringify(value));

// The fabric's two reads, over a list of pieces. entriesForCadastre answers once per matching
// cadastral id, so a piece anchored to two inputs comes back twice, and leaves corridors out
// unless asked for them.
function fakeFabric(pieces) {
    return {
        producedBy: proposalId => pieces.filter(p => p.properties.producedByProposalId === proposalId).map(clone),
        list: () => pieces.map(clone),
        entriesForCadastre: (ids, query = {}) => Array.from(ids)
            .flatMap(id => pieces.filter(p => (p.properties.cadastreParcelIds || []).includes(id)))
            .filter(p => query.includeCorridors === true || p.properties.isCorridor !== true)
            .map(clone)
    };
}

// A layout split k9 into two plots and left k10 untouched; a road body runs across both; k11 is
// someone else's parcel nearby.
function pieces() {
    const plot = (id, geometry) => piece(id, geometry, {
        cadastreParcelIds: ['k9'], producedByProposalId: 'layout-1', formedByProposalIds: ['layout-1'],
        readjustmentPiece: { role: 'plot', plotFingerprint: `layout-plot1-sha256:${id}` }
    });
    return [
        plot('k9-p1', rect(0, 0, 1, 2)),
        plot('k9-p2', rect(1, 0, 3, 2)),
        piece('k10', rect(3, 0, 5, 2), { cadastreParcelIds: ['k10'] }),
        piece('road-1#1', rect(0, 2, 5, 2.2), { cadastreParcelIds: ['k10', 'k9'], producedByProposalId: 'road-1', formedByProposalIds: ['road-1'], isCorridor: true }),
        piece('k11', rect(6, 0, 7, 2), { cadastreParcelIds: ['k11'] })
    ];
}
const originals = new Map([
    ['k9', piece('k9', rect(0, 0, 3, 2))],
    ['k10', piece('k10', rect(3, 0, 5, 2))],
    ['k11', piece('k11', rect(6, 0, 7, 2))]
]);
// The layout declares k9 (padded and repeated); the road declares nothing and reaches k10 only
// through the body it produced.
const designs = () => [
    { proposalId: 'layout-1', goal: 'parcel-layout', cadastreParcelIds: [' k9 ', 'k9'], parcelLayout: { algorithm: 'equal' } },
    { proposalId: 'road-1', goal: 'road', cadastreParcelIds: [] }
];
const ana = { ownerKey: 'agent-ana', displayName: 'Ana', share: 1 };
const boris = { ownerKey: 'agent-boris', displayName: 'Boris', share: 1 };
const holders = { k9: [ana], k10: [boris], 'k9-p1': [ana], 'k9-p2': [ana] };
const ownerOf = id => holders[id] || [];
const area = feature => turf.area(feature);

describe('derive', () => {
    it('keeps the source commitment of an unchanged one-part MultiPolygon after the fabric connects it', async () => {
        const polygon = rect(0, 0, 3, 2);
        const source = piece('k9', { type: 'MultiPolygon', coordinates: [polygon.coordinates] });
        const fabric = createLiveParcelFabric();
        const mutation = fabric.beginMutation({ kind: 'seed' });
        mutation.seedCadastre([source]);
        await mutation.prepare();
        mutation.publish();
        expect(fabric.get('k9').geometry.type).toBe('Polygon');

        const design = { proposalId: 'building-1', cadastreParcelIds: ['k9'] };
        const context = { designs: [design], fabric, originals: new Map([['k9', source]]), ownerOf, area };
        const derived = ground.derive(context);
        expect(derived.outputs[0]).toMatchObject({ hash: record.outputHash(source.geometry), role: 'parcel', geometry: source.geometry });
        const stored = { ...derived, designs: [{ proposalId: design.proposalId, cid: 'unchanged-design' }] };
        const checkContext = { ...context, designOf: () => design, isApplied: () => true, fingerprintOf: () => 'unchanged-design' };
        expect(ground.check(stored, checkContext)).toEqual({ current: true, reasons: [] });

        const moved = fabric.get('k9');
        moved.geometry.coordinates[0][2][0] += 1e-5;
        expect(ground.check(stored, { ...checkContext, fabric: fakeFabric([moved]) }))
            .toEqual({ current: false, reasons: [{ code: 'ground-changed' }] });
    });

    it('does not substitute source geometry for designed or split pieces', () => {
        const polygon = rect(0, 0, 3, 2);
        const originals = new Map([['k9', piece('k9', { type: 'MultiPolygon', coordinates: [polygon.coordinates] })]]);
        for (const properties of [{ producedByProposalId: 'design-1' }, { cadastralPart: true }]) {
            const fabric = fakeFabric([piece('k9', polygon, { cadastreParcelIds: ['k9'], ...properties })]);
            const { outputs } = ground.derive({ designs: [{ proposalId: 'design-1', cadastreParcelIds: ['k9'] }], fabric, originals, ownerOf, area });
            expect(outputs[0].hash).toBe(record.outputHash(polygon));
            expect(outputs[0].geometry).toEqual(polygon);
        }
    });

    it('commits geographic areas deterministically without native trigonometry', () => {
        const feature = piece('k9', rect(0, 0, 3, 2));
        expect(ground.areaOf(feature)).toBeCloseTo(turf.area(feature), 4);
        const native = Math.sin;
        try {
            Math.sin = () => { throw new Error('Native sine must not determine agreement identity'); };
            const measured = ground.areaOf(feature);
            expect(Number.isFinite(measured)).toBe(true);
            expect(measured * 1e6).toBeCloseTo(Math.round(measured * 1e6), 0);
        } finally { Math.sin = native; }
    });
    it('takes each design\'s declared parcels and the anchors of what it produced, in numeric order', () => {
        const { inputs } = ground.derive({ designs: designs(), fabric: fakeFabric(pieces()), originals, ownerOf, area });
        expect(inputs.parcels.map(parcel => parcel.parcelId)).toEqual(['k9', 'k10']);
        expect(inputs.parcels[0].areaM2).toBeCloseTo(turf.area(originals.get('k9')), 6);
        expect(inputs.parcels[1].areaM2).toBeCloseTo(turf.area(originals.get('k10')), 6);
        expect(inputs.parcels.map(parcel => parcel.holders)).toEqual([[ana], [boris]]);
        expect(inputs.openGroundM2).toBe(0);
    });

    it('measures partial-binding open ground from the host geometry and includes its produced piece once', () => {
        const original = piece('k9', rect(0, 0, 5, 10));
        const cadastralBody = piece('body-cadastre', rect(0, 0, 5, 10), {
            cadastreParcelIds: ['k9'], groundIds: ['ground:site-hash'], producedByProposalId: 'building-1'
        });
        const groundBody = piece('body-ground', rect(5, 0, 10, 10), {
            groundIds: ['ground:site-hash'], producedByProposalId: 'building-1'
        });
        const fabric = fakeFabric([cadastralBody, groundBody]);
        const design = {
            proposalId: 'building-1', cadastreParcelIds: ['k9'], site: rect(0, 0, 10, 10),
            binding: { coverage: 'partial', unsurveyedM2: 1 }
        };
        const { inputs, outputs } = ground.derive({ designs: [design], fabric,
            originals: new Map([['k9', original]]), ownerOf, area, openGround, siteBinding, turf });
        const expectedOpen = turf.area(turf.feature(rect(5, 0, 10, 10)));
        expect(inputs.openGroundM2).toBeCloseTo(expectedOpen, 3);
        expect(inputs.openGroundM2).not.toBe(1); // never turn binding.unsurveyedM2 into geometry
        expect(outputs.map(output => output.pieceId).sort()).toEqual(['body-cadastre', 'body-ground']);
    });

    it('deduplicates shared ground outputs and includes surviving ground descendants', () => {
        const original = piece('k9', rect(0, 0, 5, 10));
        const shared = piece('shared-ground', rect(5, 0, 7, 10), {
            groundIds: ['ground:site-hash'], producedByProposalId: 'design-1'
        });
        const remainder = piece('ground-remainder', rect(7, 0, 10, 10), {
            groundIds: ['ground:site-hash']
        });
        const fabric = fakeFabric([shared, remainder]);
        fabric.producedBy = id => (id === 'design-1' || id === 'design-2') ? [clone(shared)] : [];
        const design = id => ({ proposalId: id, cadastreParcelIds: ['k9'], site: rect(0, 0, 10, 10),
            binding: { coverage: 'partial', unsurveyedM2: 1 } });
        const { inputs, outputs } = ground.derive({ designs: [design('design-1'), design('design-2')], fabric,
            originals: new Map([['k9', original]]), ownerOf, area, openGround, siteBinding, turf });
        expect(inputs.openGroundM2).toBeCloseTo(turf.area(turf.feature(rect(5, 0, 10, 10))), 3);
        expect(outputs.map(output => output.pieceId).sort()).toEqual(['ground-remainder', 'shared-ground']);
    });

    it('refuses partial-site ground observations when original parcel geometry is unavailable', () => {
        const body = piece('body-ground', rect(5, 0, 10, 10), {
            groundIds: ['ground:site-hash'], producedByProposalId: 'building-1'
        });
        const design = { proposalId: 'building-1', cadastreParcelIds: ['k9'], site: rect(0, 0, 10, 10),
            binding: { coverage: 'partial', unsurveyedM2: 1000 } };
        expect(() => ground.derive({ designs: [design], fabric: fakeFabric([body]), originals: new Map(), ownerOf, area,
            openGround, siteBinding, turf })).toThrow(/original parcel geometry is missing/);
    });

    it('refuses ground provenance when the geometry services are unavailable', () => {
        const body = piece('body-ground', rect(5, 0, 10, 10), {
            groundIds: ['ground:site-hash'], producedByProposalId: 'building-1'
        });
        const design = { proposalId: 'building-1', cadastreParcelIds: ['k9'], site: rect(0, 0, 10, 10),
            binding: { coverage: 'partial', unsurveyedM2: 1000 } };
        expect(() => ground.derive({ designs: [design], fabric: fakeFabric([body]),
            originals: new Map([['k9', piece('k9', rect(0, 0, 5, 10))]]), ownerOf, area,
            openGround: {}, siteBinding, turf })).toThrow(/without its geometry services/);
    });

    it('includes a transient host as an unchanged output when no parcels were formed on it', () => {
        const original = piece('k9', rect(0, 0, 5, 10));
        const fabric = fakeFabric([piece('k9', original.geometry, { cadastreParcelIds: ['k9'] })]);
        const design = { proposalId: 'multi-building', cadastreParcelIds: ['k9'], site: rect(0, 0, 10, 10),
            binding: { coverage: 'partial', unsurveyedM2: 1 } };
        const { inputs, outputs } = ground.derive({ designs: [design], fabric,
            originals: new Map([['k9', original]]), ownerOf, area, openGround, siteBinding, turf });
        expect(inputs.openGroundM2).toBeCloseTo(turf.area(turf.feature(rect(5, 0, 10, 10))), 3);
        const host = outputs.find(output => output.pieceId.startsWith('open-ground:'));
        expect(host).toMatchObject({ role: 'parcel', fromParcelIds: [], producedBy: null, holders: [] });
        expect(host.geometry).toEqual(rect(5, 0, 10, 10));
        expect(host.hash).toBe(record.outputHash(host.geometry));
    });

    it('unions overlapping partial-site hosts instead of counting them twice', () => {
        const original = piece('k9', rect(0, 0, 5, 10));
        const fabric = fakeFabric([piece('k9', original.geometry, { cadastreParcelIds: ['k9'] })]);
        const design = id => ({ proposalId: id, cadastreParcelIds: ['k9'], site: rect(0, 0, 10, 10),
            binding: { coverage: 'partial', unsurveyedM2: 1 } });
        const { inputs, outputs } = ground.derive({ designs: [design('first'), design('second')], fabric,
            originals: new Map([['k9', original]]), ownerOf, area, openGround, siteBinding, turf });
        expect(inputs.openGroundM2).toBeCloseTo(turf.area(turf.feature(rect(5, 0, 10, 10))), 3);
        expect(outputs.filter(output => output.pieceId.startsWith('open-ground:'))).toHaveLength(1);
    });

    it('reads every piece on the input land, corridors included, once each, sorted by parcels then area', () => {
        const { outputs } = ground.derive({ designs: designs(), fabric: fakeFabric(pieces()), originals, ownerOf, area });
        expect(outputs.map(output => output.pieceId)).toEqual(['k9-p2', 'k9-p1', 'road-1#1', 'k10']);
        expect(outputs.map(output => output.role)).toEqual(['plot', 'plot', 'corridor', 'parcel']);
        expect(outputs.map(output => output.producedBy)).toEqual(['layout-1', 'layout-1', 'road-1', null]);
        expect(outputs.map(output => output.fromParcelIds)).toEqual([['k9'], ['k9'], ['k9', 'k10'], ['k10']]);
        expect(outputs.map(output => output.holders)).toEqual([[ana], [ana], [], [boris]]);
        const byId = new Map(pieces().map(p => [p.properties.parcelId, p]));
        outputs.forEach(output => {
            expect(output.geometry).toEqual(byId.get(output.pieceId).geometry);
            expect(output.hash).toBe(record.outputHash(byId.get(output.pieceId).geometry));
            expect(output.areaM2).toBeCloseTo(turf.area(byId.get(output.pieceId)), 6);
        });
        expect(outputs[0].areaM2).toBeGreaterThan(outputs[1].areaM2);
    });

    it('names roles by the layout first, then corridor, split part and whole parcel', () => {
        const fabric = fakeFabric([
            piece('rest', rect(0, 0, 1, 1), { cadastreParcelIds: ['k9'], readjustmentPiece: { role: 'remainder' }, isCorridor: true }),
            piece('track', rect(1, 0, 2, 1), { cadastreParcelIds: ['k9'], isTrack: true }),
            piece('part', rect(2, 0, 3, 1), { cadastreParcelIds: ['k9'], cadastralPart: true }),
            piece('other', rect(3, 0, 4, 1), { cadastreParcelIds: ['k9'], readjustmentPiece: { role: 'courtyard' }, cadastralPart: true })
        ]);
        const { outputs } = ground.derive({ designs: [{ proposalId: 'layout-1', cadastreParcelIds: ['k9'] }], fabric, originals, ownerOf, area });
        expect(Object.fromEntries(outputs.map(output => [output.pieceId, output.role])))
            .toEqual({ rest: 'remainder', track: 'corridor', part: 'part', other: 'part' });
    });

    it('leaves the area of an input without its original cadastral feature unknown', () => {
        const { inputs } = ground.derive({ designs: [{ proposalId: 'road-2', cadastreParcelIds: ['k12', 'k9'] }], fabric: fakeFabric([]), originals, ownerOf, area });
        expect(inputs.parcels).toEqual([
            { parcelId: 'k9', areaM2: expect.any(Number), holders: [ana] },
            { parcelId: 'k12', areaM2: null, holders: [] }
        ]);
        expect(inputs.openGroundM2).toBe(0);
    });

    it('produces the land of a record that normalizes and validates', () => {
        const derived = ground.derive({ designs: designs(), fabric: fakeFabric(pieces()), originals, ownerOf, area });
        const agreement = {
            schema: record.SCHEMA, id: record.newId(),
            designs: designs().map(design => ({ proposalId: design.proposalId, goal: design.goal, cid: Cid.cidOfObject({ design: design.proposalId }) })),
            ...derived,
            money: { currency: 'EUR', lines: [] },
            rule: { electorate: 'owners', binding: true, lens: ['lens-member-1'],
                approvalConfig: { schema: 'proposal-approval/v1', rights: record.rightsFromInputs(derived.inputs), policy: { type: 'unanimous' } } }
        };
        const result = record.validate(agreement);
        expect(result.valid).toBe(true);
        expect(result.warnings.map(warning => warning.code)).toEqual([]);
        expect(record.normalize(agreement).outputs.map(output => output.hash)).toEqual(derived.outputs.map(output => output.hash));
    });
});

describe('check', () => {
    // The panel passes DesignRecord.cidOf; any content identity that moves with the design will do.
    const fingerprintOf = design => Cid.cidOfObject({ design: design.proposalId, version: design.version || 1 });
    function storedAgreement() {
        const derived = ground.derive({ designs: designs(), fabric: fakeFabric(pieces()), originals, ownerOf, area });
        return {
            schema: record.SCHEMA, id: 'ag-1',
            designs: designs().map(design => ({ proposalId: design.proposalId, title: null, goal: design.goal, cid: fingerprintOf(design) })),
            ...derived,
            allocations: [], money: { currency: 'EUR', lines: [] },
            rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null
        };
    }
    function context(overrides = {}) {
        const byId = new Map(designs().map(design => [design.proposalId, design]));
        return { designOf: id => byId.get(id) || null, isApplied: () => true, fingerprintOf, fabric: fakeFabric(pieces()), originals, ownerOf, area, ...overrides };
    }
    // A fabric that must not be read: the ground is derived again only when every design is there.
    const untouchable = {
        producedBy: () => { throw new Error('the ground was derived again'); },
        entriesForCadastre: () => { throw new Error('the ground was derived again'); }
    };

    it('is current while the designs and the ground are as stored', () => {
        expect(ground.check(storedAgreement(), context())).toEqual({ current: true, reasons: [] });
    });

    it('reports a design whose content changed', () => {
        const changed = { ...designs()[0], version: 2 };
        const result = ground.check(storedAgreement(), context({ designOf: id => id === 'layout-1' ? changed : designs()[1] }));
        expect(result).toEqual({ current: false, reasons: [{ code: 'design-changed', proposalId: 'layout-1' }] });
    });

    it('compares each design with the CID its entry stores, not with any other field', () => {
        const stored = storedAgreement();
        stored.designs[1] = { ...stored.designs[1], cid: Cid.cidOfObject({ design: 'road-1', version: 7 }), fingerprint: fingerprintOf(designs()[1]) };
        expect(ground.check(stored, context())).toEqual({ current: false, reasons: [{ code: 'design-changed', proposalId: 'road-1' }] });
        const unnamed = storedAgreement();
        delete unnamed.designs[0].cid;
        expect(ground.check(unnamed, context()).reasons).toEqual([{ code: 'design-changed', proposalId: 'layout-1' }]);
    });

    it('reports changed ground when the output pieces differ', () => {
        const moved = pieces();
        moved[1].geometry.coordinates[0][2][0] += 1e-5;
        expect(ground.check(storedAgreement(), context({ fabric: fakeFabric(moved) })))
            .toEqual({ current: false, reasons: [{ code: 'ground-changed' }] });

        const merged = pieces().filter(p => p.properties.parcelId !== 'k9-p1');
        merged[0].geometry = rect(0, 0, 3, 2);
        expect(ground.check(storedAgreement(), context({ fabric: fakeFabric(merged) })).reasons).toEqual([{ code: 'ground-changed' }]);
    });

    it('reports changed ground when the input parcels differ', () => {
        // k12 has no piece in the fabric, so only the input ids move.
        const wider = { ...designs()[0], cadastreParcelIds: ['k9', 'k12'] };
        const result = ground.check(storedAgreement(), context({ designOf: id => id === 'layout-1' ? wider : designs()[1] }));
        expect(result.reasons).toEqual([{ code: 'ground-changed' }]);
    });

    it('reports a missing or unapplied design without deriving the ground again', () => {
        const missing = ground.check(storedAgreement(), context({ designOf: id => id === 'road-1' ? null : designs()[0], fabric: untouchable }));
        expect(missing).toEqual({ current: false, reasons: [{ code: 'design-missing', proposalId: 'road-1' }] });
        const unapplied = ground.check(storedAgreement(), context({ isApplied: design => design.proposalId !== 'layout-1', fabric: untouchable }));
        expect(unapplied).toEqual({ current: false, reasons: [{ code: 'design-not-applied', proposalId: 'layout-1' }] });
    });
});

describe('localHolders', () => {
    const owners = {
        parcel_k9_owner: 'agent-ana',
        parcel_k10_owner: 'agent_joint_pool_7',
        parcel_k12_owner: 'agent-ghost'
    };
    const storage = { getItem: key => Object.prototype.hasOwnProperty.call(owners, key) ? owners[key] : null };
    const agentsById = {
        'agent-ana': { id: 'agent-ana', name: 'Ana' },
        agent_joint_pool_7: {
            id: 'agent_joint_pool_7', name: 'Boris / Cyril', jointPool: true,
            members: [{ agentId: 'agent-boris', name: 'Boris', share: 0.25 }, { agentId: 'agent-cyril', name: 'Cyril', share: 0.75 }]
        }
    };
    const agents = { getAgent: id => agentsById[id] || null };

    it('names an owner, expands a joint pool into its members and leaves unowned parcels empty', () => {
        const lookup = ground.localHolders({ storage, agents });
        expect(lookup('k9')).toEqual([{ ownerKey: 'agent-ana', displayName: 'Ana', share: 1 }]);
        expect(lookup('k10')).toEqual([
            { ownerKey: 'agent-boris', displayName: 'Boris', share: 0.25 },
            { ownerKey: 'agent-cyril', displayName: 'Cyril', share: 0.75 }
        ]);
        expect(lookup('k11')).toEqual([]);
        expect(lookup('k12')).toEqual([{ ownerKey: 'agent-ghost', displayName: 'agent-ghost', share: 1 }]);
    });

    it('feeds a rights snapshot in which the pool members are the owners', () => {
        const { inputs } = ground.derive({ designs: designs(), fabric: fakeFabric(pieces()), originals, ownerOf: ground.localHolders({ storage, agents }), area });
        const rights = record.rightsFromInputs(inputs);
        expect(rights.parcels.map(parcel => parcel.owners)).toEqual([
            [{ ownerId: 'agent-ana', share: '10000/10000' }],
            [{ ownerId: 'agent-boris', share: '2500/10000' }, { ownerId: 'agent-cyril', share: '7500/10000' }]
        ]);
        const state = approval.inspect({ cadastreParcelIds: ['k9', 'k10'], approvalConfig: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } } });
        expect(state).toMatchObject({ ready: true, ownerIds: ['agent-ana', 'agent-boris', 'agent-cyril'] });
    });
});
