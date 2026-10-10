// Prepared publication artifacts (backend/proposals/prepare.js, projections.md §3): the server builds
// a corridor's land itself, stores one immutable content-addressed artifact, and publication must
// present exactly what was prepared — any change to geometry, recipe, tolerance, city, source or
// declaration is refused, a partial corridor can be neither prepared nor published, and a stored
// artifact is re-derived at publish to 1 mm. The binding itself is stubbed here (its SQL has its own
// tests); proposal-prepare-db.test.js runs the whole path against the real cadastre.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

vi.mock('../proposals/binding.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkProposalBinding: vi.fn(async (_db, record, declared, { site, toleranceM, derive }) => {
            if (record.roadProposal && !record.roadProposal.definition.polygon) throw new Error('bound before the land was built');
            const parcels = [{ parcelId: 'HR-335649-100', overlapM2: 120.5, intrusionM: 6.2 }];
            return {
                ok: true,
                site,
                binding: { coverage: 'complete', subject: 'site', toleranceM, parcels, touched: [], source: { kind: 'hr-cadastre' }, computedAt: new Date().toISOString() },
                ...(derive ? { cadastreParcelIds: parcels.map(hit => hit.parcelId) } : {})
            };
        })
    };
});

const {
    prepareProposal,
    verifyPreparation,
    geometricInputsDigest,
    artifactDigest,
    stableStringify,
    isConstructedCorridor,
    AGREEMENT_M,
    PREPARE_CODES
} = await import('../proposals/prepare.js');
const { checkProposalBinding } = await import('../proposals/binding.js');

const require = createRequire(import.meta.url);
const siteHashApi = require('../../frontend/js/proposals/site-hash.js');
const metricFrame = require('../../frontend/js/metric-frame.js');

// In-memory consensus.proposal_prepared, with jsonb's round trip (the artifact comes back parsed).
function preparedStore() {
    const rows = new Map();
    let inserts = 0;
    return {
        rows,
        get inserts() { return inserts; },
        async query(sql, params) {
            if (/INSERT INTO consensus\.proposal_prepared/.test(sql)) {
                inserts += 1;
                const [id, digest, artifact, city] = params;
                if (!rows.has(id)) rows.set(id, { digest, artifact: JSON.parse(artifact), city, created_at: new Date('2026-10-11T08:00:00Z') });
                return { rows: [], rowCount: 1 };
            }
            if (/FROM consensus\.proposal_prepared WHERE id = \$1/.test(sql)) {
                const row = rows.get(params[0]);
                return { rows: row ? [{ ...JSON.parse(JSON.stringify({ digest: row.digest, artifact: row.artifact })), created_at: row.created_at }] : [] };
            }
            if (/jsonb_to_recordset/.test(sql)) {
                return { rows: [{ id: 'HR-335649-100', version: 3, geom_hash: 'abc123' }] };
            }
            throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
        }
    };
}

const A = { lat: 45.8001, lng: 15.9701 };
const B = { lat: 45.8004, lng: 15.9712 };
const C = { lat: 45.8011, lng: 15.9716 };
const road = (definition = {}) => ({
    type: 'road',
    goal: 'road-track',
    title: 'Test street',
    city: 'zagreb',
    roadProposal: { definition: { width: 12, points: [A, B, C], segments: [[A, B, C]], ...definition } }
});
const clone = value => JSON.parse(JSON.stringify(value));

