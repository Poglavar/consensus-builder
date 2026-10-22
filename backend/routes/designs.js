// The design index (plan-design-agreement.md, M2 "Courier and index"). POST /designs takes a design/v1
// object the browser addressed itself, { cid, content }, refuses it unless its canonical bytes hash to
// that CID and it has the design/v1 shape (frontend/js/design-record.js validate, the check the browser
// makes), and stores it with what the server derives from it: the city its site lies in
// (proposals/publication-city.js) and its binding, the parcels its site takes, derived as
// checkProposalBinding derives them for a new proposal, with nothing declared to compare. GET
// /designs/:cid, GET /designs?city&bbox and POST /designs/batch read the index back. The content is
// stored exactly as addressed; the other columns index it and never stand in for it. A parcel layout is
// indexed only with the agreement that settles its land (routes/agreements.js, through prepareDesign
// and insertDesign inside its own publish).

import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { checkProposalBinding, normalizeSiteGeometry, parseTolerance, validateSiteGeometry, BINDING_CODES } from '../proposals/binding.js';
import { INVALID_FOOTPRINT, footprintParts, hasFootprint } from '../proposals/footprint.js';
import { isPlainObject } from '../utils/request-validation.js';
import { publicApiBaseUrl } from '../utils/public-base-url.js';
import { defaultThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { designDocument, SEMANTIC_BASE_ERROR, SEMANTIC_RECORD_ERROR } from '../semantics/published-records.js';

const require = createRequire(import.meta.url);
const designRecord = require('../../frontend/js/design-record.js');
const corridorOsmForm = require('../../frontend/js/corridor-osm-form.js');

export const DESIGN_TABLE = 'consensus.design';
export const DESIGN_SCHEMA = designRecord.SCHEMA;
export const DEFAULT_DESIGN_LIST_LIMIT = 100;
export const MAX_DESIGN_LIST_LIMIT = 1000;
export const MAX_DESIGN_BATCH = 1000;
const MAX_CITY_LENGTH = 100;
const MAX_SOURCE_ID_LENGTH = 100;

const COLUMNS = `cid, city, goal, title, author, origin_cid, binding, content,
    screenshot_url, screenshot_before_url, screenshot_pair_url, created_at`;

const log = message => console.log(`[${new Date().toISOString()}] [designs] ${message}`);
const refusal = (status, code, error, extra = {}) => ({ refusal: { status, body: { error, code, ...extra } } });
const iso = value => (value instanceof Date ? value.toISOString() : value ?? null);

/** A design row as every /designs route answers it. */
export function serializeDesignRow(row) {
    return {
        cid: row.cid,
        city: row.city ?? null,
        goal: row.goal,
        title: row.title ?? null,
        author: row.author ?? null,
        originCid: row.origin_cid ?? null,
        binding: row.binding,
        content: row.content,
        screenshotUrl: row.screenshot_url ?? null,
        screenshotBeforeUrl: row.screenshot_before_url ?? null,
        screenshotPairUrl: row.screenshot_pair_url ?? null,
        createdAt: iso(row.created_at)
    };
}

export async function loadDesign(db, cid) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${DESIGN_TABLE} WHERE cid = $1`, [cid]);
    return rows.length ? serializeDesignRow(rows[0]) : null;
}

/** Indexed designs by CID (a Map holding only the ones found). */
export async function loadDesigns(db, cids) {
    if (!cids.length) return new Map();
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${DESIGN_TABLE} WHERE cid = ANY($1::text[])`, [cids]);
    return new Map(rows.map(row => [row.cid, serializeDesignRow(row)]));
}

/**
 * The design/v1 checks that need no database: the shared shape (design-record.js validate), then
 * what binding needs on top of it (a measurable site, a tolerance within range).
 * @returns {{ ok: true, site: object|null, toleranceM: number } | { ok: false, status, code, error, errors? }}
 */
