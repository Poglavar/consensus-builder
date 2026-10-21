// The strict land rule on the server, generalised (PARCEL-OPTIONAL.md): cadastreParcelIds must EQUAL
// the PostGIS binding of the proposal's site — missing and extra parcels are refused separately; an
// empty declaration is allowed for a material proposal with a site; parcel acts still need parcels.
// Covers the shared footprint builder and checkProposalBinding against a scripted cadastre.
// The SQL itself is run against a real database in proposal-binding-db.test.js (RUN_DB_TESTS=1).
import { describe, expect, it } from 'vitest';
import {
    MAX_FOOTPRINT_VERTICES,
    footprintParts,
    footprintQueryParams,
    proposalGeometryView
} from '../proposals/footprint.js';
import {
    BINDING_COUNT_SQL,
    BINDING_SQL,
    FOOTPRINT_OUTSIDE_SITE_SQL,
    INTRUSION_NOISE_M,
    MAX_BINDING_PARCELS,
    MAX_SITE_VERTICES,
    PARCEL_ACT_SITE_SQL,
    checkProposalBinding,
    computeBinding,
    parseHrParcelId,
    parseTolerance,
    validateSiteGeometry
} from '../proposals/binding.js';
import { validProposalBody } from './helpers/fixtures.js';

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const PARK = box(15.97, 45.80, 15.971, 45.801);
const SITE = box(15.969, 45.799, 15.972, 45.802);
const SITE_JSON = JSON.stringify({ type: 'MultiPolygon', coordinates: [SITE.coordinates] });

describe('footprintParts (shared by browser, API and migration)', () => {
    it('takes each typology\'s authored geometry', () => {
        expect(footprintParts({ structureProposal: { geometry: PARK } }).sources).toEqual(['structureProposal.geometry']);
        expect(footprintParts({ geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: PARK }] } }).sources)
            .toEqual(['geometry.buildings']);
        expect(footprintParts({ roadProposal: { definition: { polygon: PARK } } }).sources)
            .toEqual(['roadProposal.definition.polygon']);
        const plan = footprintParts({
            parcelLayout: { pool: box(15.97, 45.80, 15.972, 45.801), plots: [{ geometry: PARK, source: 'manual' }, { geometry: box(15.971, 45.80, 15.972, 45.801), source: 'manual' }] },
            geometry: box(0, 0, 1, 1)
        });
        // A parcel layout's plots are its footprint; proposal.geometry on it is ignored.
        expect(plan.polygons).toHaveLength(2);
        expect(plan.sources).toEqual(['parcelLayout.plots']);
        expect(plan.approximate).toBe(false);
    });

    it('refuses a centre line without its land unless the record is a flagged legacy record', () => {
        const parts = footprintParts({ roadProposal: { definition: {
            width: 12,
            points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }]
        } } });
        expect(parts.invalid).toMatch(/no corridor land: its corridor polygon has not been built/);
        expect(parts.invalid).not.toMatch(/prepare/);
        expect(parts.corridorUnprepared).toBe(true);
        expect(parts.centerline).toBeNull();
        // A client cannot opt a NEW design into the approximate path: the design index refuses a
        // flagged centre line without land (routes/designs.js prepareDesign), so only stored legacy
        // rows are read from their centre line.
    });

    it('marks a flagged legacy road stored without its corridor polygon as an approximate centreline footprint', () => {
        const parts = footprintParts({ roadProposal: { definition: {
            width: 12,
            points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }],
            constructionFrame: { kind: 'legacy-centreline' }
        } } });
        expect(parts.approximate).toBe(true);
        expect(parts.polygons).toEqual([]);
        expect(parts.centerline.halfWidthM).toBe(6);
        expect(parts.centerline.segments).toEqual([[[15.97, 45.8], [15.971, 45.801]]]);
        const [, lines] = footprintQueryParams(parts);
        expect(JSON.parse(lines)).toEqual([{ line: { type: 'LineString', coordinates: [[15.97, 45.8], [15.971, 45.801]] }, halfWidthM: 6 }]);
    });

    it('reports malformed coordinates and over-large footprints instead of passing them to PostGIS', () => {
        expect(footprintParts({ structureProposal: { geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 'x']]] } } }).invalid)
            .toMatch(/structureProposal.geometry is not a valid/);
        const ring = Array.from({ length: MAX_FOOTPRINT_VERTICES + 1 }, (_, i) => [15 + i * 1e-7, 45]);
        ring.push(ring[0]);
        expect(footprintParts({ structureProposal: { geometry: { type: 'Polygon', coordinates: [ring] } } }).invalid)
            .toMatch(/vertices \(limit/);
    });

    it('reads sub-proposals from their columns first, like the serializer', () => {
        const view = proposalGeometryView({
            structure_proposal: { geometry: PARK },
            proposal_data: { structureProposal: { geometry: box(0, 0, 1, 1) }, title: 'x' }
        });
        expect(view.structureProposal.geometry).toBe(PARK);
        expect(view.title).toBe('x');
    });
});