describe('prepareProposal', () => {
    beforeEach(() => { checkProposalBinding.mockClear(); });

    it('builds the corridor land on the server, ignoring a client polygon and a claimed legacy flag', async () => {
        const db = preparedStore();
        const bogus = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        const draft = road({ polygon: bogus, constructionFrame: { kind: 'legacy-centreline' }, latLngPairs: [[1, 2]] });
        const { artifact, proposal, preparationId, digest } = await prepareProposal(db, draft, { city: 'zagreb' });

        const land = artifact.corridor.polygon;
        expect(land.type).toBe('Polygon');
        expect(stableStringify(land)).not.toBe(stableStringify(bogus));
        expect(artifact.corridor.constructionFrame).toMatchObject({ kind: 'local-tmerc', algorithm: 'corridor-footprint/2' });
        // the anchor is the authored centre line's own (bbox midpoint), not a city's
        expect(artifact.corridor.constructionFrame.anchor).toEqual([15.97085, 45.8006]);
        expect(proposal.roadProposal.definition.polygon).toEqual(land);
        expect(proposal.roadProposal.definition.constructionFrame).toEqual(artifact.corridor.constructionFrame);
        expect(proposal.roadProposal.definition.latLngPairs).toBeUndefined();
        expect(isConstructedCorridor(draft)).toBe(true);

        // the binding saw the built land as the site; the site hash is of that site
        expect(checkProposalBinding.mock.calls[0][3].site).toEqual(artifact.site);
        expect(artifact.siteHash).toBe(await siteHashApi.siteHashHex(artifact.site));
        expect(artifact.cadastreParcelIds).toEqual(['HR-335649-100']);
        expect(artifact.cadastreRevision.parcels).toEqual([{ id: 'HR-335649-100', version: 3, geomHash: 'abc123' }]);

        // content-addressed, and the publishable record names it
        expect(digest).toBe(artifactDigest(artifact));
        expect(preparationId).toBe(`prep_${digest.slice(0, 32)}`);
        expect(proposal.preparation).toEqual({ id: preparationId, digest });
        expect(proposal.cadastreParcelIds).toEqual(['HR-335649-100']);
        expect(proposal.toleranceM).toBe(0);
    });

    it('is idempotent: the same proposal prepares to the same artifact, stored once', async () => {
        const db = preparedStore();
        const first = await prepareProposal(db, road(), { city: 'zagreb' });
        const second = await prepareProposal(db, road(), { city: 'zagreb' });
        expect(second.preparationId).toBe(first.preparationId);
        expect(second.digest).toBe(first.digest);
        expect(db.rows.size).toBe(1);
        // a different recipe is a different artifact
        const wider = await prepareProposal(db, road({ width: 14 }), { city: 'zagreb' });
        expect(wider.preparationId).not.toBe(first.preparationId);
        expect(db.rows.size).toBe(2);
    });

    it('refuses a partial corridor: nothing is bound or stored', async () => {
        const db = preparedStore();
        const broken = road({ points: [A, { lat: Number.NaN, lng: 15.971 }, C], segments: [[A, { lat: Number.NaN, lng: 15.971 }, C]] });
        await expect(prepareProposal(db, broken, { city: 'zagreb' })).rejects.toMatchObject({ code: 'invalid-site', status: 400 });
        const widthless = road({ width: undefined });
        await expect(prepareProposal(db, widthless, { city: 'zagreb' })).rejects.toMatchObject({ code: 'invalid-site', status: 400 });
        expect(checkProposalBinding).not.toHaveBeenCalled();
        expect(db.rows.size).toBe(0);
    });

    it('passes a site proposal through, binding the authored site', async () => {
        const db = preparedStore();
        const site = { type: 'Polygon', coordinates: [[[15.97, 45.80], [15.971, 45.80], [15.971, 45.8007], [15.97, 45.8007], [15.97, 45.80]]] };
        const { artifact } = await prepareProposal(db, { type: 'structure', goal: 'park', site, structureProposal: { kind: 'park', geometry: site } }, { city: 'zagreb' });
        expect(artifact.corridor).toBeNull();
        expect(artifact.siteHash).toBe(await siteHashApi.siteHashHex(artifact.site));
    });
});

