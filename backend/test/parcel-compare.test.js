// Compare two proposals on one parcel (frontend/js/proposals/parcel-compare.js): which proposals
// touch the parcel (declared, or a site reaching in), and per proposal what it does to THIS parcel —
// whole take, edge intrusion, open ground elsewhere, readjustment plots, buildings — with missing
// measurements reported as null, never 0. A design carries no offer and asks nobody for consent (M2,
// plan-design-agreement.md): those are its agreement's.
import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let compare;

// Ground metres → lng/lat about an anchor (turf's sphere, so "2 m" is 2 m to the buffers).
const LNG0 = 15.97;
const LAT0 = 45.8;
const M_LNG = turf.distance([LNG0, LAT0], [LNG0 + 0.01, LAT0], { units: 'meters' }) / 0.01;
const M_LAT = turf.distance([LNG0, LAT0], [LNG0, LAT0 + 0.01], { units: 'meters' }) / 0.01;
const P = (x, y) => [LNG0 + x / M_LNG, LAT0 + y / M_LAT];
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)]]
});

// The owner's parcel: 40 m × 25 m = 1000 m².
const PARCEL_ID = 'HR-1-100';
const PARCEL_SOURCE = { sourceId: 'hr-dgu-oss-dkp-cestice', snapshotId: null };
const PARCEL_GEOMETRY = rect(0, 0, 40, 25);
const PARCEL = { id: PARCEL_ID, cadastreIds: [PARCEL_ID], feature: { type: 'Feature', properties: { parcelSource: PARCEL_SOURCE }, geometry: PARCEL_GEOMETRY } };

beforeAll(() => {
    globalThis.turf = turf;
    compare = require('../../frontend/js/proposals/parcel-compare.js');
});

describe('which proposals touch the parcel', () => {
    it('lists declared proposals and sites that reach in undeclared, and leaves open-ground proposals elsewhere out', () => {
        const declared = { proposalId: 'park', goal: 'park', cadastreParcelIds: [PARCEL_ID], binding: { parcelSource: PARCEL_SOURCE },
            structureProposal: { kind: 'park', geometry: rect(-5, -5, 45, 30) } };
        // A site on a neighbour that reaches 0.3 m over the shared edge, below its record's tolerance.
        const sliver = { proposalId: 'sliver', goal: 'park', cadastreParcelIds: ['HR-1-101'],
            site: rect(-20, 5, 0.3, 15) };
        const openGround = { proposalId: 'far', goal: 'park', cadastreParcelIds: [],
            site: rect(200, 200, 240, 230) };
        const list = compare.proposalsTouchingParcel(PARCEL, [openGround, sliver, declared]);
        expect(list.map(entry => [entry.proposalId, entry.relation])).toEqual([['park', 'bound'], ['sliver', 'intrudes']]);
        const sliverEntry = list.find(entry => entry.proposalId === 'sliver');
        expect(sliverEntry.intrusionM).toBeGreaterThan(0.28);
        expect(sliverEntry.intrusionM).toBeLessThan(0.32);
        expect(compare.relationOf(openGround, PARCEL)).toBeNull();
    });

    it('counts a declared proposal without geometry (overlap unknown, not zero)', () => {
        const hit = compare.relationOf({ proposalId: 'x', goal: 'single', cadastreParcelIds: [PARCEL_ID], binding: { parcelSource: PARCEL_SOURCE } }, PARCEL);
        expect(hit.relation).toBe('bound');
        expect(hit.overlapM2).toBeNull();
        expect(hit.intrusionM).toBeNull();
    });

    it('does not treat an equal raw parcel ID as the same parcel across missing or different sources', () => {
        const record = { proposalId: 'x', goal: 'single', cadastreParcelIds: [PARCEL_ID] };
        expect(compare.relationOf(record, PARCEL)).toBeNull();
        expect(compare.relationOf({ ...record, binding: { parcelSource: { sourceId: 'another-register', snapshotId: null } } }, PARCEL))
            .toBeNull();
    });
});

