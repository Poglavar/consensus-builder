import { consumerParcelSourceId } from './helpers/frontend-source-selection.js';
// The strict land rule on the server, generalised (PARCEL-OPTIONAL.md): cadastreParcelIds must EQUAL
// the server binding of the proposal's site — missing and extra parcels are refused separately; an
// empty declaration is allowed for a material proposal with a site; parcel acts still need parcels.
// Covers the shared footprint builder and checkProposalBinding against a scripted HR cadastre that
// serves real candidate geometry, so site-binding.js decides as it does live. The candidate SQL
// itself runs against a real database in proposal-binding-db.test.js (RUN_DB_TESTS=1).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
    MAX_FOOTPRINT_VERTICES,
    footprintParts,
    proposalGeometryView
} from '../proposals/footprint.js';
import {
    MAX_SITE_VERTICES,
    checkProposalBinding,
    computeBinding,
    parseHrParcelId,
    parseTolerance,
    validateSiteGeometry
} from '../proposals/binding.js';
import { HR_PARCEL_IDS_SQL, HR_SITE_CANDIDATES_SQL } from '../parcels/oss-binding-source.js';
import { validProposalBody } from './helpers/fixtures.js';
import { PARK, REGION, SITE, SPILL, SPILL_WITH_GAP, box, scriptedCadastre } from './helpers/content-fixtures.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { bindingFromParcels } = require('../../frontend/js/proposals/site-binding.js');
const SITE_MULTI = { type: 'MultiPolygon', coordinates: [SITE.coordinates] };

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
    });

    it('reports malformed coordinates and over-large footprints instead of binding them', () => {
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


// A scripted HR cadastre (content-fixtures.js): answers the candidate statements with real geometry
// and records them. `found` limits which declared ids exist.
function cadastre({ found = null, ...options } = {}) {
    const calls = [];
    const answer = scriptedCadastre(options);
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === HR_PARCEL_IDS_SQL && found) {
                const rows = (await answer(sql, params)).rows.filter(row => found.includes(row.id));
                return { rows };
            }
            const reply = answer(sql, params);
            if (!reply) throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
            return reply;
        }
    };
}
const BOUND = ['HR-335649-100', 'HR-335649-101'];

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
    it('reads the candidates once and decides with site-binding.js: bound, touched, coverage', async () => {
        const db = cadastre();
        const { binding, site } = await computeBinding(db, { parcelSourceId: 'oss-wfs', site: SITE, toleranceM: 0 });
        expect(db.calls.map(call => call.sql)).toEqual([HR_SITE_CANDIDATES_SQL]);
        expect(JSON.parse(db.calls[0].params[0])).toEqual(SITE_MULTI);
        expect(binding.parcels.map(p => p.parcelId)).toEqual(BOUND);
        expect(binding.touched.map(p => p.parcelId)).toEqual(['HR-335649-102']);
        expect(binding.touched[0].intrusionM).toBeLessThan(0.001);
        expect(binding).toMatchObject({ coverage: 'complete', toleranceM: 0, unsurveyedM2: 0, unknownM2: 0,
            source: 'server:hr-cadastre', parcelSource: { sourceId: 'hr-cadastre', snapshotId: null } });
        expect(binding.unresolved).toBeUndefined();
        expect(site).toEqual(SITE_MULTI);
    });

    it('returns exactly what the browser function returns for the same site and candidates', async () => {
        for (const [parcels, toleranceM] of [[SPILL, 0], [SPILL, 0.5], [SPILL_WITH_GAP, 0]]) {
            const { binding } = await computeBinding(cadastre({ parcels }), { parcelSourceId: 'oss-wfs', site: SITE, toleranceM });
            const browser = bindingFromParcels(SITE, parcels.map(p => ({ id: p.parcelId, geometry: p.geometry })),
                { turf, toleranceM, regions: [{ id: '1', geometry: REGION }] });
            const { source: _s, parcelSource: _p, computedAt: _c, ...server } = binding;
            const { source: _bs, parcelSource: _bp, ...client } = browser;
            expect(server).toEqual(client);
        }
    });

    it('is partial when open ground lies inside the cadastral municipality (unsurveyed) or outside it (unknown)', async () => {
        const gap = (await computeBinding(cadastre({ parcels: SPILL_WITH_GAP }), { parcelSourceId: 'oss-wfs', site: SITE })).binding;
        expect(gap).toMatchObject({ coverage: 'partial', unknownM2: 0 });
        expect(gap.unsurveyedM2).toBeGreaterThan(5000);
        // The municipality ends on the strip's west edge: the strip is outside it, unknown.
        const edge = (await computeBinding(cadastre({ parcels: SPILL_WITH_GAP, regions: [box(15.96, 45.79, 15.9718, 45.81)] }),
            { parcelSourceId: 'oss-wfs', site: SITE })).binding;
        expect(edge).toMatchObject({ coverage: 'partial', unsurveyedM2: 0 });
        expect(edge.unknownM2).toBeCloseTo(gap.unsurveyedM2, 0);
        // Surveyed region, nothing under the site: partial and all of it unsurveyed.
        const empty = (await computeBinding(cadastre({ parcels: [] }), { parcelSourceId: 'oss-wfs', site: SITE })).binding;
        expect(empty).toMatchObject({ coverage: 'partial', parcels: [], unsurveyedM2: empty.siteM2 });
    });

    it('says unknown outside every cadastral municipality, and none only for an explicit no-cadastre selection', async () => {
        const unknown = (await computeBinding(cadastre({ regions: [] }), { parcelSourceId: 'oss-wfs', site: SITE, city: 'unconfigured_city' })).binding;
        expect(unknown).toMatchObject({ coverage: 'unknown', parcels: [], unknownM2: unknown.siteM2, unsurveyedM2: 0,
            source: 'server:unbound', parcelSource: null });
        expect(unknown.siteM2).toBeGreaterThan(70000);
        expect(unknown.reason).toMatch(/cannot be bound/);
        const none = (await computeBinding(cadastre({ regions: [] }), { parcelSourceId: consumerParcelSourceId('explore'), site: SITE, city: 'explore' })).binding;
        expect(none).toMatchObject({ coverage: 'none', parcels: [], unsurveyedM2: none.siteM2,
            source: 'server:unbound', parcelSource: null });
    });

    it('refuses a site over the parcel cap', async () => {
        const db = cadastre({ truncated: true });
        await expect(computeBinding(db, { parcelSourceId: 'oss-wfs', site: SITE })).rejects.toMatchObject({ code: 'too-many-parcels', status: 413 });
        expect(db.calls.map(call => call.sql)).toEqual([HR_SITE_CANDIDATES_SQL]);
    });
});