describe('verifyPreparation', () => {
    async function prepared(draft = road(), options = { city: 'zagreb' }) {
        const db = preparedStore();
        const result = await prepareProposal(db, draft, options);
        return { db, ...result };
    }

    it('accepts the prepared record unchanged and hands back the artifact to store', async () => {
        const { db, proposal, artifact, preparationId, digest } = await prepared();
        const body = clone(proposal);
        const verified = await verifyPreparation(db, body, { city: 'zagreb' });
        expect(verified).toEqual({
            preparationId,
            digest,
            site: artifact.site,
            // no clock in the artifact; the binding's time is when the artifact was first stored
            binding: { ...artifact.binding, computedAt: '2026-10-11T08:00:00.000Z' },
            cadastreParcelIds: artifact.cadastreParcelIds,
            corridor: artifact.corridor
        });
        expect(artifact.binding.computedAt).toBeUndefined();
        // authoring metadata may change after preparing: title, description, offer
        await expect(verifyPreparation(db, { ...body, title: 'Renamed', description: 'x' }, { city: 'zagreb' })).resolves.toBeTruthy();
    });

    it('refuses every change to what was prepared', async () => {
        const { db, proposal } = await prepared();
        const refusal = async (mutate, context = { city: 'zagreb' }) => {
            const body = clone(proposal);
            mutate(body);
            return verifyPreparation(db, body, context).then(() => null, error => error);
        };
        const moved = await refusal(body => { body.roadProposal.definition.points[1].lng += 1e-6; body.roadProposal.definition.segments[0][1].lng += 1e-6; });
        expect(moved).toMatchObject({ code: PREPARE_CODES.mismatch, status: 422 });
        expect(moved.message).toMatch(/geometry/);
        expect(await refusal(body => { body.roadProposal.definition.width = 13; })).toMatchObject({ code: PREPARE_CODES.mismatch });
        expect(await refusal(body => { body.roadProposal.definition.profile = { lanes: [] }; })).toMatchObject({ code: PREPARE_CODES.mismatch });
        expect((await refusal(body => { body.toleranceM = 0.5; })).message).toMatch(/tolerance/);
        expect((await refusal(() => {}, { city: 'split' })).message).toMatch(/city/);
        expect((await refusal(body => { body.parcelSourceId = 'some-source'; })).message).toMatch(/parcel source/);
        expect((await refusal(body => { body.cadastreParcelIds = []; })).message).toMatch(/declaration/);
        expect((await refusal(body => { body.cadastreParcelIds = ['HR-335649-100', 'HR-335649-101']; })).message).toMatch(/declaration/);
        expect((await refusal(body => { body.roadProposal.definition.polygon.coordinates[0][0][0] += 1e-9; })).message).toMatch(/corridor land/);
        expect((await refusal(body => { body.roadProposal.definition.constructionFrame = { kind: 'legacy-centreline' }; })).message).toMatch(/construction frame/);
        expect((await refusal(body => { delete body.roadProposal.definition.polygon; })).message).toMatch(/corridor land/);
    });

    it('refuses a missing, unknown or mismatched preparation', async () => {
        const { db, proposal } = await prepared();
        const { preparation, ...unprepared } = clone(proposal);
        await expect(verifyPreparation(db, unprepared, { city: 'zagreb' })).rejects.toMatchObject({ code: PREPARE_CODES.required, status: 422 });
        await expect(verifyPreparation(db, { ...unprepared, preparation: { id: 'prep_00000000000000000000000000000000', digest: preparation.digest } }, { city: 'zagreb' }))
            .rejects.toMatchObject({ code: PREPARE_CODES.unknown });
        await expect(verifyPreparation(db, { ...unprepared, preparation: { id: preparation.id, digest: '0'.repeat(64) } }, { city: 'zagreb' }))
            .rejects.toMatchObject({ code: PREPARE_CODES.mismatch });
    });

    it('refuses a stored artifact that no longer matches its own digest', async () => {
        const { db, proposal, preparationId } = await prepared();
        db.rows.get(preparationId).artifact.binding.parcels = [];
        await expect(verifyPreparation(db, clone(proposal), { city: 'zagreb' })).rejects.toMatchObject({ code: PREPARE_CODES.invalid, status: 500 });
    });

    // A stored artifact whose land the current recipe no longer reproduces (a nondeterminism, or a
    // row written by a buggy build of the same version) is caught at publish; within 1 mm it stands.
    it('re-derives the corridor at publish: within 1 mm it stands, beyond it is stale', async () => {
        const shiftedBy = async (metres) => {
            const { db, proposal, preparationId } = await prepared();
            const row = db.rows.get(preparationId);
            const frame = metricFrame.frameFromProvenance(row.artifact.corridor.constructionFrame);
            // move every vertex east by `metres` in the construction frame, keeping the artifact
            // self-consistent (digest recomputed) as a buggy-but-honest writer would
            const shift = position => { const [x, y] = frame.toMetric(position); return frame.toLngLat([x + metres, y]); };
            const polygon = row.artifact.corridor.polygon;
            polygon.coordinates = polygon.coordinates.map(ring => ring.map(shift));
            row.digest = artifactDigest(row.artifact);
            const body = clone(proposal);
            body.preparation = { id: preparationId, digest: row.digest };
            body.roadProposal.definition.polygon = clone(polygon);
            return verifyPreparation(db, body, { city: 'zagreb' }).then(() => null, error => error);
        };
        expect(AGREEMENT_M).toBe(0.001);
        expect(await shiftedBy(0.0002)).toBeNull();
        expect(await shiftedBy(0.005)).toMatchObject({ code: PREPARE_CODES.stale, status: 422 });
    });
});

describe('geometric inputs', () => {
    it('ignore derived and descriptive fields, and cover the recipe, site and act', () => {
        const base = geometricInputsDigest(road());
        expect(geometricInputsDigest({ ...road(), title: 'Other', description: 'x' })).toBe(base);
        const withDerived = road({ polygon: { type: 'Polygon', coordinates: [] }, constructionFrame: { kind: 'local-tmerc' }, latLngPairs: [] });
        expect(geometricInputsDigest(withDerived)).toBe(base);
        expect(geometricInputsDigest(road({ width: 13 }))).not.toBe(base);
        const park = { goal: 'park', structureProposal: { geometry: { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.8]]] } } };
        expect(geometricInputsDigest(park)).not.toBe(geometricInputsDigest({ ...park, goal: 'ownership-transfer' }));
    });
});