export function validateDesignContent(content) {
    const checked = designRecord.validate(content);
    if (!checked.valid) {
        return { ok: false, status: 400, code: 'invalid-design', error: checked.errors[0].message, errors: checked.errors };
    }
    const siteError = content.site ? validateSiteGeometry(content.site) : null;
    if (siteError) return { ok: false, status: 400, code: BINDING_CODES.invalidSite, error: siteError };
    const tolerance = parseTolerance(content.toleranceM);
    if (!tolerance.ok) return { ok: false, status: 400, code: BINDING_CODES.invalidTolerance, error: tolerance.error };
    return { ok: true, site: content.site ? normalizeSiteGeometry(content.site) : null, toleranceM: tolerance.value };
}

// The design as checkProposalBinding reads a proposal: its ground and nothing else. No goal, kind or
// role, so no design counts as an act on parcels by its type (a design names no parcels; its
// agreement does), and a corridor stored as its OSM record is read in its running shape, as
// proposals/footprint.js proposalGeometryView reads a stored row.
function bindingShape(content) {
    const road = content.roadProposal;
    return {
        geometry: content.geometry ?? null,
        roadProposal: road?.definition && typeof road.definition === 'object'
            ? { ...road, definition: corridorOsmForm.toView(road.definition) }
            : road ?? null,
        buildingProposal: content.buildingProposal ?? null,
        structureProposal: content.structureProposal ?? null,
        parcelLayout: content.parcelLayout ?? null
    };
}

// { west, south, east, north } of a MultiPolygon, for clients that frame a design without its geometry.
function boundsOf(site) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const polygon of site?.coordinates || []) {
        for (const ring of polygon) {
            for (const [x, y] of ring) {
                if (x < west) west = x;
                if (x > east) east = x;
                if (y < south) south = y;
                if (y > north) north = y;
            }
        }
    }
    return Number.isFinite(west) ? { west, south, east, north } : null;
}

// A binding that could not be computed. A provider outage or a refusal with its own status keeps it;
// anything else is 503, with nothing stored.
function bindingFailure(error) {
    if (error?.code?.startsWith?.('parcel-source-')) {
        return refusal(error.status || 503, error.code, error.message,
            { upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds });
    }
    if (error && error.code && Number.isInteger(error.status) && error.status < 500) {
        return refusal(error.status, error.code, error.message, error.count ? { count: error.count } : {});
    }
    console.error(`[${new Date().toISOString()}] [designs] binding failed:`, error);
    return refusal(503, 'binding-unavailable', 'The parcels under the design could not be derived; nothing was stored. Try again.');
}

/**
 * Everything POST /designs checks and derives before writing, without writing:
 *   { refusal: { status, body } } — the request is refused (nothing to store);
 *   { existing: row }             — the CID is already indexed (its content is this content);
 *   { prepared }                  — the row to insert: { cid, content, city, goal, title, author,
 *                                   originCid, site, bounds, binding }.
 * @param {{ cid: string, content: object }} input
 * @param {{ allowLayout?: boolean, parcelSourceId?: string|null }} options  allowLayout: the caller is
 *   the agreement that settles a parcel layout's land; parcelSourceId: the parcel source to bind with
 *   (the city's default when null)
 */