describe('checkProposalBinding (declared == binding)', () => {
    const park = { goal: 'park', structureProposal: { kind: 'park', geometry: PARK } };

    it('accepts exactly the bound parcels, in any order', async () => {
        const result = await checkProposalBinding(cadastre(), park, ['HR-335649-101', 'HR-335649-100'], { parcelSourceId: 'oss-wfs' });
        expect(result.ok).toBe(true);
        expect(result.binding.parcels).toHaveLength(2);
    });

    it('binds a footprint without a site as the browser does: its own union is the site', async () => {
        const db = cadastre();
        const result = await checkProposalBinding(db, park, BOUND, { parcelSourceId: 'oss-wfs' });
        expect(result.ok).toBe(true);
        expect(JSON.parse(db.calls[0].params[0])).toEqual({ type: 'MultiPolygon', coordinates: [PARK.coordinates] });
        expect(result.site).toEqual({ type: 'MultiPolygon', coordinates: [PARK.coordinates] });
    });

    it('refuses bound parcels missing from the declaration (undeclared-parcels) with their intrusion', async () => {
        const result = await checkProposalBinding(cadastre(), park, ['HR-335649-100'], { parcelSourceId: 'oss-wfs' });
        expect(result).toMatchObject({ ok: false, status: 400, code: 'undeclared-parcels', extra: [] });
        expect(result.missing).toHaveLength(1);
        expect(result.missing[0]).toMatchObject({ id: 'HR-335649-101' });
        expect(result.missing[0].intrusionM).toBeGreaterThan(30);
        expect(result.parcels).toEqual([{ id: 'HR-335649-101', overlapM2: result.missing[0].overlapM2 }]);
        expect(result.error).toMatch(/reaches into 1 parcel/);
    });

    it('refuses declared parcels the site does not bind (unbound-parcels), naming how far it reaches', async () => {
        const result = await checkProposalBinding(cadastre(), { goal: 'park', site: SITE }, [...BOUND, 'HR-335649-102', 'HR-335649-999'],
            { parcelSourceId: 'oss-wfs', site: SITE });
        expect(result).toMatchObject({ ok: false, code: 'unbound-parcels', missing: [] });
        expect(result.extra.map(hit => hit.id)).toEqual(['HR-335649-102', 'HR-335649-999']);
        expect(result.extra[0].intrusionM).toBeLessThan(0.001);
        expect(result.extra[1]).toEqual({ id: 'HR-335649-999', intrusionM: 0 });
    });

    it('reports both directions at once, missing first', async () => {
        const result = await checkProposalBinding(cadastre(), park, ['HR-335649-100', 'HR-335649-999'], { parcelSourceId: 'oss-wfs' });
        expect(result.code).toBe('undeclared-parcels');
        expect(result.missing.map(m => m.id)).toEqual(['HR-335649-101']);
        expect(result.extra.map(m => m.id)).toEqual(['HR-335649-999']);
    });

    it('binds an authored site (not the footprint) and requires the footprint inside it', async () => {
        const db = cadastre();
        const ok = await checkProposalBinding(db, park, BOUND, { parcelSourceId: 'oss-wfs', site: SITE });
        expect(ok.ok).toBe(true);
        expect(ok.site).toEqual(SITE_MULTI);
        expect(db.calls.map(call => call.sql)).toEqual([HR_SITE_CANDIDATES_SQL]);
        expect(JSON.parse(db.calls[0].params[0])).toEqual(SITE_MULTI);

        // A park reaching 0.001° (≈ 78 m) east of the site, 0.001° tall.
        const spilling = { goal: 'park', structureProposal: { kind: 'park', geometry: box(15.971, 45.80, 15.973, 45.801) } };
        const outside = await checkProposalBinding(cadastre(), spilling, ['HR-335649-100'], { parcelSourceId: 'oss-wfs', site: SITE });
        expect(outside).toMatchObject({ ok: false, code: 'footprint-outside-site', site: SITE_MULTI });
        expect(outside.outsideM2).toBeGreaterThan(8500);
        expect(outside.outsideM2).toBeLessThan(8800);
        expect(turf.area(outside.outsideGeometry)).toBeCloseTo(outside.outsideM2, -1);
        expect(outside.error).not.toMatch(/proposal/i);
        // What the site leaves of the footprint is judged by isGround: a 0.3 mm spill is debris.
        const sliver = { goal: 'park', structureProposal: { kind: 'park', geometry: box(15.971, 45.80, 15.972000004, 45.801) } };
        expect((await checkProposalBinding(cadastre(), sliver, BOUND, { parcelSourceId: 'oss-wfs', site: SITE })).ok).toBe(true);
    });

    it('refuses a flagged legacy centre line: the server has no second way to build its land', async () => {
        const legacy = { goal: 'road', roadProposal: { definition: { width: 12, constructionFrame: { kind: 'legacy-centreline' },
            points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }] } } };
        const db = cadastre();
        expect(await checkProposalBinding(db, legacy, [], { parcelSourceId: 'oss-wfs', derive: true })).toMatchObject({ ok: false, code: 'invalid-footprint' });
        expect(db.calls).toHaveLength(0);
    });

    it('lets a material proposal on unsurveyed ground have an empty declaration', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: [] }), { goal: 'buildings' }, [], { parcelSourceId: 'oss-wfs', site: SITE });
        expect(result.ok).toBe(true);
        expect(result.binding).toMatchObject({ coverage: 'partial', parcels: [] });
    });

    it('keeps the declaration unverified where the server holds no cadastre', async () => {
        const result = await checkProposalBinding(cadastre({ regions: [] }), park, ['BG-77-1'], { parcelSourceId: 'oss-wfs' });
        expect(result.ok).toBe(true);
        expect(result.binding).toMatchObject({ coverage: 'unknown', subject: 'declared-unverified',
            source: 'server:unbound', parcelSource: null, parcels: [{ parcelId: 'BG-77-1' }] });
    });

    it('needs parcels only for a record about nothing: no goal makes a record an act on parcels', async () => {
        const db = cadastre({ parcels: [] });
        expect(await checkProposalBinding(db, { goal: 'ownership-transfer' }, [], { parcelSourceId: 'oss-wfs' })).toMatchObject({ ok: false, code: 'parcels-required' });
        expect(db.calls).toHaveLength(0);
        // With a site, a former parcel-act goal is bound like any design (plan-design-agreement.md M2).
        const onSite = await checkProposalBinding(cadastre({ parcels: [] }), { goal: 'ownership-transfer' }, [], { parcelSourceId: 'oss-wfs', site: SITE, derive: true });
        expect(onSite).toMatchObject({ ok: true, cadastreParcelIds: [], binding: { coverage: 'partial', parcels: [] } });
        // A road designation (land, no centre line) binds by its polygon; it names no parcels of its own.
        const designation = { goal: 'road-track', roadProposal: { definition: { polygon: PARK, centerline: [] } } };
        const bound = await checkProposalBinding(cadastre(), designation, [], { parcelSourceId: 'oss-wfs', derive: true });
        expect(bound).toMatchObject({ ok: true, cadastreParcelIds: BOUND });
        // A declaration on it is compared with that binding like any other.
        expect(await checkProposalBinding(cadastre({ parcels: [] }), designation, ['HR-335649-100'], { parcelSourceId: 'oss-wfs' }))
            .toMatchObject({ ok: false, code: 'unbound-parcels', extra: [{ id: 'HR-335649-100', intrusionM: 0 }] });
    });

    it('binds a parcel act without geometry to its declared parcels and refuses ids that are not current parcels', async () => {
        const db = cadastre();
        const ok = await checkProposalBinding(db, { goal: 'ownership-transfer' }, ['HR-335649-100'], { parcelSourceId: 'oss-wfs' });
        expect(ok).toMatchObject({ ok: true, site: { type: 'MultiPolygon' }, binding: { coverage: 'complete', subject: 'declared-parcels',
            source: 'server:hr-cadastre', parcelSource: { sourceId: 'hr-cadastre', snapshotId: null }, parcels: [{ parcelId: 'HR-335649-100' }] } });
        expect(db.calls.map(call => call.sql)).toEqual([HR_PARCEL_IDS_SQL]);
        expect(JSON.parse(db.calls[0].params[0])).toEqual([{ id: 'HR-335649-100', ko: 335649, number: '100' }]);
        const unknown = await checkProposalBinding(cadastre({ found: ['HR-335649-100'] }), { goal: 'offer' }, ['HR-335649-100', 'HR-335649-404'], { parcelSourceId: 'oss-wfs' });
        expect(unknown).toMatchObject({ ok: false, code: 'unbound-parcels', extra: [{ id: 'HR-335649-404' }] });
        // An id that is not an HR cadastral id is not a current parcel of this source.
        const foreign = await checkProposalBinding(cadastre(), { goal: 'offer' }, ['BG-77-1'], { parcelSourceId: 'oss-wfs' });
        expect(foreign).toMatchObject({ ok: false, code: 'unbound-parcels', extra: [{ id: 'BG-77-1' }] });
    });

    // Derive mode (the design index, the agents' preflight): a material record's parcels are DERIVED
    // from its binding; a record with no ground keeps (and is verified on) the parcels it names.
    it('derives the declaration in derive mode, and keeps a parcel act\'s named parcels', async () => {
        const material = await checkProposalBinding(cadastre(), parkBody({ cadastreParcelIds: [] }), [], { parcelSourceId: 'oss-wfs', derive: true });
        expect(material).toMatchObject({ ok: true });
        expect(material.cadastreParcelIds).toEqual(material.binding.parcels.map(hit => hit.parcelId).sort());
        expect(material.cadastreParcelIds).toEqual(BOUND);
        const act = await checkProposalBinding(cadastre(), { goal: 'ownership-transfer' }, ['HR-335649-100'], { parcelSourceId: 'oss-wfs', derive: true });
        expect(act).toMatchObject({ ok: true, cadastreParcelIds: ['HR-335649-100'] });
        const plain = await checkProposalBinding(cadastre(), { goal: 'ownership-transfer' }, ['HR-335649-100'], { parcelSourceId: 'oss-wfs' });
        expect(plain.cadastreParcelIds).toBeUndefined();
    });

    it('refuses invalid geometry without querying', async () => {
        const db = cadastre();
        const invalid = await checkProposalBinding(db, { structureProposal: { geometry: { type: 'Polygon', coordinates: 'x' } } }, ['HR-1-1'], { parcelSourceId: 'oss-wfs' });
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
