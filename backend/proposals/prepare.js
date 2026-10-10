// Prepared publication artifacts (projections.md §3). A proposal is prepared ONCE, before anything is
// uploaded or minted: the server materialises what it derives (a corridor's land, from its lanes, in
// its own operation frame), binds the site to the cadastre, hashes it, and SIGNS the result (an HMAC
// over its digest and the time it was prepared, with the server's PREPARE_SIGNING_KEY). Metadata
// upload, minting and POST /proposals then all carry that exact artifact, and publication verifies the
// signature and stores the artifact beside the row — a re-derivation at publish only VALIDATES it.
// Without this, a 0.16 mm shift across a rounding boundary between what was minted and what was stored
// changes the on-chain site hash.
//
// Preparing stores nothing: an unbounded free call that wrote a row each time was a way to fill the
// disk. Only a published proposal's artifact is kept (consensus.proposal_prepared). The signing key is
// required — without it preparation and publication of prepared records answer 503, never unsigned.
//
// Content-addressed: the artifact's id is its digest, so preparing the same proposal against the
// same cadastre twice gives the same artifact (a retry is free and cannot fork).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    checkProposalBinding,
    normalizeSiteGeometry,
    validateSiteGeometry,
    parseTolerance,
    requiresParcels,
    BINDING_CODES
} from './binding.js';
import { footprintParts } from './footprint.js';
import { stripLocalProposalState } from './serializer.js';

const requireCjs = createRequire(import.meta.url);
const corridorFootprint = requireCjs('../../frontend/js/corridor-footprint.js');
const metricFrame = requireCjs('../../frontend/js/metric-frame.js');
const corridorProfile = requireCjs('../../frontend/js/corridor-profile.js');
const siteHashApi = requireCjs('../../frontend/js/proposals/site-hash.js');

export const PREPARE_PROTOCOL = 'prepare/1';
export const PREPARED_TABLE = 'consensus.proposal_prepared';
export const PREPARE_CODES = Object.freeze({
    required: 'preparation-required',     // a corridor built from its lanes, published unprepared
    unknown: 'preparation-unknown',       // no artifact under that id
    mismatch: 'preparation-mismatch',     // the record differs from what was prepared
    stale: 'preparation-stale',           // re-derivation no longer reproduces the artifact
    invalid: 'preparation-invalid',       // the artifact fails its digest or the server's signature
    unavailable: 'preparation-unavailable' // the server has no signing key: nothing can be prepared
});
// At least 32 bytes of key, as hex.
const MIN_SIGNING_KEY_HEX = 64;
// Fields of a corridor definition the server derives (or the browser caches); everything else in
// the definition is authored, and any change to it needs a new preparation.
const DERIVED_DEFINITION_FIELDS = Object.freeze(['polygon', 'constructionFrame', 'latLngPairs', 'demolishedBuildings', 'demolitionScanned']);
// Two materialisations of one recipe in one frame agree to this (mean boundary separation), with
// equal components and holes.
export const AGREEMENT_M = 0.001;

// JSON with object keys sorted at every depth: equal content always serialises (and hashes) equal.
export function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
const sha256 = text => createHash('sha256').update(text).digest('hex');
export const artifactDigest = artifact => sha256(stableStringify(artifact));
export const preparationIdFor = digest => `prep_${digest.slice(0, 32)}`;

function preparationError(code, message, status = 422, extra = {}) {
    return Object.assign(new Error(message), { code, status, ...extra });
}

// The server's signing key: PREPARE_SIGNING_KEY, hex, at least 32 bytes. Missing or short is a
// configuration error answered 503 — never an unsigned preparation.
function signingKeyOf(key) {
    const hex = String(key ?? process.env.PREPARE_SIGNING_KEY ?? '').trim();
    if (hex.length < MIN_SIGNING_KEY_HEX || !/^[0-9a-f]+$/i.test(hex)) {
        throw preparationError(PREPARE_CODES.unavailable, 'Preparation is unavailable: the server has no signing key (PREPARE_SIGNING_KEY).', 503);
    }
    return Buffer.from(hex, 'hex');
}