export async function prepareDesign(db, { cid, content } = {}, { allowLayout = false, parcelSourceId = null } = {}) {
    if (!isCid(cid)) return refusal(400, 'invalid-cid', 'cid must be a CIDv1 raw sha2-256 base32 CID (bafkrei…).');
    if (!isPlainObject(content)) return refusal(400, 'invalid-design', `content must be a ${designRecord.SCHEMA} object.`);
    let bytes;
    try { bytes = canonicalBytes(content); } catch (error) { return refusal(400, 'invalid-design', error.message); }
    if (bytes.length > MAX_PINNED_OBJECT_BYTES) {
        return refusal(413, 'too-large', `A design is at most ${MAX_PINNED_OBJECT_BYTES} bytes; this one is ${bytes.length}.`);
    }
    const computedCid = cidOf(bytes);
    if (computedCid !== cid) return refusal(400, 'cid-mismatch', `The content is ${computedCid}, not ${cid}.`, { cid, computedCid });
    const checked = validateDesignContent(content);
    if (!checked.ok) {
        const { ok: _ok, status, ...body } = checked;
        return { refusal: { status, body } };
    }

    const existing = await loadDesign(db, cid);
    if (existing) return { existing };
    if (content.parcelLayout != null && !allowLayout) {
        return refusal(422, 'layout-needs-agreement',
            'A parcel layout is published with the agreement that settles its land: send it in the designs of POST /agreements.');
    }

    let shape;
    try { shape = bindingShape(content); } catch (error) {
        return refusal(400, 'invalid-design', `The road cannot be read: ${String(error.message).replace(/^corridor-osm-form: /, '')}.`);
    }
    const parts = footprintParts(shape);
    if (parts.corridorUnprepared) {
        return refusal(400, INVALID_FOOTPRINT, 'The road has a centre line but no land of its own: a road design carries its corridor polygon (roadProposal.definition.polygon).');
    }
    // The width/2 buffer of a flagged legacy centre line reads stored legacy rows; a published design
    // is new, so it carries its land like any road drawn today (prepare.js used to strip the flag).
    if (parts.approximate) {
        return refusal(400, INVALID_FOOTPRINT, 'The road has only a legacy centre line: a road design carries its corridor polygon (roadProposal.definition.polygon).');
    }
    if (parts.invalid) return refusal(400, INVALID_FOOTPRINT, `The design's geometry is invalid: ${parts.invalid}.`);
    if (!checked.site && !hasFootprint(parts)) {
        return refusal(400, BINDING_CODES.siteRequired, 'A design is bound by its ground: it needs a site, or polygon geometry of its own.');
    }

    let result;
    try {
        result = await checkProposalBinding(db, shape, [], {
            site: checked.site,
            toleranceM: checked.toleranceM,
            city: normalizeCityCode(content.city) || null,
            parcelSourceId,
            derive: true
        });
    } catch (error) {
        return bindingFailure(error);
    }
    if (!result.ok) {
        // A design is never an act on parcels (site-binding.js has no parcel acts): a road designation
        // binds by its polygon like any footprint, so what refuses here is the ground itself.
        const { ok: _ok, status, ...body } = result;
        return { refusal: { status, body } };
    }
    const site = result.site ?? null;
    return {
        prepared: {
            cid,
            content,
            city: result.city || null,
            goal: content.goal.trim(),
            title: content.title ?? null,
            author: content.author ?? null,
            originCid: content.origin?.cid ?? null,
            site,
            bounds: boundsOf(site),
            binding: result.binding
        }
    };
}

/**
 * Writes a prepared design (prepareDesign). Returns { row, created }: created is false when another
 * request indexed the same CID first, and row is then that one.
 */
export async function insertDesign(db, prepared) {
    const { rows } = await db.query(`
        INSERT INTO ${DESIGN_TABLE} (cid, city, goal, title, author, site, bounds, binding, content, origin_cid)
        VALUES ($1, $2, $3, $4, $5,
                ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($6::text), 4326)), 3)),
                $7::jsonb, $8::jsonb, $9::jsonb, $10)
        ON CONFLICT (cid) DO NOTHING
        RETURNING ${COLUMNS}`, [
        prepared.cid, prepared.city, prepared.goal, prepared.title, prepared.author,
        prepared.site ? JSON.stringify(prepared.site) : null,
        prepared.bounds ? JSON.stringify(prepared.bounds) : null,
        JSON.stringify(prepared.binding),
        JSON.stringify(prepared.content),
        prepared.originCid
    ]);
    if (rows.length) return { row: serializeDesignRow(rows[0]), created: true };
    return { row: await loadDesign(db, prepared.cid), created: false };
}

/** Queues the server thumbnail of a newly indexed design (thumbnails/thumbnail-queue.js). */
export function enqueueDesignThumbnail(pool, deps, prepared) {
    (deps.thumbnailQueue || defaultThumbnailQueue()).enqueue({
        pool,
        design: { cid: prepared.cid, city: prepared.city, content: prepared.content, binding: prepared.binding },
        baseUrl: deps.baseUrl ?? publicApiBaseUrl()
    });
}

/**
 * Indexes one design: prepareDesign, insertDesign and its thumbnail. Returns { refusal } or
 * { status: 201 | 409, row } (409: the CID was already indexed; the row is the indexed one).
 * @param pool pg pool
 * @param deps { thumbnailQueue?, baseUrl? }
 */