// A scripted cadastre: answers the binding statements by identity and records them.
function cadastre({ count = 2, parcels = [], inRegion = true, unsurveyedM2 = 0, unknownM2 = 0, outsideM2 = 0, found = null } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === BINDING_COUNT_SQL) return { rows: [{ parcels: count }] };
            if (sql === FOOTPRINT_OUTSIDE_SITE_SQL) return { rows: [{ outside_m2: outsideM2 }] };
            if (sql === BINDING_SQL) {
                return { rows: [{ parcels, site_m2: 9000, in_region: inRegion, unsurveyed_m2: unsurveyedM2, unknown_m2: unknownM2, site_geojson: SITE_JSON }] };
            }
            if (sql === PARCEL_ACT_SITE_SQL) {
                const ids = JSON.parse(params[0]).map(entry => entry.id).filter(id => !found || found.includes(id));
                return { rows: [{ parcels: ids.map(id => ({ parcelId: id, overlapM2: 400 })), site_geojson: ids.length ? SITE_JSON : null, site_m2: 400 * ids.length }] };
            }
            throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
        }
    };
}
const hit = (parcelId, intrusionM, bound = true, overlapM2 = 50) => ({ parcelId, overlapM2, intrusionM, bound });
const SPILL = [hit('HR-335649-100', 40.2), hit('HR-335649-101', 0.42), hit('HR-335649-102', 0.0004, false, 0.01)];

describe('site and tolerance validation', () => {
    it('accepts a WGS84 Polygon/MultiPolygon and refuses everything else with a reason', () => {
        expect(validateSiteGeometry(PARK)).toBeNull();
        expect(validateSiteGeometry({ type: 'Feature', geometry: PARK })).toBeNull();
        expect(validateSiteGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toMatch(/Polygon or MultiPolygon/);
        expect(validateSiteGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toMatch(/at least 4/);
        expect(validateSiteGeometry(box(200, 0, 201, 1))).toMatch(/out of WGS84 range/);
        expect(validateSiteGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [1, 1], [0, 0]]] })).toMatch(/finite/);
        expect(validateSiteGeometry(box(15, 45, 16, 46))).toMatch(/exceeds 500 km²/);
        const ring = Array.from({ length: MAX_SITE_VERTICES + 1 }, (_, i) => [15 + i * 1e-8, 45 + (i % 2) * 1e-8]);
        ring.push(ring[0]);
        expect(validateSiteGeometry({ type: 'Polygon', coordinates: [ring] })).toMatch(/vertices/);
    });

    it('takes a tolerance of 0..1 m, default 0', () => {
        expect(parseTolerance(undefined)).toEqual({ ok: true, value: 0 });
        expect(parseTolerance(0.05)).toEqual({ ok: true, value: 0.05 });
        expect(parseTolerance(-1).ok).toBe(false);
        expect(parseTolerance(1.5).ok).toBe(false);
        expect(parseTolerance('0.1').ok).toBe(false);
    });

    it('parses only HR cadastral ids', () => {
        expect(parseHrParcelId('HR-335649-1021/3')).toEqual({ id: 'HR-335649-1021/3', ko: 335649, number: '1021/3' });
        expect(parseHrParcelId('BG-1-2')).toBeNull();
    });
});

