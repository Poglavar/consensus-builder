// The agreement index (plan-design-agreement.md, M2 "Courier and index"). POST /agreements takes an
// agreement/v1 object the browser addressed itself, { cid, content, plan?, designs? }, and indexes it once the
// server has checked what it can: the CID is the content's; the shape is agreement/v1; every design it
// links is indexed (one not yet indexed, such as a parcel layout, which publishes only with its
// agreement, comes along in `designs` and is indexed in the same transaction as the agreement); its
// input parcels are exactly the parcels its designs' sites take on the server (the former
// "declaration equals binding" rule, now per agreement); its rights snapshot is well formed; its
// deadline lies ahead. GET /agreements/:cid and GET /agreements?city&design&parcel&minted read the index
// back with the status from the chain once minted, else from the deadline; owner decisions are relayed at
// /agreements/:cid/decisions (agreements/decisions.js); POST /agreements/:cid/onchain records the chain
// account the agreement is minted as (M3, agreements/onchain.js), which the lifecycle oracle refreshes.

import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { COVERAGE } from '../proposals/binding.js';
import { isPlainObject } from '../utils/request-validation.js';
import { publicApiBaseUrl } from '../utils/public-base-url.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
import { defaultThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { enqueueDesignThumbnail, insertDesign, loadDesigns, parseListLimit, prepareDesign } from './designs.js';
import { validatePlanContent } from './plans.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { agreementDocument, SEMANTIC_BASE_ERROR, SEMANTIC_RECORD_ERROR } from '../semantics/published-records.js';
import { createAgreementDecisionHandlers, createAgreementDecisionStore } from '../agreements/decisions.js';
import { createCommunityReportHandlers, createCommunityReportStore } from '../agreements/community-reports.js';
import { rateLimit } from 'express-rate-limit';
import { createVotingStore } from '../agreements/voting-store.js';
import { setupVotingRoutes } from '../agreements/voting.js';
import {
    AGREEMENT_CLUSTERS, agreementAccountOf, createAgreementChain, isSignature, onchainFromAccount, refreshOnchain, writeOnchain
} from '../agreements/onchain.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const communityDidWeb = require('../../frontend/js/community/did-web.js');
const cityMoney = require('../../frontend/js/city-money.js');

export const AGREEMENT_TABLE = 'consensus.agreement';
export const AGREEMENT_SCHEMA = agreementRecord.PUBLISHED_SCHEMA;
// Designs one agreement may link (and index in one publish): each is a PostGIS binding when new.
export const MAX_AGREEMENT_DESIGNS = 200;
export const PLAN_TABLE = 'consensus.plan';
// An output piece's content hash (AgreementRecord.outputHash): the prefix, then 64 hex digits.
const isOutputHash = value => typeof value === 'string' && value.startsWith(agreementRecord.OUTPUT_HASH_PREFIX)
    && /^[0-9a-f]{64}$/.test(value.slice(agreementRecord.OUTPUT_HASH_PREFIX.length));
const ALLOCATION_KINDS = ['party', 'proposer', 'public'];
const ELECTORATES = ['owners', 'community'];
const MAX_TEXT = { title: 500, author: 255, city: 100 };
const MAX_ID_LENGTH = 256;

// Once minted, executed, cancelled and expired come from the account (`onchain.status`, written by
// POST /agreements/:cid/onchain and refreshed by oracle/agreement-lifecycle.js); otherwise, and while the
// account is active, expired once the deadline has passed, else active.
const STATUS_SQL = `CASE WHEN onchain->>'status' IN ('executed', 'cancelled', 'expired') THEN onchain->>'status'
    WHEN deadline IS NOT NULL AND deadline <= now() THEN 'expired' ELSE 'active' END`;
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
    if (Object.hasOwn(row.content || {}, 'designs') || Object.hasOwn(row.content || {}, 'designCids')) {
        const error = new Error(`Agreement ${row.cid} uses a retired experimental format. Recreate it from a published plan.`);
        error.code = 'retired-agreement-format'; error.status = 410; throw error;
    }
    if (!isCid(row.content?.planCid)) {
        const error = new Error(`Agreement ${row.cid} is an invalid indexed record: expected planCid and no inline design membership.`);
        error.code = 'invalid-agreement-record'; error.status = 500; throw error;
    }
    return {
        cid: row.cid,
        city: row.city ?? null,
        title: row.title ?? null,
        author: row.author ?? null,
        planCid: row.content.planCid,
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
export function validateAgreementContent(content, { now = Date.now(), designCids } = {}) {
    const invalid = (section, error) => ({ ok: false, status: 400, code: 'invalid-agreement', section, error });
    if (!isPlainObject(content) || content.schema !== AGREEMENT_SCHEMA) return invalid('details', `Expected ${AGREEMENT_SCHEMA}.`);
    for (const [field, max] of Object.entries(MAX_TEXT)) {
        if (content[field] != null && !(typeof content[field] === 'string' && content[field].length <= max)) {
            return invalid('details', `${field} is text of at most ${max} characters, or null.`);
        }
    }
    if (content.createdAt != null && !isInstant(content.createdAt)) return invalid('details', 'createdAt is an ISO instant or null.');

    if (!isCid(content.planCid)) return invalid('designs', 'planCid must name a published plan/v1 CID.');
    if (Object.hasOwn(content, 'designs') || Object.hasOwn(content, 'designCids')) return invalid('designs', 'Agreement membership is declared by planCid; inline designs and designCids are not allowed.');
    if (designCids !== undefined && (!Array.isArray(designCids) || !designCids.length)) return invalid('designs', 'The referenced plan links at least one design.');
    if (designCids?.length > MAX_AGREEMENT_DESIGNS) return invalid('designs', `A plan used by an agreement links at most ${MAX_AGREEMENT_DESIGNS} designs.`);

    const { inputs } = content;
    if (!isPlainObject(inputs) || !Array.isArray(inputs.parcels)) return invalid('land', 'The agreement lists its input parcels.');
    const parcelIds = new Set();
    const sources = new Set();
    for (const parcel of inputs.parcels) {
        if (!isPlainObject(parcel) || !isText(parcel.parcelId, MAX_ID_LENGTH)) return invalid('land', 'Every input parcel has an id.');
        if (parcelIds.has(parcel.parcelId)) return invalid('land', `Input parcel ${parcel.parcelId} is listed twice.`);
        parcelIds.add(parcel.parcelId);
        if (parcel.parcelSourceId != null) {
            if (!isText(parcel.parcelSourceId, 3507)) return invalid('land', `Input parcel ${parcel.parcelId} has an invalid parcel source.`);
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
        if (output.producedBy != null && (!isCid(output.producedBy) || (designCids && !designCids.includes(output.producedBy)))) {
            return invalid('land', `Output ${output.hash} is produced by a design the referenced plan does not link.`);
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

    }

    const { money } = content;
    // Cash is counted in the agreement's city's currency (city-money.js: London GBP, Zagreb EUR), as
    // the agreement record checks it; the published object carries the code as an upper-case ISO 4217.
    const currency = isPlainObject(money) ? money.currency : null;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || !cityMoney.isFiat(currency) || !Array.isArray(money.lines)) {
        return invalid('money', 'Money is { currency, lines: [] } with currency the city\'s ISO 4217 code (EUR, GBP, USD…), not a chain token.');
    }
    const payees = new Set();
    for (const line of money.lines) {
        if (!isPlainObject(line) || !isText(line.ownerKey, MAX_ID_LENGTH) || payees.has(line.ownerKey)) {
            return invalid('money', 'Every money line names its own party.');
        }
        payees.add(line.ownerKey);
        if (!Number.isSafeInteger(line.amountCents)) return invalid('money', `The cash of ${line.ownerKey} is not a whole number of cents.`);
    }
    // Land values (settlement by value): whole cents per m², one per input parcel and per output, or null.
    const { valuation } = content;
    if (valuation != null) {
        if (!isPlainObject(valuation) || !Array.isArray(valuation.inputs) || !Array.isArray(valuation.outputs)
            || Object.keys(valuation).some(key => !['inputs', 'outputs'].includes(key))) {
            return invalid('money', 'Valuation is { inputs: [{ parcelId, unitValueCents }], outputs: [{ output, unitValueCents }] } or null.');
        }
        const valued = new Set();
        for (const [rows, key, known] of [[valuation.inputs, 'parcelId', parcelIds], [valuation.outputs, 'output', outputs]]) {
            for (const row of rows) {
                if (!isPlainObject(row) || !isText(row[key], MAX_ID_LENGTH) || !known.has(row[key]) || valued.has(`${key}:${row[key]}`)) {
                    return invalid('money', `Every valuation row names one ${key} of this agreement once.`);
                }
                valued.add(`${key}:${row[key]}`);
                if (!Number.isSafeInteger(row.unitValueCents) || row.unitValueCents < 0) return invalid('money', `The value per m² of ${row[key]} is not a whole number of cents of at least 0.`);
            }
        }
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
        if (content.allocations.length) return invalid('allocation', 'A community consultation has no land allocations.');
        if (money.lines.length) return invalid('money', 'A community consultation has no financial transfers.');
    } else if (rule.approvalConfig != null) {
        // The rights snapshot and the policy are counted by this engine; one it cannot read is refused here.
        try {
            approval.normalizeConfig(rule.approvalConfig);
        } catch (error) {
            if (error?.code !== 'invalid-proposal-approval') throw error;
            return invalid('rule', error.message);
        }
    }

    const consultation = content.consultation;
    if (consultation != null) {
        if (rule.electorate !== 'community') return invalid('consultation', 'Only a community agreement has consultation metadata.');
        if (!isPlainObject(consultation) || Object.keys(consultation).some(key => !['organiser', 'participationUrl', 'voting'].includes(key))
            || !Object.hasOwn(consultation, 'organiser') || !Object.hasOwn(consultation, 'participationUrl')) {
            return invalid('consultation', 'Consultation contains organiser, participationUrl and optional immutable voting codes.');
        }
        try {
            if (consultation.organiser !== null && (!isText(consultation.organiser, 2048)
                || communityDidWeb.normalizeDid(consultation.organiser) !== consultation.organiser)) {
                return invalid('consultation', 'The organiser is a canonical DID Web identifier or null.');
            }
            if (consultation.participationUrl !== null && (!isText(consultation.participationUrl, 2048)
                || agreementRecord.participationUrl(consultation.participationUrl) !== consultation.participationUrl)) {
                return invalid('consultation', 'Participation uses a canonical HTTPS URL or null.');
            }
            if (!canonicalBytes(consultation).equals(canonicalBytes(agreementRecord.consultationOf(consultation, rule.electorate)))) {
                return invalid('consultation', 'Consultation metadata must have its canonical shape.');
            }
        } catch (error) {
            return invalid('consultation', error.message);
        }
    }

    // Browser, MCP and HTTP publication share one area/cash contract. Published outputs carry
    // hashes rather than geometry, so only their local display fields are supplied for calculation.
    if (rule.electorate === 'owners') {
        if (!agreementRecord.settlementValid(rule)) return invalid('rule', 'Set valid compensation terms within the selected scheme limit.');
        if (allocated.size !== outputs.size) return invalid('allocation', 'Choose one recipient for every output parcel.');
        const parties = new Set(inputs.parcels.flatMap(parcel => parcel.holders.map(holder => holder.ownerKey)));
        if (inputs.parcels.some(parcel => !parcel.holders.length || Math.abs(parcel.holders.reduce((sum, holder) => sum + holder.share, 0) - 1) > 1e-8)) return invalid('land', 'Input owners must hold 100% of each parcel; use its abstract owner when names are unavailable.');
        if (content.allocations.some(line => line.to.kind === 'party' && !parties.has(line.to.ownerKey))) return invalid('allocation', 'A recipient must own input land.');
        if (money.lines.some(line => !parties.has(line.ownerKey))) return invalid('money', 'A cash party must own input land.');
        try {
            // The record's own judgement of the terms, the land values, the named scheme's distribution
            // rules and the derived cash (AgreementRecord.settlementIssues), so the index, the dialog
            // and MCP refuse the same agreements for the same reasons.
            const local = { ...content, id: 'publication-check', plan: null, designs: [],
                outputs: content.outputs.map(output => ({ ...output, pieceId: output.hash, holders: [], geometry: null })) };
            if (!agreementRecord.landBalance(agreementRecord.settle(local)).balanced) return invalid('land', 'Input and output land areas must balance.');
            const [issue] = agreementRecord.settlementIssues(local);
            if (issue) return invalid(issue.section, issue.message);
        } catch (error) { return invalid('money', error.message); }
    } else if (!agreementRecord.landBalance({ inputs, outputs: content.outputs }).balanced) return invalid('land', 'Input and output land areas must balance.');

    if (content.deadline != null) {
        if (!isInstant(content.deadline)) return invalid('details', 'The deadline is an ISO instant or null.');
        if (Date.parse(content.deadline) <= now) {
            return { ok: false, status: 422, code: 'deadline-past', section: 'details', error: 'The deadline has already passed.' };
        }
    }
    return {
        ok: true,
        designCids: designCids ?? [],
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
 * POST /agreements, GET /agreements/:cid, GET /agreements, the decision relay under
 * /agreements/:cid/decisions and the chain account at POST /agreements/:cid/onchain.
 * @param deps { pool, thumbnailQueue?, baseUrl?, pinBytes?, decisionStore?, now?, uploadRateLimiter?,
 *   agreementChain?, reportStore?, reportPinBytes? } (routes/content-routes.js); agreementChain(cluster) gives the account reader of a
 *   cluster (agreements/onchain.js createAgreementChain by default)
 */
export function setupAgreementsRoute(app, deps) {
    const { pool } = deps;
    const now = deps.now || (() => Date.now());
    const chains = new Map();
    const agreementChain = deps.agreementChain || (cluster => {
        if (!chains.has(cluster)) chains.set(cluster, createAgreementChain({ cluster }));
        return chains.get(cluster);
    });

    const readPlan = async cid => (await pool.query(`SELECT cid, content FROM ${PLAN_TABLE} WHERE cid = $1`, [cid])).rows[0] || null;
    const checkedPlan = (record, expectedCid) => {
        if (!record || record.cid !== expectedCid || !isPlainObject(record.content)) return null;
        if (validatePlanContent(record.content)) return null;
        const bytes = canonicalBytes(record.content);
        if (cidOf(bytes) !== expectedCid) return null;
        return { cid: expectedCid, content: record.content };
    };

    // { cid, content, plan?: { cid, content }, designs?: [{ cid, content }] } → 201; 409 if already indexed.
    app.post('/agreements', async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['cid', 'content', 'plan', 'designs'].includes(key))) {
            return send(res, 400, { error: 'Body must be { cid, content, plan?, designs? }.', code: 'bad-request' });
        }
        const { cid, content } = body;
        if (!isCid(cid)) return send(res, 400, { error: 'cid must be a CIDv1 UnixFS sha2-256 base32 CID.', code: 'invalid-cid' });
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

            if (!isCid(content.planCid)) return send(res, 400, { error: 'Agreement content must name a plan/v1 with planCid; inline designs are not accepted.', code: 'plan-required' });
            if (Object.hasOwn(content, 'designs') || Object.hasOwn(content, 'designCids')) return send(res, 400, { error: 'Agreement membership is declared by planCid; remove inline designs/designCids.', code: 'inline-designs-forbidden' });

            let carriedPlan = null;
            if (body.plan !== undefined) {
                if (!isPlainObject(body.plan) || Object.keys(body.plan).some(key => !['cid', 'content'].includes(key))
                    || body.plan.cid !== content.planCid || !isPlainObject(body.plan.content)) {
                    return send(res, 400, { error: 'plan must be { cid, content } matching agreement.planCid.', code: 'bad-request' });
                }
                carriedPlan = checkedPlan(body.plan, content.planCid);
                if (!carriedPlan) return send(res, 400, { error: 'The carried plan is invalid or does not hash to its CID.', code: 'invalid-plan' });
            }
            const storedPlanRow = await readPlan(content.planCid);
            const storedPlan = checkedPlan(storedPlanRow, content.planCid);
            if (storedPlanRow && !storedPlan) return send(res, 500, { error: `Indexed plan ${content.planCid} is invalid; it was left unchanged.`, code: 'invalid-plan-record' });
            if (!carriedPlan && !storedPlan) return send(res, 422, { error: `Plan ${content.planCid} is not indexed; send its verified content in plan.`, code: 'plan-not-indexed', planCid: content.planCid });
            if (carriedPlan && storedPlan && cidOf(canonicalBytes(carriedPlan.content)) !== cidOf(canonicalBytes(storedPlan.content))) {
                return send(res, 409, { error: 'The indexed plan content does not match the carried plan.', code: 'plan-content-mismatch' });
            }
            const plan = storedPlan || carriedPlan;
            const planDesignCids = plan.content.designCids;
            const checked = validateAgreementContent(content, { now: now(), designCids: planDesignCids });
            if (!checked.ok) {
                const { ok: _ok, status, ...refused } = checked;
                return send(res, status, refused);
            }
            const carried = body.designs ?? [];
            if (!Array.isArray(carried) || carried.length > planDesignCids.length
                || carried.some(entry => !isPlainObject(entry) || Object.keys(entry).some(key => !['cid', 'content'].includes(key)))) {
                return send(res, 400, { error: 'designs must be a list of { cid, content } of designs the agreement links.', code: 'bad-request' });
            }
            const stray = carried.find(entry => !planDesignCids.includes(entry.cid));
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
            const indexed = await loadDesigns(pool, planDesignCids.filter(designCid => !prepared.has(designCid)));
            const designs = planDesignCids.map(designCid => prepared.get(designCid) || indexed.get(designCid) || null);
            const missing = planDesignCids.filter((designCid, index) => !designs[index]);
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
                if (carriedPlan && !storedPlan) {
                    await client.query(`INSERT INTO ${PLAN_TABLE} (cid, content) VALUES ($1, $2::jsonb) ON CONFLICT (cid) DO NOTHING`,
                        [carriedPlan.cid, JSON.stringify(carriedPlan.content)]);
                }
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
            if (error?.code === 'retired-agreement-format') return res.status(410).json({ error: error.message, code: error.code });
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

    const communityReports = createCommunityReportHandlers({
        store: deps.reportStore || createCommunityReportStore(pool),
        loadAgreement: agreementCid => loadAgreement(pool, agreementCid),
        now,
        ...(deps.reportPinBytes ? { pinBytes: deps.reportPinBytes } : {})
    });
    app.get('/agreements/:cid/community-reports', communityReports.get);
    app.post('/agreements/:cid/community-reports', deps.uploadRateLimiter || createUploadRateLimiter(), communityReports.post);

    setupVotingRoutes(app, {
        store: deps.votingStore || createVotingStore(pool), loadAgreement: cid => loadAgreement(pool, cid), now,
        limiter: rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false,
            message: { code: 'try-later', error: 'Please wait before trying again.', retryAfter: 60 } })
    });

    // The index learns the chain: { chain: 'solana', cluster, account, signature? } after the sponsor
    // minted the agreement, which must be a binding owners' agreement (rule.binding: only those are
    // minted). The account must be the one the agreement's sponsor and CID derive; it is
    // read and decoded, its CID and authority checked, and `onchain` written. Once written only what the
    // chain moves (status, decision, escrow, executedAt, the observation) changes; the signature, a
    // transaction that succeeded and names the account, is kept once it verifies.
    // → 201 the row (first record), 200 the row (refreshed).
    app.post('/agreements/:cid/onchain', async (req, res) => {
        const cid = String(req.params.cid || '');
        if (!isCid(cid)) return send(res, 400, { error: 'Not an agreement CID.', code: 'invalid-cid' });
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['chain', 'cluster', 'account', 'signature'].includes(key))
            || typeof body.account !== 'string') {
            return send(res, 400, { error: 'Body must be { chain, cluster, account, signature? }.', code: 'bad-request' });
        }
        if (body.chain !== 'solana') return send(res, 400, { error: 'chain must be solana.', code: 'unsupported-chain' });
        if (!Object.hasOwn(AGREEMENT_CLUSTERS, body.cluster)) {
            return send(res, 400, { error: `cluster must be one of ${Object.keys(AGREEMENT_CLUSTERS).join(', ')}.`, code: 'unsupported-cluster' });
        }
        // null and absent alike: no transaction reported.
        const signature = body.signature ?? null;
        if (signature !== null && !isSignature(signature)) {
            return send(res, 400, { error: 'signature must be a base58 transaction signature, or null.', code: 'bad-request' });
        }
        try {
            const row = await loadAgreement(pool, cid);
            if (!row) return send(res, 404, { error: 'Agreement not found', code: 'agreement-not-found' });
            // Only a binding owners' agreement is minted: a vote binds nobody, so it has no account.
            if (row.content?.rule?.binding !== true) {
                return send(res, 422, { error: 'Only a binding owners\' agreement is minted; this one does not bind.', code: 'not-binding' });
            }
            const sponsor = row.content?.sponsor ?? null;
            const expected = agreementAccountOf(cid, sponsor);
            if (!expected) {
                return send(res, 422, { error: 'The agreement names no sponsor wallet, so it has no chain account.', code: 'no-sponsor' });
            }
            if (body.account !== expected) {
                return send(res, 400, {
                    error: `The agreement's account is ${expected} (its sponsor and CID), not ${body.account}.`,
                    code: 'onchain-account-mismatch', expected
                });
            }
            if (row.onchain && (row.onchain.cluster !== body.cluster || row.onchain.account !== expected)) {
                return send(res, 409, { error: `The agreement is recorded on ${row.onchain.cluster} as ${row.onchain.account}.`, code: 'onchain-recorded-elsewhere' });
            }

            const chain = agreementChain(body.cluster);
            let read;
            let touch = null;
            try {
                read = await chain.readAccount(expected);
                if (!read.problem && signature !== null && !row.onchain?.signature) {
                    touch = await chain.transactionTouches(signature, expected);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] POST /agreements/${cid}/onchain could not read ${body.cluster}:`, error);
                return send(res, error?.code === 'rpc-wrong-cluster' ? 503 : 502, { error: `The ${body.cluster} RPC could not be read.`, code: 'chain-unavailable' });
            }
            if (read.problem === 'missing') {
                return send(res, 404, { error: `There is no account ${expected} on ${body.cluster} (yet).`, code: 'onchain-account-missing' });
            }
            if (read.problem) {
                return send(res, 409, { error: `Account ${expected} is not an agreement account (${read.problem}).`, code: 'onchain-not-agreement' });
            }
            if (read.account.cid !== cid) {
                return send(res, 409, { error: `Account ${expected} stores CID ${read.account.cid}.`, code: 'onchain-cid-mismatch', storedCid: read.account.cid });
            }
            if (read.account.authority !== sponsor) {
                return send(res, 409, { error: `Account ${expected} belongs to ${read.account.authority}, not the sponsor.`, code: 'onchain-sponsor-mismatch' });
            }
            if (touch === 'not-found') {
                return send(res, 409, { error: `Transaction ${signature} is not visible on ${body.cluster} yet; send it again once confirmed, or leave it out.`, code: 'onchain-signature-not-found' });
            }
            if (touch && touch !== 'ok') {
                return send(res, 400, { error: `Transaction ${signature} ${touch === 'failed' ? 'failed' : 'does not name the agreement account'}.`, code: 'onchain-signature-mismatch' });
            }

            const fresh = onchainFromAccount(read.account, {
                cluster: body.cluster,
                programId: chain.programId,
                observedAt: new Date(now()).toISOString(),
                observedSlot: read.slot,
                signature: touch === 'ok' ? signature : null
            });
            const next = row.onchain
                ? { ...refreshOnchain(row.onchain, fresh), ...(touch === 'ok' ? { signature } : {}) }
                : fresh;
            const wrote = await writeOnchain(pool, cid, next);
            log(`${row.onchain ? 'refreshed' : 'recorded'} ${cid} on ${body.cluster} as ${expected}: ${next.status}, ${next.decision}${wrote ? '' : ' (a later observation was already stored)'}`);
            return res.status(row.onchain ? 200 : 201).json(await loadAgreement(pool, cid));
        } catch (error) {
            if (error?.code === 'retired-agreement-format') return res.status(410).json({ error: error.message, code: error.code });
            console.error(`[${new Date().toISOString()}] Error in POST /agreements/${cid}/onchain:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/agreements/:cid', async (req, res) => {
        const cid = String(req.params.cid || '');
        if (!isCid(cid)) return res.status(400).json({ error: 'Not an agreement CID.', code: 'invalid-cid' });
        try {
            const row = await loadAgreement(pool, cid);
            if (!row) return res.status(404).json({ error: 'Agreement not found', code: 'agreement-not-found' });
            if (req.query.format === 'jsonld') return res.type('application/ld+json').json(agreementDocument(row));
            return res.json(row);
        } catch (error) {
            if (error?.code === 'retired-agreement-format') return res.status(410).json({ error: error.message, code: error.code });
            if (error && (error.code === SEMANTIC_BASE_ERROR || error.code === SEMANTIC_RECORD_ERROR)) {
                return res.status(error.status || 500).json({ error: error.message, code: error.code });
            }
            if (error?.code === 'invalid-agreement-record') return res.status(500).json({ error: error.message, code: error.code });
            console.error(`[${new Date().toISOString()}] Error in GET /agreements/${cid}:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ?city=&plan=<cid>&design=<cid>&parcel=<id>&minted=1&limit=&offset= → { agreements, count, hasMore, nextOffset }, newest first. minted=1 keeps
    // the agreements the index has recorded a chain account for (a non-null `onchain`).
    app.get('/agreements', async (req, res) => {
        const { city: rawCity, plan, design, parcel, minted, limit, offset: rawOffset } = req.query;
        if (rawCity !== undefined && !(typeof rawCity === 'string' && rawCity.length <= MAX_TEXT.city)) {
            return res.status(400).json({ error: `city must be a string of at most ${MAX_TEXT.city} characters.`, code: 'bad-request' });
        }
        if (design !== undefined && !isCid(design)) return res.status(400).json({ error: 'design must be a design CID.', code: 'invalid-cid' });
        if (plan !== undefined && !isCid(plan)) return res.status(400).json({ error: 'plan must be a plan CID.', code: 'invalid-cid' });
        if (parcel !== undefined && !isText(parcel, MAX_ID_LENGTH)) {
            return res.status(400).json({ error: 'parcel must be a parcel id.', code: 'bad-request' });
        }
        if (minted !== undefined && minted !== '1') return res.status(400).json({ error: 'minted must be 1.', code: 'bad-request' });
        if (rawOffset !== undefined && (typeof rawOffset !== 'string' || !/^(0|[1-9]\d*)$/.test(rawOffset)
            || !Number.isSafeInteger(Number(rawOffset)) || Number(rawOffset) > 1000000)) {
            return res.status(400).json({ error: 'offset must be an integer from 0 to 1000000.', code: 'bad-request' });
        }
        const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    // Old inline-membership records stay directly addressable for an explicit Gone response, but
        // they must not poison the current-contract collection response for every caller.
        const clauses = ["content->>'planCid' IS NOT NULL", "NOT (content ? 'designs')", "NOT (content ? 'designCids')"];
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
        if (plan !== undefined) {
            params.push(plan);
            clauses.push(`content->>'planCid' = $${params.length}`);
        }
        if (parcel !== undefined) {
            params.push(parcel);
            clauses.push(`input_parcel_ids @> ARRAY[$${params.length}]::text[]`);
        }
        if (minted === '1') clauses.push('onchain IS NOT NULL');
        const pageLimit = parseListLimit(limit);
        params.push(pageLimit + 1, offset);
        try {
            const { rows } = await pool.query(`
                SELECT ${COLUMNS} FROM ${AGREEMENT_TABLE}
                WHERE ${clauses.join(' AND ')}
                ORDER BY created_at DESC, cid
                LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
            const hasMore = rows.length > pageLimit;
            const agreements = rows.slice(0, pageLimit).map(serializeAgreementRow);
            return res.json({ agreements, count: agreements.length, hasMore, nextOffset: hasMore ? offset + agreements.length : null });
        } catch (error) {
            if (error?.code === 'invalid-agreement-record') return res.status(500).json({ error: error.message, code: error.code });
            console.error(`[${new Date().toISOString()}] Error in GET /agreements:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });
}