export async function indexDesign(pool, deps, input, options = {}) {
    const outcome = await prepareDesign(pool, input, options);
    if (outcome.refusal) return outcome;
    if (outcome.existing) return { status: 409, row: outcome.existing };
    const { row, created } = await insertDesign(pool, outcome.prepared);
    if (created) {
        enqueueDesignThumbnail(pool, deps, outcome.prepared);
        log(`indexed ${row.cid} (${row.goal}, ${row.city || 'no city'}, ${row.binding?.parcels?.length ?? 0} bound parcel(s))`);
    }
    return { status: created ? 201 : 409, row };
}

// 'minLng,minLat,maxLng,maxLat' in ordered WGS84 coordinates, or { error }.
function parseBbox(raw) {
    const pieces = typeof raw === 'string' ? raw.split(',').map(value => value.trim()) : [];
    const bbox = pieces.map(Number);
    if (bbox.length !== 4 || pieces.some(value => value === '') || !bbox.every(Number.isFinite)
        || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] > bbox[2] || bbox[1] > bbox[3]) {
        return { error: 'bbox must be minLng,minLat,maxLng,maxLat in ordered WGS84 coordinates.' };
    }
    return { bbox };
}

export function parseListLimit(raw) {
    const limit = Number.parseInt(raw, 10);
    return Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_DESIGN_LIST_LIMIT) : DEFAULT_DESIGN_LIST_LIMIT;
}

function sendRefusal(res, { status, body }) {
    if (body.retryAfterSeconds !== undefined) res.set('Retry-After', String(body.retryAfterSeconds));
    return res.status(status).json(body);
}

/**
 * POST /designs, POST /designs/batch, GET /designs/:cid, GET /designs.
 * @param deps { pool, thumbnailQueue?, baseUrl? } (routes/content-routes.js)
 */
