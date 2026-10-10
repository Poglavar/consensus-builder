// Prepared publication artifacts (backend/proposals/prepare.js, projections.md §3): the server builds
// a corridor's land itself and SIGNS one content-addressed artifact, storing nothing; publication must
// present exactly what was prepared, with the artifact the server signed — any change to geometry,
// recipe, tolerance, city, source, declaration or the artifact itself is refused, a server without a
// signing key prepares and verifies nothing, a partial corridor can be neither prepared nor published,
// and the artifact is re-derived at publish to 1 mm. The binding itself is stubbed here (its SQL has
// its own tests); proposal-prepare-db.test.js runs the whole path against the real cadastre.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

vi.mock('../proposals/binding.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkProposalBinding: vi.fn(async (_db, record, declared, { site, toleranceM, derive, city }) => {
            if (record.roadProposal && !record.roadProposal.definition.polygon) throw new Error('bound before the land was built');
            const parcels = [{ parcelId: 'HR-335649-100', overlapM2: 120.5, intrusionM: 6.2 }];
            return {
                ok: true,
                site,
                // placed for real (publication-city.js): only the cadastre is stubbed
                city: actual.publicationCityOf({ site, city }),
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
    PREPARE_CODES,
    preparationSignature,
    preparationIdFor
} = await import('../proposals/prepare.js');
const { checkProposalBinding } = await import('../proposals/binding.js');

const require = createRequire(import.meta.url);
const siteHashApi = require('../../frontend/js/proposals/site-hash.js');
const metricFrame = require('../../frontend/js/metric-frame.js');

// The cadastre revision lookup is all preparation may ask the database; every statement is recorded,
// and anything else (an INSERT above all: preparing stores nothing) fails the test.
function cadastreDb() {
    const statements = [];
    return {
        statements,
        async query(sql) {
            statements.push(sql);
            if (/jsonb_to_recordset/.test(sql)) return { rows: [{ id: 'HR-335649-100', version: 3, geom_hash: 'abc123' }] };
            throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
        }
    };
}

// The server's signing key, and a fixed clock: preparedAt is part of what is signed.
const KEY = 'a1'.repeat(32);
const AT = new Date('2026-10-11T08:00:00Z');
const sign = { signingKey: KEY, now: () => AT };

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
        const db = cadastreDb();
        const bogus = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        const draft = road({ polygon: bogus, constructionFrame: { kind: 'legacy-centreline' }, latLngPairs: [[1, 2]] });
        const { artifact, proposal, preparationId, digest, preparedAt, signature } = await prepareProposal(db, draft, { city: 'zagreb', ...sign });

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

        // content-addressed and signed; the publishable record carries both the reference and the artifact
        expect(digest).toBe(artifactDigest(artifact));
        expect(preparationId).toBe(`prep_${digest.slice(0, 32)}`);
        expect(preparedAt).toBe('2026-10-11T08:00:00.000Z');
        expect(signature).toBe(preparationSignature(digest, preparedAt, KEY));
        expect(proposal.preparation).toEqual({ id: preparationId, digest, preparedAt, signature });
        expect(proposal.preparedArtifact).toEqual(artifact);
        expect(proposal.cadastreParcelIds).toEqual(['HR-335649-100']);
        expect(proposal.toleranceM).toBe(0);
    });

    it('is idempotent and stores nothing: the same proposal prepares to the same artifact', async () => {
        const db = cadastreDb();
        const first = await prepareProposal(db, road(), { city: 'zagreb', ...sign });
        const second = await prepareProposal(db, road(), { city: 'zagreb', signingKey: KEY, now: () => new Date('2026-10-12T09:00:00Z') });
        expect(second.preparationId).toBe(first.preparationId);
        expect(second.digest).toBe(first.digest);
        // a later preparation of it is signed for its own time
        expect(second.signature).not.toBe(first.signature);
        // a different recipe is a different artifact
        const wider = await prepareProposal(db, road({ width: 14 }), { city: 'zagreb', ...sign });
        expect(wider.preparationId).not.toBe(first.preparationId);
        // the database was only read, never written
        expect(db.statements.length).toBeGreaterThan(0);
        expect(db.statements.every(sql => /^\s*SELECT/i.test(sql))).toBe(true);
    });

    it('prepares nothing without the server\'s signing key', async () => {
        const db = cadastreDb();
        await expect(prepareProposal(db, road(), { city: 'zagreb', signingKey: '' })).rejects.toMatchObject({ code: PREPARE_CODES.unavailable, status: 503 });
        await expect(prepareProposal(db, road(), { city: 'zagreb', signingKey: 'abc' })).rejects.toMatchObject({ code: PREPARE_CODES.unavailable });
        expect(checkProposalBinding).not.toHaveBeenCalled();
        expect(db.statements).toEqual([]);
    });

    it('refuses a partial corridor: nothing is bound or stored', async () => {
        const db = cadastreDb();
        const broken = road({ points: [A, { lat: Number.NaN, lng: 15.971 }, C], segments: [[A, { lat: Number.NaN, lng: 15.971 }, C]] });
        await expect(prepareProposal(db, broken, { city: 'zagreb', ...sign })).rejects.toMatchObject({ code: 'invalid-site', status: 400 });
        const widthless = road({ width: undefined });
        await expect(prepareProposal(db, widthless, { city: 'zagreb', ...sign })).rejects.toMatchObject({ code: 'invalid-site', status: 400 });
        expect(checkProposalBinding).not.toHaveBeenCalled();
        expect(db.statements).toEqual([]);
    });

    it('passes a site proposal through, binding the authored site', async () => {
        const db = cadastreDb();
        const site = { type: 'Polygon', coordinates: [[[15.97, 45.80], [15.971, 45.80], [15.971, 45.8007], [15.97, 45.8007], [15.97, 45.80]]] };
        const { artifact } = await prepareProposal(db, { type: 'structure', goal: 'park', site, structureProposal: { kind: 'park', geometry: site } }, { city: 'zagreb', ...sign });
        expect(artifact.corridor).toBeNull();
        expect(artifact.siteHash).toBe(await siteHashApi.siteHashHex(artifact.site));
    });
});