describe('computeBinding', () => {
    it('splits bound from touched, passes the linear floor to SQL and measures coverage', async () => {
        const db = cadastre({ parcels: SPILL });
        const { binding, site } = await computeBinding(db, { site: SITE, toleranceM: 0 });
        expect(db.calls.map(call => call.sql)).toEqual([BINDING_COUNT_SQL, BINDING_SQL]);
        expect(db.calls[1].params[2]).toBe(INTRUSION_NOISE_M); // max(0, noise)
        expect(binding.parcels.map(p => p.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        expect(binding.touched.map(p => p.parcelId)).toEqual(['HR-335649-102']);
        expect(binding).toMatchObject({ coverage: 'complete', toleranceM: 0, source: 'server:hr-cadastre',
            parcelSource: { sourceId: 'hr-cadastre', snapshotId: null } });
        expect(site.type).toBe('MultiPolygon');

        const atTol = cadastre({ parcels: SPILL });
        await computeBinding(atTol, { site: SITE, toleranceM: 0.05 });
        expect(atTol.calls[1].params[2]).toBe(0.05);
    });

    it('is partial when open ground (or ground outside the cadastre) survives the floor', async () => {
        expect((await computeBinding(cadastre({ parcels: SPILL, unsurveyedM2: 12.5 }), { site: SITE })).binding)
            .toMatchObject({ coverage: 'partial', unsurveyedM2: 12.5, unknownM2: 0 });
        expect((await computeBinding(cadastre({ parcels: SPILL, unknownM2: 3 }), { site: SITE })).binding)
            .toMatchObject({ coverage: 'partial', unknownM2: 3 });
        // Surveyed region, nothing under the site: partial and all of it unsurveyed.
        expect((await computeBinding(cadastre({ parcels: [], unsurveyedM2: 9000 }), { site: SITE })).binding)
            .toMatchObject({ coverage: 'partial', parcels: [], unsurveyedM2: 9000 });
    });

    it('says unknown outside the cadastre it holds, and none only for a city with no cadastre', async () => {
        const unknown = (await computeBinding(cadastre({ inRegion: false }), { site: SITE, city: 'unconfigured_city' })).binding;
        expect(unknown).toMatchObject({ coverage: 'unknown', parcels: [], unknownM2: 9000, unsurveyedM2: 0,
            source: 'server:unbound', parcelSource: null });
        expect(unknown.reason).toMatch(/cannot be bound/);
        const none = (await computeBinding(cadastre({ inRegion: false }), { site: SITE, city: 'explore' })).binding;
        expect(none).toMatchObject({ coverage: 'none', parcels: [], unsurveyedM2: 9000,
            source: 'server:unbound', parcelSource: null });
    });

    it('refuses a site over the parcel cap before the expensive statement', async () => {
        const db = cadastre({ count: MAX_BINDING_PARCELS + 1 });
        await expect(computeBinding(db, { site: SITE })).rejects.toMatchObject({ code: 'too-many-parcels', status: 413 });
        expect(db.calls.map(call => call.sql)).toEqual([BINDING_COUNT_SQL]);
    });
});

describe('checkProposalBinding (declared == binding)', () => {
    const park = { goal: 'park', structureProposal: { kind: 'park', geometry: PARK } };

    it('accepts exactly the bound parcels, in any order', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park, ['HR-335649-101', 'HR-335649-100']);
        expect(result.ok).toBe(true);
        expect(result.binding.parcels).toHaveLength(2);
    });

    it('refuses bound parcels missing from the declaration (undeclared-parcels) with their intrusion', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park, ['HR-335649-100']);
        expect(result).toMatchObject({ ok: false, status: 400, code: 'undeclared-parcels', extra: [] });
        expect(result.missing).toEqual([{ id: 'HR-335649-101', overlapM2: 50, intrusionM: 0.42 }]);
        expect(result.parcels).toEqual([{ id: 'HR-335649-101', overlapM2: 50 }]);
        expect(result.error).toMatch(/reaches into 1 parcel/);
    });

    it('refuses declared parcels the site does not bind (unbound-parcels), naming how far it reaches', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park,
            ['HR-335649-100', 'HR-335649-101', 'HR-335649-102', 'HR-335649-999']);
        expect(result).toMatchObject({ ok: false, code: 'unbound-parcels', missing: [] });
        expect(result.extra).toEqual([{ id: 'HR-335649-102', intrusionM: 0.0004 }, { id: 'HR-335649-999', intrusionM: 0 }]);
    });

    it('reports both directions at once, missing first', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park, ['HR-335649-100', 'HR-335649-999']);
        expect(result.code).toBe('undeclared-parcels');
        expect(result.missing.map(m => m.id)).toEqual(['HR-335649-101']);
        expect(result.extra.map(m => m.id)).toEqual(['HR-335649-999']);
    });

    it('binds an authored site (not the footprint) and requires the footprint inside it', async () => {
        const db = cadastre({ parcels: SPILL });
        const ok = await checkProposalBinding(db, park, ['HR-335649-100', 'HR-335649-101'], { site: SITE });
        expect(ok.ok).toBe(true);
        expect(ok.site).toEqual({ type: 'MultiPolygon', coordinates: [SITE.coordinates] });
        expect(db.calls.map(call => call.sql)).toEqual([FOOTPRINT_OUTSIDE_SITE_SQL, BINDING_COUNT_SQL, BINDING_SQL]);
        expect(JSON.parse(db.calls[1].params[0])).toEqual([{ type: 'MultiPolygon', coordinates: [SITE.coordinates] }]);

        const outside = await checkProposalBinding(cadastre({ parcels: SPILL, outsideM2: 37.2 }), park, ['HR-335649-100'], { site: SITE });
        expect(outside).toMatchObject({ ok: false, code: 'footprint-outside-site' });
    });

    it('lets a material proposal on unsurveyed ground have an empty declaration', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: [], unsurveyedM2: 9000 }), { goal: 'buildings' }, [], { site: SITE });
        expect(result.ok).toBe(true);
        expect(result.binding).toMatchObject({ coverage: 'partial', parcels: [] });
    });

    it('keeps the declaration unverified where the server holds no cadastre', async () => {
        const result = await checkProposalBinding(cadastre({ inRegion: false }), park, ['BG-77-1']);
        expect(result.ok).toBe(true);
        expect(result.binding).toMatchObject({ coverage: 'unknown', subject: 'declared-unverified',
            source: 'server:unbound', parcelSource: null, parcels: [{ parcelId: 'BG-77-1' }] });
    });

    it('needs parcels only for a record about nothing: no goal makes a record an act on parcels', async () => {
        const db = cadastre({ parcels: [] });
        expect(await checkProposalBinding(db, { goal: 'ownership-transfer' }, [])).toMatchObject({ ok: false, code: 'parcels-required' });
        expect(db.calls).toHaveLength(0);
        // With a site, a former parcel-act goal is bound like any design (plan-design-agreement.md M2).
        const onSite = await checkProposalBinding(cadastre({ parcels: [], unsurveyedM2: 9000 }), { goal: 'ownership-transfer' }, [], { site: SITE, derive: true });
        expect(onSite).toMatchObject({ ok: true, cadastreParcelIds: [], binding: { coverage: 'partial', parcels: [] } });
        // A road designation (land, no centre line) binds by its polygon; it names no parcels of its own.
        const designation = { goal: 'road-track', roadProposal: { definition: { polygon: PARK, centerline: [] } } };
        const bound = await checkProposalBinding(cadastre({ parcels: SPILL }), designation, [], { derive: true });
        expect(bound).toMatchObject({ ok: true, cadastreParcelIds: ['HR-335649-100', 'HR-335649-101'] });
        // A declaration on it is compared with that binding like any other.
        expect(await checkProposalBinding(cadastre({ parcels: [], unsurveyedM2: 10 }), designation, ['HR-335649-100']))
            .toMatchObject({ ok: false, code: 'unbound-parcels', extra: [{ id: 'HR-335649-100', intrusionM: 0 }] });
    });

    it('binds a parcel act without geometry to its declared parcels and refuses ids that are not current parcels', async () => {
        const ok = await checkProposalBinding(cadastre(), { goal: 'ownership-transfer' }, ['HR-335649-100']);
        expect(ok).toMatchObject({ ok: true, binding: { coverage: 'complete', subject: 'declared-parcels', parcels: [{ parcelId: 'HR-335649-100' }] } });
        const unknown = await checkProposalBinding(cadastre({ found: ['HR-335649-100'] }), { goal: 'offer' }, ['HR-335649-100', 'HR-335649-404']);
        expect(unknown).toMatchObject({ ok: false, code: 'unbound-parcels', extra: [{ id: 'HR-335649-404' }] });
    });

    // Derive mode (the design index, the agents' preflight): a material record's parcels are DERIVED
    // from its binding; a record with no ground keeps (and is verified on) the parcels it names.
    it('derives the declaration in derive mode, and keeps a parcel act\'s named parcels', async () => {
        const material = await checkProposalBinding(cadastre({ parcels: SPILL }), parkBody({ cadastreParcelIds: [] }), [], { derive: true });
        expect(material).toMatchObject({ ok: true });
        expect(material.cadastreParcelIds).toEqual(material.binding.parcels.map(hit => hit.parcelId).sort());
        expect(material.cadastreParcelIds.length).toBeGreaterThan(0);
        const act = await checkProposalBinding(cadastre(), { goal: 'ownership-transfer' }, ['HR-335649-100'], { derive: true });
        expect(act).toMatchObject({ ok: true, cadastreParcelIds: ['HR-335649-100'] });
        const plain = await checkProposalBinding(cadastre(), { goal: 'ownership-transfer' }, ['HR-335649-100']);
        expect(plain.cadastreParcelIds).toBeUndefined();
    });

    it('refuses invalid geometry without querying', async () => {
        const db = cadastre();
        const invalid = await checkProposalBinding(db, { structureProposal: { geometry: { type: 'Polygon', coordinates: 'x' } } }, ['HR-1-1']);
        expect(invalid).toMatchObject({ ok: false, code: 'invalid-footprint' });
        expect(db.calls).toHaveLength(0);
    });
});

const parkBody = (overrides = {}) => validProposalBody({
    type: 'structure',
    goal: 'park',
    cadastreParcelIds: ['HR-335649-100'],
    structureProposal: { kind: 'park', geometry: PARK },
    ...overrides
});
