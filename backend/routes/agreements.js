// The agreement index (plan-design-agreement.md, M2 "Courier and index"). POST /agreements takes an
// agreement/v1 object the browser addressed itself, { cid, content, designs? }, and indexes it once the
// server has checked what it can: the CID is the content's; the shape is agreement/v1; every design it
// links is indexed (one not yet indexed, such as a parcel layout, which publishes only with its
// agreement, comes along in `designs` and is indexed in the same transaction as the agreement); its
// input parcels are exactly the parcels its designs' sites take on the server (the former
// "declaration equals binding" rule, now per agreement); its rights snapshot is well formed; its
// deadline lies ahead. GET /agreements/:cid and GET /agreements?city&design&parcel read the index back
// with the status computed from the deadline; owner decisions are relayed at /agreements/:cid/decisions
// (agreements/decisions.js).

import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { COVERAGE } from '../proposals/binding.js';
import { isPlainObject } from '../utils/request-validation.js';
import { publicApiBaseUrl } from '../utils/public-base-url.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
import { defaultThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { enqueueDesignThumbnail, insertDesign, loadDesigns, parseListLimit, prepareDesign } from './designs.js';
import { normalizeCityCode } from './proposals.js';
import { agreementDocument, SEMANTIC_BASE_ERROR, SEMANTIC_RECORD_ERROR } from '../semantics/published-records.js';
import { createAgreementDecisionHandlers, createAgreementDecisionStore } from '../agreements/decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const allocation = require('../../frontend/js/reparcellization-allocation.js');

export const AGREEMENT_TABLE = 'consensus.agreement';
export const AGREEMENT_SCHEMA = agreementRecord.PUBLISHED_SCHEMA;
// Designs one agreement may link (and index in one publish): each is a PostGIS binding when new.
export const MAX_AGREEMENT_DESIGNS = 200;
// An output piece's content hash (AgreementRecord.outputHash): the prefix, then 64 hex digits.
const isOutputHash = value => typeof value === 'string' && value.startsWith(agreementRecord.OUTPUT_HASH_PREFIX)
    && /^[0-9a-f]{64}$/.test(value.slice(agreementRecord.OUTPUT_HASH_PREFIX.length));
const ALLOCATION_KINDS = ['holders', 'party', 'public', 'joint'];
const ELECTORATES = ['owners', 'community'];
const MAX_TEXT = { title: 500, author: 255, city: 100 };
const MAX_ID_LENGTH = 256;

// Expired once the deadline has passed, else active; executed and cancelled come from the chain (M3).
const STATUS_SQL = `CASE WHEN deadline IS NOT NULL AND deadline <= now() THEN 'expired' ELSE 'active' END`;
const COLUMNS = `cid, city, title, author, design_cids, input_parcel_ids, parcel_source_id, deadline, ${STATUS_SQL} AS status,
    content, onchain, screenshot_url, screenshot_before_url, screenshot_pair_url, created_at`;

const log = message => console.log(`[${new Date().toISOString()}] [agreements] ${message}`);
const iso = value => (value instanceof Date ? value.toISOString() : value ?? null);
const isInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const isArea = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isShare = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;

/** An agreement row as every /agreements route answers it. */
export function serializeAgreementRow(row) {
    return {
        cid: row.cid,
        city: row.city ?? null,
        title: row.title ?? null,
        author: row.author ?? null,
        designCids: row.design_cids,
        inputParcelIds: row.input_parcel_ids,
        parcelSourceId: row.parcel_source_id ?? null,
        deadline: iso(row.deadline),
        status: row.status,
        content: row.content,
        onchain: row.onchain ?? null,
        screenshotUrl: row.screenshot_url ?? null,
        screenshotBeforeUrl: row.screenshot_before_url ?? null,
        screenshotPairUrl: row.screenshot_pair_url ?? null,
        createdAt: iso(row.created_at)
    };
}

export async function loadAgreement(db, cid) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${AGREEMENT_TABLE} WHERE cid = $1`, [cid]);
    return rows.length ? serializeAgreementRow(rows[0]) : null;
}

/**
 * The agreement/v1 checks that need no database, section by section as the agreement dialog groups
 * them (designs | land | allocation | money | rule | details). Party keys are not matched against the
 * holders: the published outputs carry none, and the lens judges who may receive what.
 * @param {{ now?: number }} options  the deadline must lie after `now`
 * @returns {{ ok: true, designCids, inputParcelIds, parcelSourceId, deadline }
 *   | { ok: false, status, code, section, error }}
 */
export function validateAgreementContent(content, { now = Date.now() } = {}) {
    const invalid = (section, error) => ({ ok: false, status: 400, code: 'invalid-agreement', section, error });
    if (!isPlainObject(content) || content.schema !== AGREEMENT_SCHEMA) return invalid('details', `Expected ${AGREEMENT_SCHEMA}.`);
    for (const [field, max] of Object.entries(MAX_TEXT)) {
        if (content[field] != null && !(typeof content[field] === 'string' && content[field].length <= max)) {
            return invalid('details', `${field} is text of at most ${max} characters, or null.`);
        }
    }
    if (content.createdAt != null && !isInstant(content.createdAt)) return invalid('details', 'createdAt is an ISO instant or null.');

    const { designs } = content;
    if (!Array.isArray(designs) || !designs.length) return invalid('designs', 'An agreement links at least one design.');
    if (designs.length > MAX_AGREEMENT_DESIGNS) return invalid('designs', `An agreement links at most ${MAX_AGREEMENT_DESIGNS} designs.`);
    const designCids = [];
    for (const design of designs) {
        if (!isPlainObject(design) || !isCid(design.cid)) return invalid('designs', 'Every design is linked by its CID.');
        if (designCids.includes(design.cid)) return invalid('designs', `Design ${design.cid} is linked twice.`);
        designCids.push(design.cid);
    }

    const { inputs } = content;
    if (!isPlainObject(inputs) || !Array.isArray(inputs.parcels)) return invalid('land', 'The agreement lists its input parcels.');
    const parcelIds = new Set();
    const sources = new Set();
    for (const parcel of inputs.parcels) {
        if (!isPlainObject(parcel) || !isText(parcel.parcelId, MAX_ID_LENGTH)) return invalid('land', 'Every input parcel has an id.');
        if (parcelIds.has(parcel.parcelId)) return invalid('land', `Input parcel ${parcel.parcelId} is listed twice.`);
        parcelIds.add(parcel.parcelId);
        if (parcel.parcelSourceId != null) {
            if (!isText(parcel.parcelSourceId, MAX_ID_LENGTH)) return invalid('land', `Input parcel ${parcel.parcelId} has an invalid parcel source.`);
            sources.add(parcel.parcelSourceId);
        }
        if (parcel.areaM2 != null && !isArea(parcel.areaM2)) return invalid('land', `Input parcel ${parcel.parcelId} needs an area of at least 0, or null.`);
        if (!Array.isArray(parcel.holders)) return invalid('land', `Input parcel ${parcel.parcelId} lists its holders.`);
        const holders = new Set();
        for (const holder of parcel.holders) {
            if (!isPlainObject(holder) || !isText(holder.ownerKey, MAX_ID_LENGTH) || holders.has(holder.ownerKey) || !isShare(holder.share)) {
                return invalid('land', `Every holder of input parcel ${parcel.parcelId} needs a key of its own and a share above 0 and at most 1.`);
            }
            holders.add(holder.ownerKey);
        }
    }
    // The index keeps one parcel source per agreement: ids only mean something within their source.
    if (sources.size > 1) return invalid('land', 'The input parcels come from more than one parcel source.');
    if (inputs.openGroundM2 != null && !isArea(inputs.openGroundM2)) return invalid('land', 'The open ground is an area of at least 0.');
    if (!parcelIds.size && !(inputs.openGroundM2 > 0)) return invalid('land', 'The agreement settles no land.');

    if (!Array.isArray(content.outputs)) return invalid('land', 'The agreement lists its outputs.');
    const outputs = new Set();
    for (const output of content.outputs) {
        if (!isPlainObject(output) || !isOutputHash(output.hash)) {
            return invalid('land', `Every output is named by its piece hash (${agreementRecord.OUTPUT_HASH_PREFIX}…).`);
        }
        if (outputs.has(output.hash)) return invalid('land', `Output ${output.hash} is listed twice.`);
        outputs.add(output.hash);
        if (!isArea(output.areaM2)) return invalid('land', `Output ${output.hash} needs an area of at least 0.`);
        if (!Array.isArray(output.fromParcelIds) || !output.fromParcelIds.every(id => isText(id, MAX_ID_LENGTH))) {
            return invalid('land', `Output ${output.hash} lists the parcels it stands on.`);
        }
        if (!agreementRecord.ROLES.includes(output.role)) return invalid('land', `Output ${output.hash} has an unknown role.`);
        if (output.producedBy != null && !designCids.includes(output.producedBy)) {
            return invalid('land', `Output ${output.hash} is produced by a design the agreement does not link.`);
        }
    }

    if (!Array.isArray(content.allocations)) return invalid('allocation', 'Allocations are a list.');
    const allocated = new Set();
    for (const line of content.allocations) {
        if (!isPlainObject(line) || !outputs.has(line.output)) return invalid('allocation', 'An allocation names a piece that is not among the outputs.');
        if (allocated.has(line.output)) return invalid('allocation', `Output ${line.output} has two allocation lines.`);
        allocated.add(line.output);
        const to = line.to;
        if (!isPlainObject(to) || !ALLOCATION_KINDS.includes(to.kind)) return invalid('allocation', `The allocation of ${line.output} has an unknown kind.`);
        if (to.kind === 'party' && !isText(to.ownerKey, MAX_ID_LENGTH)) return invalid('allocation', `The allocation of ${line.output} names no party.`);
        if (to.kind === 'joint') {
            const shares = Array.isArray(to.shares) ? to.shares : null;
            if (!shares || shares.some(row => !isPlainObject(row) || !isShare(row.share))) {
                return invalid('allocation', `The joint allocation of ${line.output} needs shares above 0 and at most 1.`);
            }
            try {
                allocation.parsePercentShares(shares.map(row => ({ ownerKey: row.ownerKey, percent: row.share * 100 })));
            } catch (error) {
                return invalid('allocation', `The joint allocation of ${line.output}: ${error.message}`);
            }
        }
    }

    const { money } = content;
    if (!isPlainObject(money) || money.currency !== 'EUR' || !Array.isArray(money.lines)) {
        return invalid('money', 'Money is { currency: \'EUR\', lines: [] }: cash is settled in EUR.');
    }
    const payees = new Set();
    for (const line of money.lines) {
        if (!isPlainObject(line) || !isText(line.ownerKey, MAX_ID_LENGTH) || payees.has(line.ownerKey)) {
            return invalid('money', 'Every money line names its own party.');
        }
        payees.add(line.ownerKey);
        if (!Number.isSafeInteger(line.amountCents)) return invalid('money', `The cash of ${line.ownerKey} is not a whole number of cents.`);
    }

    const { rule } = content;
    if (!isPlainObject(rule) || !ELECTORATES.includes(rule.electorate) || typeof rule.binding !== 'boolean') {
        return invalid('rule', 'The rule names who decides (owners or community) and whether the decision binds.');
    }
    if (!Array.isArray(rule.lens)) return invalid('rule', 'The rule lists its lens (an empty list for none).');
    try {
        approval.lensKeys({ lens: rule.lens });
    } catch (error) {
        return invalid('rule', error.message);
    }
    if (rule.electorate === 'community') {
        if (rule.binding) return invalid('rule', 'A community vote cannot bind the owners.');
        if (rule.approvalConfig != null) return invalid('rule', 'A community vote has no owner approval rule.');
    } else if (rule.approvalConfig != null) {
        // The rights snapshot and the policy are counted by this engine; one it cannot read is refused here.
        try {
            approval.normalizeConfig(rule.approvalConfig);
        } catch (error) {
            if (error?.code !== 'invalid-proposal-approval') throw error;
            return invalid('rule', error.message);
        }
    }

    if (content.deadline != null) {
        if (!isInstant(content.deadline)) return invalid('details', 'The deadline is an ISO instant or null.');
        if (Date.parse(content.deadline) <= now) {
            return { ok: false, status: 422, code: 'deadline-past', section: 'details', error: 'The deadline has already passed.' };
        }
    }
    return {
        ok: true,
        designCids,
        inputParcelIds: [...parcelIds].sort(),
        parcelSourceId: sources.size ? [...sources][0] : null,
        deadline: content.deadline ?? null
    };
}

// The former "declaration equals binding" rule, per agreement: the input parcels are exactly the
// parcels its designs' sites take. A design on ground whose cadastre the server does not hold
// (coverage 'unknown') takes parcels the server cannot see, so with one of those, inputs beyond the
// bound ones are accepted unverified, as a declaration on such ground was before.
function inputsAgainstBindings(inputParcelIds, bindings) {
    const bound = new Set();
    let unverified = false;
    for (const binding of bindings) {
        if (binding?.coverage === COVERAGE.unknown) unverified = true;
        for (const hit of binding?.parcels || []) bound.add(String(hit.parcelId));
    }
    const inputs = new Set(inputParcelIds);
    return {
        missing: [...bound].filter(id => !inputs.has(id)).sort(),
        extra: unverified ? [] : inputParcelIds.filter(id => !bound.has(id))
    };
}

function enqueueAgreementThumbnail(pool, deps, agreement, designs) {
    (deps.thumbnailQueue || defaultThumbnailQueue()).enqueue({
        pool,
        agreement: {
            cid: agreement.cid,
            city: agreement.city,
            designs: designs.map(design => ({ content: design.content })),
            inputParcelIds: agreement.inputParcelIds
        },
        baseUrl: deps.baseUrl ?? publicApiBaseUrl()
    });
}

const send = (res, status, body) => {
    if (body.retryAfterSeconds !== undefined) res.set('Retry-After', String(body.retryAfterSeconds));
    return res.status(status).json(body);
};

/**
 * POST /agreements, GET /agreements/:cid, GET /agreements, and the decision relay under
 * /agreements/:cid/decisions.
 * @param deps { pool, thumbnailQueue?, baseUrl?, pinBytes?, decisionStore?, now?, uploadRateLimiter? }
 *   (routes/content-routes.js)
 */
export function setupAgreementsRoute(app, deps) {
    const { pool } = deps;
    const now = deps.now || (() => Date.now());

    // { cid, content, designs?: [{ cid, content }] } → 201 the row; 409 the row when already indexed.
    app.post('/agreements', async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['cid', 'content', 'designs'].includes(key))) {
            return send(res, 400, { error: 'Body must be { cid, content, designs? }.', code: 'bad-request' });
        }
        const { cid, content } = body;
        if (!isCid(cid)) return send(res, 400, { error: 'cid must be a CIDv1 raw sha2-256 base32 CID (bafkrei…).', code: 'invalid-cid' });
        if (!isPlainObject(content)) return send(res, 400, { error: `content must be an ${AGREEMENT_SCHEMA} object.`, code: 'invalid-agreement' });
        let bytes;
        try { bytes = canonicalBytes(content); } catch (error) {
            return send(res, 400, { error: error.message, code: 'invalid-agreement' });
        }
        if (bytes.length > MAX_PINNED_OBJECT_BYTES) {
            return send(res, 413, { error: `An agreement is at most ${MAX_PINNED_OBJECT_BYTES} bytes; this one is ${bytes.length}.`, code: 'too-large' });
        }
        const computedCid = cidOf(bytes);
        if (computedCid !== cid) return send(res, 400, { error: `The content is ${computedCid}, not ${cid}.`, code: 'cid-mismatch', cid, computedCid });

        try {
            // The same CID is the same content, checked when it was indexed (even if its deadline has passed since).
            const existing = await loadAgreement(pool, cid);
            if (existing) return res.status(409).json(existing);

            const checked = validateAgreementContent(content, { now: now() });
            if (!checked.ok) {
                const { ok: _ok, status, ...refused } = checked;
                return send(res, status, refused);
            }
            const carried = body.designs ?? [];
            if (!Array.isArray(carried) || carried.length > checked.designCids.length
                || carried.some(entry => !isPlainObject(entry) || Object.keys(entry).some(key => !['cid', 'content'].includes(key)))) {
                return send(res, 400, { error: 'designs must be a list of { cid, content } of designs the agreement links.', code: 'bad-request' });
            }
            const stray = carried.find(entry => !checked.designCids.includes(entry.cid));
            if (stray) return send(res, 400, { error: `Design ${stray.cid} is not linked by the agreement.`, code: 'design-not-in-agreement', design: stray.cid });
            if (new Set(carried.map(entry => entry.cid)).size !== carried.length) {
                return send(res, 400, { error: 'A design is sent twice.', code: 'bad-request' });
            }

            // Designs sent along are checked and bound now; they are written with the agreement or not at all.
            const prepared = new Map();
            for (const entry of carried) {
                const outcome = await prepareDesign(pool, entry, { allowLayout: true, parcelSourceId: checked.parcelSourceId });
                if (outcome.refusal) return send(res, outcome.refusal.status, { ...outcome.refusal.body, design: entry.cid });
                if (outcome.prepared) prepared.set(entry.cid, outcome.prepared);
            }
            const indexed = await loadDesigns(pool, checked.designCids.filter(designCid => !prepared.has(designCid)));
            const designs = checked.designCids.map(designCid => prepared.get(designCid) || indexed.get(designCid) || null);
            const missing = checked.designCids.filter((designCid, index) => !designs[index]);
            if (missing.length) {
                return send(res, 422, {
                    error: `The agreement links ${missing.length} design(s) the index does not hold: publish them first, or send them in designs.`,
                    code: 'design-not-indexed', missing
                });
            }
            const land = inputsAgainstBindings(checked.inputParcelIds, designs.map(design => design.binding));
            if (land.missing.length || land.extra.length) {
                const parts = [];
                if (land.missing.length) parts.push(`the designs take ${land.missing.length} parcel(s) the inputs leave out: ${land.missing.join(', ')}`);
                if (land.extra.length) parts.push(`the inputs name ${land.extra.length} parcel(s) no design takes: ${land.extra.join(', ')}`);
                return send(res, 422, {
                    error: `The input parcels must be exactly the parcels the designs take: ${parts.join('; ')}.`,
                    code: 'inputs-differ-from-binding', missing: land.missing, extra: land.extra
                });
            }

            const client = await pool.connect();
            const created = [];
            let row = null;
            try {
                await client.query('BEGIN');
                for (const design of prepared.values()) {
                    if ((await insertDesign(client, design)).created) created.push(design);
                }
                const inserted = await client.query(`
                    INSERT INTO ${AGREEMENT_TABLE} (cid, city, title, author, design_cids, input_parcel_ids, parcel_source_id, deadline, content)
                    VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8::timestamptz, $9::jsonb)
                    ON CONFLICT (cid) DO NOTHING
                    RETURNING ${COLUMNS}`, [
                    cid,
                    // The city of the first design: where its site lies, never the city the content names.
                    designs[0].city ?? null,
                    content.title ?? null,
                    content.author ?? null,
                    checked.designCids,
                    checked.inputParcelIds,
                    checked.parcelSourceId,
                    checked.deadline,
                    JSON.stringify(content)
                ]);
                row = inserted.rows.length ? serializeAgreementRow(inserted.rows[0]) : null;
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
            // Written after the commit, so the thumbnail's update finds the row.
            created.forEach(design => enqueueDesignThumbnail(pool, deps, design));
            if (!row) return res.status(409).json(await loadAgreement(pool, cid));
            enqueueAgreementThumbnail(pool, deps, row, designs);
            log(`indexed ${cid} (${designs.length} design(s), ${created.length} indexed with it; ${checked.inputParcelIds.length} input parcel(s); ${row.city || 'no city'})`);
            return res.status(201).json(row);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in POST /agreements:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Signed owner decisions on an indexed agreement, re-verified before they are stored.
    const decisions = createAgreementDecisionHandlers({
        store: deps.decisionStore || createAgreementDecisionStore(pool),
        loadAgreement: agreementCid => loadAgreement(pool, agreementCid),
        now,
        ...(deps.pinBytes ? { pinBytes: deps.pinBytes } : {})
    });
    app.get('/agreements/:cid/decisions', decisions.get);
    app.post('/agreements/:cid/decisions', decisions.post);
    // Pinning spends the IPFS quota, so it shares the upload routes' per-client limit.
    app.post('/agreements/:cid/decisions/bundle', deps.uploadRateLimiter || createUploadRateLimiter(), decisions.bundle);

    app.get('/agreements/:cid', async (req, res) => {
        const cid = String(req.params.cid || '');
        if (!isCid(cid)) return res.status(400).json({ error: 'Not an agreement CID.', code: 'invalid-cid' });
        try {
            const row = await loadAgreement(pool, cid);
            if (!row) return res.status(404).json({ error: 'Agreement not found', code: 'agreement-not-found' });
            if (req.query.format === 'jsonld') return res.type('application/ld+json').json(agreementDocument(row));
            return res.json(row);
        } catch (error) {
            if (error && (error.code === SEMANTIC_BASE_ERROR || error.code === SEMANTIC_RECORD_ERROR)) {
                return res.status(error.status || 500).json({ error: error.message, code: error.code });
            }
            console.error(`[${new Date().toISOString()}] Error in GET /agreements/${cid}:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ?city=&design=<cid>&parcel=<id>&limit= → { agreements, count }, newest first.
    app.get('/agreements', async (req, res) => {
        const { city: rawCity, design, parcel, limit } = req.query;
        if (rawCity !== undefined && !(typeof rawCity === 'string' && rawCity.length <= MAX_TEXT.city)) {
            return res.status(400).json({ error: `city must be a string of at most ${MAX_TEXT.city} characters.`, code: 'bad-request' });
        }
        if (design !== undefined && !isCid(design)) return res.status(400).json({ error: 'design must be a design CID.', code: 'invalid-cid' });
        if (parcel !== undefined && !isText(parcel, MAX_ID_LENGTH)) {
            return res.status(400).json({ error: 'parcel must be a parcel id.', code: 'bad-request' });
        }
        const clauses = [];
        const params = [];
        const city = normalizeCityCode(rawCity);
        if (city) {
            params.push(city);
            clauses.push(`city = $${params.length}`);
        }
        if (design !== undefined) {
            params.push(design);
            clauses.push(`design_cids @> ARRAY[$${params.length}]::text[]`);
        }
        if (parcel !== undefined) {
            params.push(parcel);
            clauses.push(`input_parcel_ids @> ARRAY[$${params.length}]::text[]`);
        }
        params.push(parseListLimit(limit));
        try {
            const { rows } = await pool.query(`
                SELECT ${COLUMNS} FROM ${AGREEMENT_TABLE}
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                ORDER BY created_at DESC, cid
                LIMIT $${params.length}`, params);
            return res.json({ agreements: rows.map(serializeAgreementRow), count: rows.length });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in GET /agreements:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });
}