describe('what a proposal does to this parcel', () => {
    it('a park over the whole parcel takes it whole and cedes it to public ground', () => {
        const park = { proposalId: 'park', goal: 'park', cadastreParcelIds: [PARCEL_ID], binding: { parcelSource: PARCEL_SOURCE },
            structureProposal: { kind: 'park', geometry: rect(-5, -5, 45, 30) } };
        const effect = compare.parcelEffect(park, PARCEL);
        expect(effect.relation).toBe('bound');
        expect(effect.take.extent).toBe('whole');
        expect(effect.take.areaM2).toBeCloseTo(1000, -1);
        expect(effect.take.share).toBeCloseTo(1, 3);
        expect(effect.structure).toEqual({ kind: 'park', areaM2: expect.any(Number) });
        expect(effect.structure.areaM2).toBeCloseTo(1000, -1);
        expect(effect.buildings.count).toBe(0);
        expect(effect.ownership.destination).toBe('public');
        expect(effect.ownership.cededM2).toBeCloseTo(1000, -1);
        expect(effect.status.key).toBe('local');
    });

    it('a road along one edge takes an edge strip, with its intrusion width and corridor', () => {
        // 6 m wide road whose centreline runs 1 m outside the parcel's south edge: 2 m reach in.
        const road = { proposalId: 'road', goal: 'road-track', cadastreParcelIds: [PARCEL_ID], binding: { parcelSource: PARCEL_SOURCE },
            roadProposal: { definition: { width: 6, polygon: rect(-10, -4, 50, 2) } } };
        const effect = compare.parcelEffect(road, PARCEL);
        expect(effect.take.extent).toBe('edge');
        expect(effect.take.areaM2).toBeCloseTo(80, 0);
        expect(effect.take.share).toBeCloseTo(0.08, 2);
        expect(effect.take.intrusionM).toBeGreaterThan(1.95);
        expect(effect.take.intrusionM).toBeLessThan(2.05);
        expect(effect.corridor).toEqual({ kind: 'road', areaM2: effect.take.areaM2, widthM: 6 });
        expect(effect.status.key).toBe('local');
    });

    it('an open-ground proposal elsewhere does not touch the parcel at all', () => {
        const far = { proposalId: 'far', goal: 'park', cadastreParcelIds: [], site: rect(200, 200, 240, 230),
            structureProposal: { kind: 'park', geometry: rect(200, 200, 240, 230) } };
        const effect = compare.parcelEffect(far, PARCEL);
        expect(effect.relation).toBe('none');
        expect(effect.take).toMatchObject({ areaM2: 0, extent: 'none' });
    });

    it('maps a parcel layout onto the plots this parcel becomes, largest share first, without owners', () => {
        const layout = { proposalId: 'layout', goal: 'parcel-layout', cadastreParcelIds: [PARCEL_ID, 'HR-1-101'],
            parcelLayout: { plots: [
                { geometry: rect(-40, 0, 0, 25), area: 1000, source: 'manual' },
                { geometry: rect(0, 0, 10, 25), area: 250, source: 'manual' },
                { geometry: rect(10, 0, 40, 25), area: 750, source: 'manual' }
            ] } };
        const effect = compare.parcelEffect(layout, PARCEL);
        expect(effect.plots.map(p => p.number)).toEqual([3, 2]);
        expect(effect.plots[0]).toMatchObject({ number: 3, areaM2: 750 });
        expect(effect.plots[0]).not.toHaveProperty('owner');
        expect(effect.plots[0].overlapM2).toBeCloseTo(750, -1);
        expect(effect.plots[1]).toMatchObject({ number: 2, areaM2: 250 });
        expect(effect.take.extent).toBe('whole');
        // A layout changes borders, never ownership.
        expect(effect.ownership.destination).toBe('carry-over');
    });

    it('measures buildings on the parcel only: count, footprint, floors, floor area', () => {
        const record = { proposalId: 'block', goal: 'buildings', cadastreParcelIds: [PARCEL_ID],
            geometry: { type: 'Polygon', coordinates: rect(5, 5, 35, 20).coordinates,
                buildings: [
                    { type: 'Feature', properties: { height: 9 }, geometry: rect(5, 5, 15, 15) },    // 100 m², 3 floors
                    { type: 'Feature', properties: { height: 15 }, geometry: rect(35, 5, 45, 15) },  // half on: 50 m², 5 floors
                    { type: 'Feature', properties: { height: 30 }, geometry: rect(100, 100, 110, 110) } // elsewhere
                ] } };
        const effect = compare.parcelEffect(record, PARCEL);
        expect(effect.buildings.count).toBe(2);
        expect(effect.buildings.footprintM2).toBeCloseTo(150, 0);
        expect(effect.buildings.floorAreaM2).toBeCloseTo(100 * 3 + 50 * 5, -1);
        expect(effect.buildings.floors).toEqual({ min: 3, max: 5 });
        expect(effect.buildings.heightM).toEqual({ min: 9, max: 15 });
    });

    it('reports missing data as null, never 0', () => {
        const bare = { proposalId: 'bare', goal: 'single', cadastreParcelIds: [PARCEL_ID] };
        const effect = compare.parcelEffect(bare, PARCEL);
        expect(effect.take).toEqual({ areaM2: null, share: null, intrusionM: null, extent: null });
        expect(effect.buildings).toEqual({ count: null, footprintM2: null, floorAreaM2: null, heightM: null, floors: null });
        expect(effect.ownership).toEqual({ cededM2: null, destination: 'proposer' });
        // What a design does to the parcel, and nothing about terms or consent.
        expect(Object.keys(effect).sort()).toEqual(['buildings', 'clip', 'corridor', 'ownership', 'plots', 'proposalId', 'relation', 'status', 'structure', 'take']);

        // A building without a height: counted, footprint measured, floor area unknown.
        const noHeight = { proposalId: 'nh', goal: 'single', cadastreParcelIds: [PARCEL_ID],
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: rect(5, 5, 15, 15) }] } };
        const measured = compare.parcelEffect(noHeight, PARCEL);
        expect(measured.buildings.count).toBe(1);
        expect(measured.buildings.floorAreaM2).toBeNull();
        expect(measured.buildings.floors).toBeNull();
    });

    it('reads the status from the record and gives a declared design without a drawing an unknown take', () => {
        const record = { proposalId: 'offer', goal: 'as-is', cadastreParcelIds: [PARCEL_ID, 'HR-1-101'], binding: { parcelSource: PARCEL_SOURCE },
            offer: 200000, offerCurrency: 'EUR', acceptedParcelIds: [PARCEL_ID],
            ownerAcceptances: { [PARCEL_ID]: { ownerOrder: ['a', 'b'], acceptedOwnerKeys: ['b'] } } };
        const effect = compare.parcelEffect(record, PARCEL, { areaShare: 0.25, channel: 'offer', consent: { owners: { accepted: 1, total: 2 } } });
        expect(effect.relation).toBe('bound');
        // The record's own state, a local draft: nothing of the offer or consent it is compared under.
        expect(effect.status).toEqual({ key: 'local', lifecycle: 'unknown', applied: false });
        // Its site is never the union of its parcels (site-binding.js siteOf): the take is unknown.
        expect(effect.take).toEqual({ areaM2: null, share: null, intrusionM: null, extent: null });
        expect(effect.ownership).toBeNull();
        expect(effect).not.toHaveProperty('offer');
        expect(effect).not.toHaveProperty('consent');
    });

    it('uses canonical lifecycle and publication evidence without legacy aliases or inferred execution', () => {
        const base = { proposalId: 'status', goal: 'as-is', cadastreParcelIds: [PARCEL_ID] };
        const status = (fields, options) => compare.parcelEffect({ ...base, ...fields }, PARCEL, options).status;
        expect(status({ status: 'Executed', server_proposal_id: 17 })).toMatchObject({ key: 'local', lifecycle: 'unknown' });
        expect(status({ lifecycleStatus: 'Active', status: 'Executed' }, { lifecycleKey: 'executed' }))
            .toMatchObject({ key: 'local', lifecycle: 'active' });
        // A server row id says nothing about publication (M2): a design is published by its CID.
        for (const serverProposalId of [0, -1, 'x', true, '01', '17']) {
            expect(status({ serverProposalId }).key).toBe('local');
        }
        const cid = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
        const previous = globalThis.DesignSync;
        globalThis.DesignSync = { publishedCid: record => (record.published && record.published.cid) || null };
        try {
            expect(status({ published: { cid, apiBase: 'https://api.example.test' } }).key).toBe('published');
            expect(status({}).key).toBe('local');
        } finally {
            if (previous === undefined) delete globalThis.DesignSync;
            else globalThis.DesignSync = previous;
        }
        expect(status({ lifecycleStatus: 'Executed' })).toMatchObject({ key: 'execution-unverified', lifecycle: 'executed' });
        const evidence = require('../../frontend/js/proposals/lifecycle-evidence.js').projectLifecycleEvidence({
            lifecycleStatus: 'Executed',
            chainRead: {
                status: 'Executed', observedAt: '2026-10-20T10:04:00.000Z',
                chainRef: { chainType: 'solana', chainId: 'solana-devnet', contract: 'program', tokenId: 'account' }
            }
        });
        expect(status(evidence)).toMatchObject({ key: 'executed', lifecycle: 'executed' });
        expect(status({ lifecycleStatus: 'Cancelled', applied: true }, { applied: true }))
            .toMatchObject({ key: 'local', lifecycle: 'cancelled', applied: false });
    });
});

describe('preview', () => {
    it('draws the parcel and each clipped footprint in one SVG', () => {
        const svg = compare.previewSvg(PARCEL_GEOMETRY, [
            { geometry: rect(0, 0, 40, 2), className: 'pc-a' },
            { geometry: null, className: 'pc-missing' }
        ], { label: 'Parcel "1"' });
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg).toContain('class="pc-a"');
        expect(svg).not.toContain('pc-missing');
        expect(svg).toContain('aria-label="Parcel &quot;1&quot;"');
        expect(compare.previewSvg(null, [])).toBe('');
    });
});
