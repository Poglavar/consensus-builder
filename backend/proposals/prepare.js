// Prepared publication artifacts (projections.md §3). A proposal is prepared ONCE, before anything is
// uploaded or minted: the server materialises what it derives (a corridor's land, from its lanes, in
// its own operation frame), binds the site to the cadastre, hashes it, and stores the result as an
// immutable artifact. Metadata upload, minting and POST /proposals then all reference that exact
// artifact, and publication stores the artifact itself — a re-derivation at publish only VALIDATES
// it. Without this, a 0.16 mm shift across a rounding boundary between what was minted and what was
// stored changes the on-chain site hash.
//
// Content-addressed: the artifact's id is its digest, so preparing the same proposal against the
// same cadastre twice returns the same artifact (a retry is free and cannot fork).

import { createHash } from 'node:crypto';
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
    invalid: 'preparation-invalid'        // the stored artifact fails its own digest
});
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
 * @param {{ city?: string|null, parcelSourceId?: string|null, toleranceM?: number, now?: () => Date }} options
 *   `city` already normalised by the caller (routes/proposals.js normalizeCityCode)
 * @returns {Promise<{ preparationId, digest, artifact, proposal }>} `proposal` is the record ready to
 *   publish: its derived corridor land, declaration, tolerance and preparation reference filled in.
 * Throws an error with `code` and `status` (binding codes) on refusal.
 */
export async function prepareProposal(db, record, { city = null, parcelSourceId = null, toleranceM, now = () => new Date() } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw preparationError(BINDING_CODES.invalidSite, 'The proposal must be a JSON object.', 400);
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
    // Content-addressed, so no clock inside: the binding's computedAt is the artifact row's
    // created_at — when this exact binding was first computed — stamped back at publication.
    const { computedAt: _computedAt, ...binding } = bound.binding;
    // Through JSON once, so the digest is over exactly what jsonb stores and hands back.
    const artifact = JSON.parse(JSON.stringify({
        protocol: PREPARE_PROTOCOL,
        inputs,
        city: city || null,
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
    await db.query(`INSERT INTO ${PREPARED_TABLE} (id, digest, artifact, city) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (id) DO NOTHING`,
        [preparationId, digest, JSON.stringify(artifact), artifact.city]);
    const proposal = {
        ...draft,
        toleranceM: tolerance.value,
        cadastreParcelIds: artifact.cadastreParcelIds,
        preparation: { id: preparationId, digest },
        ...(parcelSourceId ? { parcelSourceId } : {})
    };
    return { preparationId, digest, artifact, proposal };
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
 * @param db pg pool/client
 * @param {object} body the POST /proposals body (carries `preparation: { id, digest }`)
 * @param {{ city: string|null }} context `city` normalised as at preparation
 * @returns {Promise<{ preparationId, digest, site, binding, cadastreParcelIds, corridor }>} what
 *   publication stores
 * Throws an error with `code` and `status` on refusal.
 */
export async function verifyPreparation(db, body, { city = null } = {}) {
    const reference = body?.preparation;
    if (!reference || typeof reference.id !== 'string' || typeof reference.digest !== 'string') {
        throw preparationError(PREPARE_CODES.required, 'This proposal must be prepared first (POST /proposals/prepare) and published with its preparation { id, digest }.');
    }
    const { rows } = await db.query(`SELECT digest, artifact, created_at FROM ${PREPARED_TABLE} WHERE id = $1`, [reference.id]);
    const row = rows[0];
    if (!row) throw preparationError(PREPARE_CODES.unknown, `No prepared artifact ${reference.id}.`);
    if (row.digest !== reference.digest) throw preparationError(PREPARE_CODES.mismatch, 'The preparation digest does not match the prepared artifact.');
    const artifact = row.artifact;
    if (artifactDigest(artifact) !== row.digest) throw preparationError(PREPARE_CODES.invalid, 'The prepared artifact no longer matches its own digest.', 500);

    const mismatch = what => preparationError(PREPARE_CODES.mismatch, `The proposal's ${what} differs from what was prepared; prepare it again.`);
    if ((artifact.city || null) !== (city || null)) throw mismatch('city');
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
        digest: row.digest,
        site: artifact.site,
        binding: { ...artifact.binding, computedAt: new Date(row.created_at).toISOString() },
        cadastreParcelIds: artifact.cadastreParcelIds,
        corridor: artifact.corridor
    };
}