export function setupDesignsRoute(app, deps) {
    const { pool } = deps;

    // { cid, content, parcelSourceId? } → 201 the row; 409 the row when the CID is already indexed.
    // parcelSourceId is a binding parameter, never content: the parcel source the site is bound with.
    app.post('/designs', async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['cid', 'content', 'parcelSourceId'].includes(key))) {
            return res.status(400).json({ error: 'Body must be { cid, content, parcelSourceId? }.', code: 'bad-request' });
        }
        const parcelSourceId = body.parcelSourceId ?? null;
        if (parcelSourceId !== null && (typeof parcelSourceId !== 'string' || !parcelSourceId || parcelSourceId.length > MAX_SOURCE_ID_LENGTH)) {
            return res.status(400).json({ error: 'parcelSourceId must be a parcel source id or null.', code: 'bad-request' });
        }
        try {
            const outcome = await indexDesign(pool, deps, { cid: body.cid, content: body.content }, { parcelSourceId });
            if (outcome.refusal) return sendRefusal(res, outcome.refusal);
            return res.status(outcome.status).json(outcome.row);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in POST /designs:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // { cids: [] } → { items: [{ cid, design | null }], count }, in request order without duplicates.
    app.post('/designs/batch', async (req, res) => {
        const body = req.body;
        const cids = isPlainObject(body) && Object.keys(body).length === 1 ? body.cids : null;
        if (!Array.isArray(cids) || !cids.length || cids.length > MAX_DESIGN_BATCH || !cids.every(isCid)) {
            return res.status(400).json({ error: `Body must be { cids: [1 to ${MAX_DESIGN_BATCH} CIDs] }.`, code: 'bad-request' });
        }
        try {
            const unique = [...new Set(cids)];
            const found = await loadDesigns(pool, unique);
            const items = unique.map(cid => ({ cid, design: found.get(cid) ?? null }));
            return res.json({ items, count: found.size });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in POST /designs/batch:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/designs/:cid', async (req, res) => {
        const cid = String(req.params.cid || '');
        if (!isCid(cid)) return res.status(400).json({ error: 'Not a design CID.', code: 'invalid-cid' });
        try {
            const row = await loadDesign(pool, cid);
            if (!row) return res.status(404).json({ error: 'Design not found', code: 'design-not-found' });
            if (req.query.format === 'jsonld') return res.type('application/ld+json').json(designDocument(row));
            return res.json(row);
        } catch (error) {
            if (error && (error.code === SEMANTIC_BASE_ERROR || error.code === SEMANTIC_RECORD_ERROR)) {
                return res.status(error.status || 500).json({ error: error.message, code: error.code });
            }
            console.error(`[${new Date().toISOString()}] Error in GET /designs/${cid}:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // { site, toleranceM?, city?, parcelSourceId? } → the binding the server would give a design on
    // that site (parcels, coverage, open ground), for the site tool's live preview. Nothing is stored.
    app.post('/designs/binding', async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || !body.site) return res.status(400).json({ error: 'Body must be { site, toleranceM?, city?, parcelSourceId? }.', code: 'bad-request' });
        // validateSiteGeometry answers a reason (it does not throw): checked before any statement, as POST /designs does.
        const siteError = validateSiteGeometry(body.site);
        if (siteError) return res.status(400).json({ error: siteError, code: BINDING_CODES.invalidSite });
        const site = normalizeSiteGeometry(body.site);
        const tolerance = parseTolerance(body.toleranceM);
        if (!tolerance.ok) return res.status(400).json({ error: tolerance.error, code: BINDING_CODES.invalidTolerance });
        const toleranceM = tolerance.value;
        try {
            const result = await checkProposalBinding(pool, { site }, [], {
                site, toleranceM, city: body.city ? normalizeCityCode(body.city) : null,
                parcelSourceId: typeof body.parcelSourceId === 'string' ? body.parcelSourceId : null, derive: true
            });
            if (!result.ok) {
                const { ok: _ok, status, ...refused } = result;
                return res.status(status || 400).json(refused);
            }
            return res.json({ city: result.city ?? null, parcelSourceId: result.parcelSourceId ?? null, binding: result.binding });
        } catch (error) {
            // A refusal with its own status (too many parcels, an unmeasurable site, a parcel source
            // outage) keeps it, as in POST /designs; anything else is 503 binding-unavailable.
            return sendRefusal(res, bindingFailure(error).refusal);
        }
    });

    // ?city=&bbox=minLng,minLat,maxLng,maxLat&q=&limit= → { designs, count }, newest first. `q`
    // matches the title or the author, case-insensitively (the map search's design group).
    app.get('/designs', async (req, res) => {
        const { city: rawCity, bbox: rawBbox, limit: rawLimit, q: rawQuery } = req.query;
        if (rawCity !== undefined && (typeof rawCity !== 'string' || rawCity.length > MAX_CITY_LENGTH)) {
            return res.status(400).json({ error: `city must be a string of at most ${MAX_CITY_LENGTH} characters.`, code: 'bad-request' });
        }
        if (rawQuery !== undefined && (typeof rawQuery !== 'string' || rawQuery.length > 200)) {
            return res.status(400).json({ error: 'q must be a string of at most 200 characters.', code: 'bad-request' });
        }
        const parsed = rawBbox === undefined ? { bbox: null } : parseBbox(rawBbox);
        if (parsed.error) return res.status(400).json({ error: parsed.error, code: 'invalid-bbox' });
        const clauses = [];
        const params = [];
        const city = normalizeCityCode(rawCity);
        if (city) {
            params.push(city);
            clauses.push(`city = $${params.length}`);
        }
        const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
        if (query) {
            params.push(`%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`);
            clauses.push(`(title ILIKE $${params.length} OR author ILIKE $${params.length})`);
        }
        if (parsed.bbox) {
            params.push(...parsed.bbox);
            const envelope = `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, 4326)`;
            clauses.push(`site && ${envelope} AND ST_Intersects(site, ${envelope})`);
        }
        params.push(parseListLimit(rawLimit));
        try {
            const { rows } = await pool.query(`
                SELECT ${COLUMNS} FROM ${DESIGN_TABLE}
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                ORDER BY created_at DESC, cid
                LIMIT $${params.length}`, params);
            return res.json({ designs: rows.map(serializeDesignRow), count: rows.length });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in GET /designs:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });
}