// What the server vouches for: this artifact (by digest), prepared at this instant.
export function preparationSignature(digest, preparedAt, key) {
    return createHmac('sha256', signingKeyOf(key)).update(`${PREPARE_PROTOCOL}\n${digest}\n${preparedAt}`).digest('hex');
}

function signatureMatches(expected, given) {
    const a = Buffer.from(String(expected), 'hex');
    const b = Buffer.from(String(given || ''), 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// A corridor whose land is built from its lanes: a road or track with a centre line, not a
// designation of whole parcels. A submission's claimed `legacy-centreline` flag changes nothing — it
// is a derived field (stripped at preparation), set only by the legacy migration on stored rows, so
// a new record can never opt into the approximate centreline footprint.
export function isConstructedCorridor(record) {
    const definition = record?.roadProposal?.definition;
    if (!definition || typeof definition !== 'object') return false;
    return corridorProfile.corridorCenterlineOf(definition).length > 0;
}

// The authored part of a corridor definition: what its land is built from.
export function authoredDefinition(definition) {
    const copy = JSON.parse(JSON.stringify(definition || {}));
    for (const field of DERIVED_DEFINITION_FIELDS) delete copy[field];
    if (copy.metadata && typeof copy.metadata === 'object') delete copy.metadata.ownershipAndAcquisitionStats;
    return copy;
}

// Everything about a record that decides its site and binding. Preparation records its digest;
// publication must present a record with the same one.
export function geometricInputs(record) {
    const draft = stripLocalProposalState(record) || {};
    const site = draft.site ? normalizeSiteGeometry(draft.site) : null;
    if (isConstructedCorridor(draft)) {
        return { kind: 'corridor', site, recipe: authoredDefinition(draft.roadProposal.definition) };
    }
    const parts = footprintParts(draft);
    return {
        kind: 'record',
        site,
        polygons: parts.polygons,
        centerline: parts.centerline ? { segments: parts.centerline.segments, halfWidthM: parts.centerline.halfWidthM } : null,
        parcelAct: requiresParcels(site ? { ...draft, site } : draft)
    };
}
export const geometricInputsDigest = record => sha256(stableStringify(geometricInputs(record)));

// Per bound/touched HR parcel, its cadastral identity at binding time (version and geometry hash):
// the cadastre revision the artifact was bound against.
async function cadastreRevision(db, binding) {
    const ids = [...new Set([...(binding?.parcels || []), ...(binding?.touched || [])].map(hit => String(hit.parcelId)))].sort();
    const hr = ids.map(id => /^HR-(\d+)-(.+)$/.exec(id)).filter(Boolean).map(m => ({ ko: Number(m[1]), number: m[2] }));
    const byId = new Map();
    if (hr.length) {
        const { rows } = await db.query(`
            SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id, p.version, p.geom_hash
            FROM jsonb_to_recordset($1::jsonb) AS x(ko int, number text)
            JOIN parcel p ON p.current = true AND p.maticni_broj_ko = x.ko AND p.broj_cestice = x.number`,
        [JSON.stringify(hr)]);
        for (const row of rows) byId.set(row.id, { id: row.id, version: row.version, geomHash: row.geom_hash });
    }
    return { source: binding?.source || null, parcels: ids.map(id => byId.get(id) || { id }) };
}

/**
 * Prepare a proposal for publication.
 * @param db pg pool/client
 * @param {object} record the draft record, shaped like a POST /proposals body
 * @param {{ city?: string|null, parcelSourceId?: string|null, toleranceM?: number, now?: () => Date,
 *   signingKey?: string }} options `city` already normalised by the caller (routes/proposals.js
 *   normalizeCityCode); `signingKey` defaults to PREPARE_SIGNING_KEY.
 * @returns {Promise<{ preparationId, digest, preparedAt, signature, artifact, proposal }>} `proposal`
 *   is the record ready to publish: its city (placed by its site), derived corridor land, declaration,
 *   tolerance, preparation reference `{ id, digest, preparedAt, signature }` and the artifact itself
 *   (`preparedArtifact`, which publication verifies and stores) filled in. Nothing is stored.
 * Throws an error with `code` and `status` (binding codes) on refusal.
 */
export async function prepareProposal(db, record, { city = null, parcelSourceId = null, toleranceM, now = () => new Date(), signingKey } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw preparationError(BINDING_CODES.invalidSite, 'The proposal must be a JSON object.', 400);
    signingKeyOf(signingKey); // before any work: a server that cannot sign prepares nothing
    const draft = stripLocalProposalState(record);
    const tolerance = parseTolerance(toleranceM ?? draft.toleranceM);
    if (!tolerance.ok) throw preparationError(BINDING_CODES.invalidTolerance, tolerance.error, 400);
    if (draft.site) {
        const siteError = validateSiteGeometry(draft.site);
        if (siteError) throw preparationError(BINDING_CODES.invalidSite, siteError, 400);
    }
    const inputs = geometricInputsDigest(draft);

    let corridor = null;
    let site = draft.site ? normalizeSiteGeometry(draft.site) : null;
    if (isConstructedCorridor(draft)) {
        // The server builds the corridor's land from its lanes; a client polygon is never used.
        const definition = authoredDefinition(draft.roadProposal.definition);
        let materialized;
        try {
            materialized = corridorFootprint.materialize(definition);
        } catch (error) {
            throw preparationError(BINDING_CODES.invalidSite, `The corridor cannot be built: ${String(error.message).replace(/^(corridor-footprint|metric-frame): /, '')}.`, 400);
        }
        corridor = { polygon: materialized.polygon, constructionFrame: materialized.constructionFrame };
        // The same caps as any site: vertex count and extent bound what the binding has to search.
        const landError = validateSiteGeometry(materialized.polygon);
        if (landError) throw preparationError(BINDING_CODES.invalidSite, `The corridor's land is too large to bind: ${landError}`, 400);
        site = site || normalizeSiteGeometry(materialized.polygon);
        draft.roadProposal = { ...draft.roadProposal, definition: { ...definition, ...corridor } };
    }

    const declared = Array.isArray(draft.cadastreParcelIds) ? draft.cadastreParcelIds.map(String) : [];
    const bound = await checkProposalBinding(db, draft, declared, { site, toleranceM: tolerance.value, city, parcelSourceId, now, derive: true });
    if (!bound.ok) {
        const { ok: _ok, status, code, error, ...details } = bound;
        throw preparationError(code, error, status, details);
    }
    const storedSite = bound.site ? normalizeSiteGeometry(bound.site) : null;
    // Content-addressed, so no clock inside: the binding's computedAt is the signed preparedAt,
    // stamped back at publication.
    const { computedAt: _computedAt, ...binding } = bound.binding;
    // Through JSON once, so the digest is over exactly what jsonb stores and hands back.
    const artifact = JSON.parse(JSON.stringify({
        protocol: PREPARE_PROTOCOL,
        inputs,
        // The city the site belongs to (publication-city.js), and the one the author asked for
        // when it differs: a publication may name either, and is stored under the first.
        city: bound.city || null,
        ...(city && bound.city !== city ? { requestedCity: city } : {}),
        parcelSourceId: parcelSourceId || null,
        toleranceM: tolerance.value,
        site: storedSite,
        siteHash: storedSite ? await siteHashApi.siteHashHex(storedSite) : null,
        binding,
        cadastreParcelIds: bound.cadastreParcelIds,
        corridor,
        cadastreRevision: await cadastreRevision(db, bound.binding)
    }));
    const digest = artifactDigest(artifact);
    const preparationId = preparationIdFor(digest);
    const preparedAt = now().toISOString();
    const signature = preparationSignature(digest, preparedAt, signingKey);
    const preparation = { id: preparationId, digest, preparedAt, signature };
    const proposal = {
        ...draft,
        ...(artifact.city ? { city: artifact.city } : {}),
        toleranceM: tolerance.value,
        cadastreParcelIds: artifact.cadastreParcelIds,
        preparation,
        preparedArtifact: artifact,
        ...(parcelSourceId ? { parcelSourceId } : {})
    };
    return { preparationId, digest, preparedAt, signature, artifact, proposal };
}

// The artifact row a publication stores beside itself (routes/proposals.js inserts it in the same
// statement as the record; the transit importer, which writes rows directly, inserts it itself).
export const PREPARED_INSERT_COLUMNS = '(id, digest, artifact, city, prepared_at)';
export function preparedRowValues(verified) {
    return [verified.preparationId, verified.digest, JSON.stringify(verified.artifact), verified.artifact.city || null, verified.preparedAt];
}
export async function storePreparedArtifact(db, verified) {
    await db.query(`INSERT INTO ${PREPARED_TABLE} ${PREPARED_INSERT_COLUMNS} VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (id) DO NOTHING`,
        preparedRowValues(verified));
}

// Mean boundary separation of two polygons in a metric frame (symmetric-difference area over mean
// perimeter), and whether they have the same components and holes.
function agreement(a, b, frame) {
    const turf = requireCjs('@turf/turf');
    const polygonsOf = geometry => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
    const toMetric = geometry => turf.multiPolygon(polygonsOf(geometry).map(rings => rings.map(ring => ring.map(position => frame.toMetric(position)))));
    const shape = geometry => polygonsOf(geometry).map(rings => rings.length).sort().join(',');
    // Planar shoelace and lengths on metric rings: turf.area/length would read metres as degrees.
    const planarArea = feature => {
        if (!feature) return 0;
        const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        let total = 0;
        for (const rings of polygons) {
            rings.forEach((ring, index) => {
                let sum = 0;
                for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
                total += (index === 0 ? 1 : -1) * Math.abs(sum) / 2;
            });
        }
        return total;
    };
    const perimeter = feature => feature.geometry.coordinates.flat().reduce((sum, ring) => {
        let length = 0;
        for (let i = 0; i < ring.length - 1; i += 1) length += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
        return sum + length;
    }, 0);
    const ma = toMetric(a);
    const mb = toMetric(b);
    // turf 6.5 (backend and browser): difference(a, b)
    const symmetric = planarArea(turf.difference(ma, mb)) + planarArea(turf.difference(mb, ma));
    const meanPerimeter = (perimeter(ma) + perimeter(mb)) / 2;
    return { separationM: meanPerimeter > 0 ? symmetric / meanPerimeter : 0, sameShape: shape(a) === shape(b) };
}

/**
 * Verify a publication against its prepared artifact. Changes nothing.
 * @param {object} body the POST /proposals body: `preparation: { id, digest, preparedAt, signature }`
 *   and the artifact itself, `preparedArtifact`, as POST /proposals/prepare returned them
 * @param {{ city: string|null, signingKey?: string }} context `city` normalised as at preparation
 * @returns {{ preparationId, digest, preparedAt, artifact, city, site, binding, cadastreParcelIds,
 *   corridor }} what publication stores (`city`: where the site was placed)
 * Throws an error with `code` and `status` on refusal.
 */
export function verifyPreparation(body, { city = null, signingKey } = {}) {
    const reference = body?.preparation;
    if (!reference || typeof reference.id !== 'string' || typeof reference.digest !== 'string') {
        throw preparationError(PREPARE_CODES.required, 'This proposal must be prepared first (POST /proposals/prepare) and published with its preparation and preparedArtifact.');
    }
    const artifact = body.preparedArtifact;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        throw preparationError(PREPARE_CODES.unknown, 'Publish the prepared artifact (preparedArtifact) with its preparation, as POST /proposals/prepare returned it.');
    }
    // The server signed exactly this artifact at exactly this time; anything else is not its preparation.
    const digest = artifactDigest(artifact);
    const preparedAt = typeof reference.preparedAt === 'string' ? reference.preparedAt : '';
    if (digest !== reference.digest || preparationIdFor(digest) !== reference.id
        || !Number.isFinite(Date.parse(preparedAt))
        || !signatureMatches(preparationSignature(digest, preparedAt, signingKey), reference.signature)) {
        throw preparationError(PREPARE_CODES.invalid, 'The preparation was not signed by this server for this artifact; prepare it again.');
    }
    if (artifact.protocol !== PREPARE_PROTOCOL) throw preparationError(PREPARE_CODES.stale, `The preparation is of protocol ${artifact.protocol}; prepare it again.`);

    const mismatch = what => preparationError(PREPARE_CODES.mismatch, `The proposal's ${what} differs from what was prepared; prepare it again.`);
    // Either the city the site was placed in or the one the author asked for (an older client
    // publishes the city it requested; publication stores the placed one).
    if (![artifact.city || null, artifact.requestedCity || artifact.city || null].includes(city || null)) throw mismatch('city');
    if ((artifact.parcelSourceId || null) !== (body.parcelSourceId || null)) throw mismatch('parcel source');
    const tolerance = parseTolerance(body.toleranceM);
    if (!tolerance.ok || tolerance.value !== artifact.toleranceM) throw mismatch('tolerance');
    if (geometricInputsDigest(body) !== artifact.inputs) throw mismatch('geometry');
    const declared = (Array.isArray(body.cadastreParcelIds) ? body.cadastreParcelIds.map(String) : []).sort();
    if (stableStringify(declared) !== stableStringify([...(artifact.cadastreParcelIds || [])].sort())) throw mismatch('parcel declaration');

    if (artifact.corridor) {
        const definition = body.roadProposal.definition;
        // The record carries the prepared land exactly: what the author saw is what is stored.
        if (stableStringify(definition.polygon) !== stableStringify(artifact.corridor.polygon)) throw mismatch('corridor land');
        if (stableStringify(definition.constructionFrame) !== stableStringify(artifact.corridor.constructionFrame)) throw mismatch('construction frame');
        // Re-derive with the same recipe in the same frame when this server runs the artifact's
        // pinned versions: it must reproduce the artifact. Other versions leave the stored artifact
        // authoritative — it is never replaced after minting.
        const provenance = artifact.corridor.constructionFrame;
        const frame = metricFrame.frameFromProvenance(provenance);
        const current = corridorFootprint.materialize(authoredDefinition(definition), { frame }).constructionFrame;
        if (current.algorithm === provenance.algorithm && current.proj4 === provenance.proj4 && current.turf === provenance.turf) {
            const again = corridorFootprint.materialize(authoredDefinition(definition), { frame }).polygon;
            if (stableStringify(again) !== stableStringify(artifact.corridor.polygon)) {
                const { separationM, sameShape } = agreement(again, artifact.corridor.polygon, frame);
                if (!sameShape || separationM > AGREEMENT_M) {
                    throw preparationError(PREPARE_CODES.stale, `Re-deriving the corridor no longer reproduces the prepared land (${(separationM * 1000).toFixed(2)} mm, ${sameShape ? 'same' : 'different'} shape); prepare it again.`);
                }
            }
        }
    }
    return {
        preparationId: reference.id,
        digest,
        preparedAt: new Date(preparedAt).toISOString(),
        artifact,
        city: artifact.city || null,
        site: artifact.site,
        binding: { ...artifact.binding, computedAt: new Date(preparedAt).toISOString() },
        cadastreParcelIds: artifact.cadastreParcelIds,
        corridor: artifact.corridor
    };
}