describe('verifyPreparation', () => {
    const context = { city: 'zagreb', signingKey: KEY };
    async function prepared(draft = road(), options = { city: 'zagreb' }) {
        return prepareProposal(cadastreDb(), draft, { ...sign, ...options });
    }
    const verify = (body, extra = {}) => Promise.resolve().then(() => verifyPreparation(body, { ...context, ...extra }));
    // what a server would sign for this artifact at AT: an honest (if buggy) writer
    const signed = artifact => {
        const digest = artifactDigest(artifact);
        const preparedAt = AT.toISOString();
        return { id: preparationIdFor(digest), digest, preparedAt, signature: preparationSignature(digest, preparedAt, KEY) };
    };

    it('accepts the prepared record unchanged and hands back the artifact to store', async () => {
        const { proposal, artifact, preparationId, digest, preparedAt } = await prepared();
        const body = clone(proposal);
        const verified = await verify(body);
        expect(verified).toEqual({
            preparationId,
            digest,
            preparedAt,
            artifact,
            city: 'zagreb',
            site: artifact.site,
            // no clock in the artifact; the binding's time is the signed time of preparation
            binding: { ...artifact.binding, computedAt: '2026-10-11T08:00:00.000Z' },
            cadastreParcelIds: artifact.cadastreParcelIds,
            corridor: artifact.corridor
        });
        expect(artifact.binding.computedAt).toBeUndefined();
        // authoring metadata may change after preparing: title, description, offer
        await expect(verify({ ...body, title: 'Renamed', description: 'x' })).resolves.toBeTruthy();
    });

    it('refuses every change to what was prepared', async () => {
        const { proposal } = await prepared();
        const refusal = async (mutate, extra = {}) => {
            const body = clone(proposal);
            mutate(body);
            return verify(body, extra).then(() => null, error => error);
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

    it('stores the city the site lies in, and accepts either it or the one the author asked for', async () => {
        // a Zagreb street prepared from Split's view (one countrywide cadastre) is Zagreb's
        const { proposal, artifact } = await prepared(road({}), { city: 'split' });
        expect(artifact).toMatchObject({ city: 'zagreb', requestedCity: 'split' });
        expect(proposal.city).toBe('zagreb');
        const body = clone(proposal);
        expect((await verify(body, { city: 'zagreb' })).city).toBe('zagreb');
        // an older client publishes the city it asked for; publication still stores the placed one
        expect((await verify(body, { city: 'split' })).city).toBe('zagreb');
        await expect(verify(body, { city: 'sibenik' })).rejects.toMatchObject({ code: PREPARE_CODES.mismatch });
        // asked for where it lies: nothing extra in the artifact
        const same = await prepared(road({}), { city: 'zagreb' });
        expect(same.artifact.city).toBe('zagreb');
        expect('requestedCity' in same.artifact).toBe(false);
    });

    it('refuses a missing preparation or artifact, and anything this server did not sign', async () => {
        const { proposal } = await prepared();
        const { preparation, preparedArtifact, ...unprepared } = clone(proposal);
        await expect(verify(unprepared)).rejects.toMatchObject({ code: PREPARE_CODES.required, status: 422 });
        await expect(verify({ ...unprepared, preparation })).rejects.toMatchObject({ code: PREPARE_CODES.unknown });
        // the artifact altered under the same reference: its digest no longer matches
        const altered = clone(preparedArtifact);
        altered.binding.parcels = [];
        await expect(verify({ ...unprepared, preparation, preparedArtifact: altered })).rejects.toMatchObject({ code: PREPARE_CODES.invalid });
        // ...and re-digested by the client: the signature is not the server's for it
        const forged = { ...signed(altered), signature: preparation.signature };
        await expect(verify({ ...unprepared, preparation: forged, preparedArtifact: altered })).rejects.toMatchObject({ code: PREPARE_CODES.invalid });
        // another time, another key: not this signature
        await expect(verify({ ...unprepared, preparation: { ...preparation, preparedAt: '2026-10-11T08:00:01.000Z' }, preparedArtifact })).rejects.toMatchObject({ code: PREPARE_CODES.invalid });
        await expect(verify({ ...unprepared, preparation, preparedArtifact }, { signingKey: 'b2'.repeat(32) })).rejects.toMatchObject({ code: PREPARE_CODES.invalid });
        // a server without a key verifies nothing
        await expect(verify({ ...unprepared, preparation, preparedArtifact }, { signingKey: '' })).rejects.toMatchObject({ code: PREPARE_CODES.unavailable, status: 503 });
    });

    // An artifact whose land the current recipe no longer reproduces (a nondeterminism, or one written
    // by a buggy build of the same version) is caught at publish; within 1 mm it stands.
    it('re-derives the corridor at publish: within 1 mm it stands, beyond it is stale', async () => {
        const shiftedBy = async (metres) => {
            const { proposal, artifact } = await prepared();
            const shifted = clone(artifact);
            const frame = metricFrame.frameFromProvenance(shifted.corridor.constructionFrame);
            // move every vertex east by `metres` in the construction frame, keeping the artifact
            // self-consistent and signed, as a buggy-but-honest server would
            const shift = position => { const [x, y] = frame.toMetric(position); return frame.toLngLat([x + metres, y]); };
            shifted.corridor.polygon.coordinates = shifted.corridor.polygon.coordinates.map(ring => ring.map(shift));
            const body = clone(proposal);
            body.preparation = signed(shifted);
            body.preparedArtifact = shifted;
            body.roadProposal.definition.polygon = clone(shifted.corridor.polygon);
            return verify(body).then(() => null, error => error);
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
